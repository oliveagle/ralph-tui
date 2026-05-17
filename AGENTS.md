# Agent Instructions

This file provides guidance to AI coding agents when working with code in this repository.

You are an AI assistant. Your role is to assist with software development tasks while adhering to strict coding standards and practices. Here's how you should approach your work:

1. Critical Coding Rules:
   - Prioritize simple, clean, and maintainable solutions over clever or complex ones.
   - Make the smallest reasonable changes to achieve the desired outcome.
   - Never make unrelated code changes; document issues for later instead.
   - Preserve code comments unless you can prove they are actively false.
   - Start all code files with a file-level JSDoc comment section explaining the file's purpose, prefixed with "ABOUTME: ".
   - Avoid temporal context in comments; make them evergreen.

2. Avoiding entropy
   - This codebase will outlive you. Every shortcut you take becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.
   - You are not just writing code. You are shaping the future of this
project. The patterns you establish will be copied. The corners you cut will be cut again.
   - Fight entropy. Leave the codebase better than you found it.

## Build Instructions

This project uses **bun** as its package manager and runtime.

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Type check (no emit)
bun run typecheck

# Lint
bun run lint
bun run lint:fix    # Auto-fix lint issues

# Run in development mode
bun run dev

# Clean build artifacts
bun run clean
```

**After making code changes**, always run:
```bash
bun run typecheck && bun run build
```

## Issue Tracking with beads-rust

This project uses **br** (beads-rust) for issue tracking. Data is stored in `.beads/` directory.

### Quick Reference

```bash
br ready              # Find available work (unblocked issues)
br list               # List all open issues
br list --all         # Include closed issues
br show <id>          # View issue details with dependencies
br show <id> --json   # JSON output for programmatic use
```

### Creating & Managing Issues

```bash
# Create issues
br create "Title" --type task --priority 2 --description "Details"
br create "Epic title" --type epic --priority 1
br create "Child task" --type task --parent <epic-id>

# Update status
br update <id> --status in_progress   # Claim work
br update <id> --status open          # Release work
br update <id> --assignee "email"     # Assign to someone

# Close issues
br close <id>                         # Mark complete
br close <id> --reason "explanation"  # With reason
```

### Dependencies

```bash
br dep add <issue> <depends-on>       # Add dependency (issue depends on depends-on)
br dep remove <issue> <depends-on>    # Remove dependency
br dep list <id>                      # List dependencies
br dep tree <id>                      # Show dependency tree
br dep cycles                         # Detect circular dependencies
```

### Filtering & Search

```bash
br list --status open                 # Filter by status
br list --type task                   # Filter by type (task, bug, feature, epic)
br list --priority 1                  # Filter by priority (0-4, 0=critical)
br list --label backend               # Filter by label
br list --assignee "email"            # Filter by assignee
br ready --type task                  # Ready tasks only (exclude epics)
```

### Syncing with Git

```bash
br sync --flush-only                  # Export DB to JSONL (for commits)
git add .beads/ && git commit         # Commit issue changes
```

### JSON Output

Most commands support `--json` for programmatic access:

```bash
br list --json | jq '.[0]'            # First issue
br ready --json | jq 'length'         # Count of ready issues
br show <id> --json | jq '.dependents'  # Get children of epic
```

### Priority Levels

| Priority | Meaning |
|----------|---------|
| P0 (0) | Critical - Drop everything |
| P1 (1) | High - Do soon |
| P2 (2) | Medium - Normal work |
| P3 (3) | Low - When time permits |
| P4 (4) | Backlog - Someday/maybe |

### Issue Types

- `epic` - Large feature or initiative containing child tasks
- `feature` - New functionality
- `task` - General work item
- `bug` - Defect to fix

### Parent-Child Relationships

When you create a task with `--parent <epic-id>`, a parent-child dependency is created. The epic's `dependents` field lists all children:

```bash
br show <epic-id> --json | jq '.dependents[] | select(.dependency_type == "parent-child")'
```



<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (.beads/beads.jsonl). Instead of parsing JSONL or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). `br` handles creating, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

Before claiming, verify current state with `br show <id> --json` or `br ready --json`. `recommendations` can include graph-important blocked or assigned work; only `quick_ref.top_picks` and non-empty `claim_command` fields represent claimable work.

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

### br Commands for Issue Management

```bash
br ready              # Show issues ready to work (no blockers)
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br create --title="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once
br sync --flush-only  # Export DB to JSONL
```

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find the highest-impact actionable work
2. **Claim**: Use `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `br close <id>`
5. **Sync**: Always run `br sync --flush-only` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: `br dep add <issue> <depends-on>` to add dependencies

### Session Protocol

```bash
git status              # Check what changed
git add <files>         # Stage code changes
br sync --flush-only    # Export beads changes to JSONL
git commit -m "..."     # Commit everything
git push                # Push to remote
```

<!-- end-bv-agent-instructions -->
