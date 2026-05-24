// ABOUTME: Raloop auto-restart daemon for ralph-tui.
// Monitors and restarts ralph-tui process on crash or completion.
// Provides process-level auto-loop capability that survives crashes.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Config holds the raloop daemon configuration.
type Config struct {
	CWD          string
	Headless     bool
	Parallel     int
	PollInterval time.Duration
	RestartDelay time.Duration
	StuckTimeout time.Duration
	MaxRetries   int
	LogPath      string
	Verbose      bool
	PIDPath      string
}

func main() {
	cfg := parseArgs(os.Args[1:])
	if cfg == nil {
		return
	}

	if err := runDaemon(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "raloop: %v\n", err)
		os.Exit(1)
	}
}

func parseArgs(args []string) *Config {
	cfg := &Config{
		CWD:          mustGetCWD(),
		Headless:     true,
		Parallel:     0,
		PollInterval: 5 * time.Second,
		RestartDelay: 5 * time.Second,
		StuckTimeout: 30 * time.Second,
		MaxRetries:   0,
		PIDPath:      "",
	}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--cwd":
			i++
			if i < len(args) {
				cfg.CWD = args[i]
			}
		case "--headless", "--no-tui":
			cfg.Headless = true
		case "--tui":
			cfg.Headless = false
		case "--parallel":
			i++
			if i < len(args) {
				if n, err := strconv.Atoi(args[i]); err == nil && n > 0 {
					cfg.Parallel = n
				}
			}
		case "--poll-interval":
			i++
			if i < len(args) {
				if secs, err := strconv.Atoi(args[i]); err == nil && secs > 0 {
					cfg.PollInterval = time.Duration(secs) * time.Second
				}
			}
		case "--restart-delay":
			i++
			if i < len(args) {
				if secs, err := strconv.Atoi(args[i]); err == nil && secs > 0 {
					cfg.RestartDelay = time.Duration(secs) * time.Second
				}
			}
		case "--stuck-timeout":
			i++
			if i < len(args) {
				if secs, err := strconv.Atoi(args[i]); err == nil && secs > 0 {
					cfg.StuckTimeout = time.Duration(secs) * time.Second
				}
			}
		case "--max-retries":
			i++
			if i < len(args) {
				if n, err := strconv.Atoi(args[i]); err == nil && n >= 0 {
					cfg.MaxRetries = n
				}
			}
		case "--log":
			i++
			if i < len(args) {
				cfg.LogPath = args[i]
			}
		case "--verbose", "-v":
			cfg.Verbose = true
		case "--pid":
			i++
			if i < len(args) {
				cfg.PIDPath = args[i]
			}
		case "--help", "-h":
			printHelp()
			return nil
		default:
			if strings.HasPrefix(args[i], "-") {
				fmt.Fprintf(os.Stderr, "Unknown option: %s\n", args[i])
				fmt.Fprintln(os.Stderr, `Run "ralph-tui raloop --help" for usage information.`)
				os.Exit(1)
			}
		}
	}

	if cfg.PIDPath == "" {
		cfg.PIDPath = filepath.Join(cfg.CWD, ".ralph-tui", "raloop.pid")
	}

	return cfg
}

func printHelp() {
	fmt.Println(`
Raloop - Auto-restart loop daemon for Ralph TUI

USAGE:
  ralph-tui raloop [options]

OPTIONS:
  --cwd <path>              Working directory (default: .)
  --headless, --no-tui       Run in headless mode (default: headless)
  --parallel <n>            Enable parallel execution with N workers
  --poll-interval <seconds> Task polling interval (default: 5)
  --restart-delay <seconds> Crash restart delay (default: 5)
  --stuck-timeout <seconds>  Timeout for stuck processes (default: 30)
  --max-retries <n>         Max restart attempts (default: unlimited)
  --log <path>              Log file path (append mode)
  --verbose, -v             Show ralph-tui output in real-time
  --pid <path>              PID file path (default: .ralph-tui/raloop.pid)
  --help, -h                Show this help message

EXAMPLES:
  raloop_go --parallel 5              # Parallel with 5 workers, headless
  raloop_go --parallel 5 --verbose     # Show ralph-tui output
  raloop_go --stuck-timeout 60        # Wait 60s before killing stuck process
`)
}

func mustGetCWD() string {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "raloop: cannot get working directory: %v\n", err)
		os.Exit(1)
	}
	return cwd
}

func runDaemon(cfg *Config) error {
	existing, err := checkPIDFile(cfg.PIDPath)
	if err != nil {
		return fmt.Errorf("checking PID file: %w", err)
	}
	if existing > 0 {
		fmt.Printf("Raloop daemon already running (PID: %d)\n", existing)
		fmt.Printf("To stop it, run: kill %d\n", existing)
		return nil
	}

	pid, err := writePIDFile(cfg.PIDPath)
	if err != nil {
		return fmt.Errorf("writing PID file: %w", err)
	}
	_ = pid
	defer removePIDFile(cfg.PIDPath)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)

	log(cfg, "Raloop daemon started", "success")
	log(cfg, "Working directory: %s", "info", cfg.CWD)
	log(cfg, "Mode: %s", "info", func() string {
		if cfg.Headless {
			return "headless"
		}
		return "TUI"
	}())
	if cfg.Parallel > 0 {
		log(cfg, "Parallel workers: %d", "info", cfg.Parallel)
	}
	log(cfg, "Poll interval: %v", "info", cfg.PollInterval)
	log(cfg, "Stuck timeout: %v", "info", cfg.StuckTimeout)
	maxMsg := "unlimited"
	if cfg.MaxRetries > 0 {
		maxMsg = strconv.Itoa(cfg.MaxRetries)
	}
	log(cfg, "Max retries: %s", "info", maxMsg)

	var child *exec.Cmd
	var childMu sync.Mutex
	restartCount := 0
	noTasksCycles := 0
	const maxNoTasksCycles = 12

	go func() {
		for sig := range sigCh {
			if sig == syscall.SIGHUP {
				childMu.Lock()
				if child != nil && child.Process != nil {
					child.Process.Signal(syscall.SIGTERM)
				}
				childMu.Unlock()
			} else {
				childMu.Lock()
				if child != nil && child.Process != nil {
					child.Process.Signal(syscall.SIGTERM)
					done := make(chan struct{})
					go func() {
						child.Wait()
						close(done)
					}()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						child.Process.Kill()
					}
				}
				childMu.Unlock()
				log(cfg, "Daemon stopping... (received %v)", "info", sig)
				os.Exit(0)
			}
		}
	}()

	for {
		hasTasks, err := checkOpenTasks(cfg.CWD)
		if err != nil {
			log(cfg, "Error checking tasks: %v", "warn", err)
			time.Sleep(cfg.PollInterval)
			continue
		}

		if !hasTasks {
			noTasksCycles++
			if noTasksCycles >= maxNoTasksCycles {
				log(cfg, "No tasks for 60s, exiting...", "info")
				return nil
			}
			log(cfg, "No tasks found, waiting... (%d/%d)", "warn", noTasksCycles, maxNoTasksCycles)
			time.Sleep(cfg.PollInterval)
			continue
		}

		noTasksCycles = 0
		log(cfg, "Tasks found, starting ralph-tui...", "success")

		// Find ralph-tui binary
		ralphPath, err := findRalphBinary(cfg.CWD)
		if err != nil {
			log(cfg, "Ralph-tui not found: %v", "error", err)
			time.Sleep(cfg.RestartDelay)
			continue
		}

		args := []string{"run", "--cwd", cfg.CWD, "--force"}
		if cfg.Headless {
			args = append(args, "--headless")
		}
		if cfg.Parallel > 0 {
			args = append(args, "--parallel", strconv.Itoa(cfg.Parallel))
		}

		childMu.Lock()
		child = exec.Command(ralphPath, args...)
		child.Dir = cfg.CWD
		child.Stdin = os.Stdin

		if cfg.Verbose {
			child.Stdout = os.Stdout
			child.Stderr = os.Stderr
		} else if cfg.LogPath != "" {
			logFile, err := os.OpenFile(cfg.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
			if err == nil {
				child.Stdout = logFile
				child.Stderr = logFile
				defer logFile.Close()
			}
		}

		if err := child.Start(); err != nil {
			childMu.Unlock()
			log(cfg, "Failed to start ralph-tui: %v", "error", err)
			time.Sleep(cfg.RestartDelay)
			continue
		}

		log(cfg, "Ralph-tui started (PID: %d)", "info", child.Process.Pid)

		pm := NewProgressMonitor(filepath.Join(cfg.CWD, ".ralph-tui", "progress.md"))
		stuckCh := make(chan struct{}, 1)
		stopMonitor := make(chan struct{})

		go func() {
			for {
				select {
				case <-stopMonitor:
					return
				case <-time.After(time.Second):
					if pm.Check() >= cfg.StuckTimeout {
						select {
						case stuckCh <- struct{}{}:
						default:
						}
						return
					}
				}
			}
		}()

		childMu.Unlock()

		var waitDone = make(chan error, 1)
		go func() {
			waitDone <- child.Wait()
		}()

		var waitErr error
		select {
		case <-stuckCh:
			childMu.Lock()
			if child != nil && child.Process != nil {
				child.Process.Kill()
				log(cfg, "Ralph-tui killed due to stuck progress (>%v)", "error", cfg.StuckTimeout)
			}
			childMu.Unlock()
			waitErr = <-waitDone
		case waitErr = <-waitDone:
		}

		close(stopMonitor)

		childMu.Lock()
		child = nil
		childMu.Unlock()

		var exitCode int
		if waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}

		// Reset stuck tasks
		if exitCode != 0 {
			resetStuckTasks(cfg.CWD)
		}

		if exitCode == 0 {
			log(cfg, "Ralph-tui completed normally", "success")
			hasMore, _ := checkOpenTasks(cfg.CWD)
			if hasMore {
				restartCount++
				log(cfg, "More tasks found, restarting...", "info")
				time.Sleep(time.Second)
				continue
			}
			log(cfg, "All tasks completed, waiting for new tasks...", "info")
			time.Sleep(cfg.PollInterval)
			continue
		}

		log(cfg, "Ralph-tui crashed (exit code: %d)", "error", exitCode)

		restartCount++
		if cfg.MaxRetries > 0 && restartCount > cfg.MaxRetries {
			log(cfg, "Maximum restart attempts (%d) exceeded", "error", cfg.MaxRetries)
			return fmt.Errorf("max retries exceeded")
		}

		maxMsg := "unlimited"
		if cfg.MaxRetries > 0 {
			maxMsg = strconv.Itoa(cfg.MaxRetries)
		}
		log(cfg, "Restarting in %v... (attempt %d/%s)", "info", cfg.RestartDelay, restartCount, maxMsg)
		time.Sleep(cfg.RestartDelay)
	}
}

// findRalphBinary finds the ralph-tui binary.
func findRalphBinary(cwd string) (string, error) {
	// First, try to find bun (required for running ralph-tui)
	bunPath, err := exec.LookPath("bun")
	if err != nil {
		return "", fmt.Errorf("bun not found in PATH")
	}

	// Try ralph-tui in PATH
	ralphPath, err := exec.LookPath("ralph-tui")
	if err == nil {
		// Check if it's a symlink or executable file
		if info, err := os.Stat(ralphPath); err == nil && (info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
			return ralphPath, nil
		}
	}

	// Check if src/cli.tsx exists in cwd (for development mode)
	cliPath := filepath.Join(cwd, "src", "cli.tsx")
	if _, err := os.Stat(cliPath); err == nil {
		return bunPath, nil
	}

	// Check if ralph-tui is in ~/.bun/bin
	homeDir, _ := os.UserHomeDir()
	binPath := filepath.Join(homeDir, ".bun", "bin", "ralph-tui")
	if _, err := os.Stat(binPath); err == nil {
		return binPath, nil
	}

	return "", fmt.Errorf("ralph-tui not found in PATH or ~/.bun/bin")
}

// ProgressMonitor tracks file changes to detect stuck processes.
type ProgressMonitor struct {
	progressPath string
	lastMod      time.Time
	mu           sync.Mutex
}

func NewProgressMonitor(progressPath string) *ProgressMonitor {
	pm := &ProgressMonitor{progressPath: progressPath}
	if info, err := os.Stat(progressPath); err == nil {
		pm.lastMod = info.ModTime()
	}
	return pm
}

func (pm *ProgressMonitor) Check() time.Duration {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if info, err := os.Stat(pm.progressPath); err == nil {
		if info.ModTime().After(pm.lastMod) {
			pm.lastMod = info.ModTime()
			return 0
		}
		return time.Since(pm.lastMod)
	}
	return 0
}

func checkOpenTasks(cwd string) (bool, error) {
	brPath, err := exec.LookPath("br")
	if err == nil {
		cmd := exec.Command(brPath, "ready", "--json")
		cmd.Dir = cwd
		output, err := cmd.CombinedOutput()
		if err == nil && !strings.Contains(strings.ToLower(string(output)), "no issues") &&
			strings.TrimSpace(string(output)) != "" {
			return true, nil
		}
	}

	beadsPath := filepath.Join(cwd, ".beads", "issues.jsonl")
	data, err := os.ReadFile(beadsPath)
	if err != nil {
		return false, nil
	}

	var issues []struct {
		Status string `json:"status"`
		State  string `json:"state"`
	}
	if err := json.Unmarshal(data, &issues); err != nil {
		return false, nil
	}

	for _, issue := range issues {
		status := issue.Status
		if status == "" {
			status = issue.State
		}
		if status == "open" || status == "in_progress" {
			return true, nil
		}
	}

	return false, nil
}

func resetStuckTasks(cwd string) {
	brPath, err := exec.LookPath("br")
	if err != nil {
		return
	}

	beadsPath := filepath.Join(cwd, ".beads", "issues.jsonl")
	data, err := os.ReadFile(beadsPath)
	if err != nil {
		return
	}

	type Task struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}

	var tasks []Task
	if err := json.Unmarshal(data, &tasks); err != nil {
		return
	}

	count := 0
	for _, task := range tasks {
		if task.Status == "in_progress" {
			cmd := exec.Command(brPath, "update", task.ID, "--status", "open")
			cmd.Dir = cwd
			if cmd.Run() == nil {
				count++
			}
		}
	}

	if count > 0 {
		fmt.Printf("[WARN] Reset %d stuck tasks to open status\n", count)
	}
}

func checkPIDFile(pidPath string) (int, error) {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, nil
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		return 0, nil
	}

	err = proc.Signal(syscall.Signal(0))
	if err != nil {
		return 0, nil
	}

	return pid, nil
}

func writePIDFile(pidPath string) (int, error) {
	dir := filepath.Dir(pidPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return 0, err
	}

	pid := os.Getpid()
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0644); err != nil {
		return 0, err
	}

	return pid, nil
}

func removePIDFile(pidPath string) {
	os.Remove(pidPath)
}

func log(cfg *Config, format, level string, args ...interface{}) {
	timestamp := time.Now().Format("2006-01-02 15:04:05")
	msg := fmt.Sprintf(format, args...)

	colors := map[string]string{
		"info":    "\033[36m",
		"warn":    "\033[33m",
		"error":   "\033[31m",
		"success": "\033[32m",
		"reset":   "\033[0m",
	}

	color := colors[level]
	reset := colors["reset"]
	logLine := fmt.Sprintf("[%s] [%s] %s", timestamp, strings.ToUpper(level), msg)

	fmt.Printf("%s%s%s\n", color, logLine, reset)

	if cfg.LogPath != "" {
		plainLine := fmt.Sprintf("[%s] [%s] %s\n", timestamp, strings.ToUpper(level), msg)
		os.MkdirAll(filepath.Dir(cfg.LogPath), 0755)
		if f, err := os.OpenFile(cfg.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			f.WriteString(plainLine)
			f.Close()
		}
	}
}