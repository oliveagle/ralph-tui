/**
 * ABOUTME: Tests for the ExecutionEngine, focusing on prompt preview generation.
 * Verifies that prompt preview works for tasks in all statuses including completed.
 *
 * These tests avoid mock.module() to prevent interfering with other test files.
 * The tracker is injected directly, and filesystem functions gracefully handle
 * non-existent paths by returning empty strings.
 */

import { describe, test, expect } from 'bun:test';
import { AgentRegistry } from '../plugins/agents/registry.js';
import type { AgentPlugin } from '../plugins/agents/types.js';
import type { TrackerPlugin, TrackerTask, TaskFilter } from '../plugins/trackers/types.js';
import type { RalphConfig } from '../config/types.js';
import { ExecutionEngine } from './index.js';

/**
 * Creates a minimal mock tracker for testing.
 * Uses Partial<TrackerPlugin> with type assertion since we only need
 * the methods that generatePromptPreview actually uses.
 */
function createMockTracker(tasks: TrackerTask[]): TrackerPlugin {
  const mockTracker: Partial<TrackerPlugin> = {
    meta: {
      id: 'mock',
      name: 'Mock Tracker',
      description: 'Mock tracker for testing',
      version: '1.0.0',
      supportsBidirectionalSync: false,
      supportsHierarchy: false,
      supportsDependencies: false,
    },
    getTasks: async (options?: TaskFilter) => {
      if (!options?.status) return tasks;
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      return tasks.filter((t) => statuses.includes(t.status));
    },
    // Provide a simple Handlebars template that includes task ID and title
    getTemplate: () => `Task: {{taskId}} - {{taskTitle}}`,
    getPrdContext: async () => null,
  };
  return mockTracker as TrackerPlugin;
}

/**
 * Creates a mock task with specified properties
 */
function createMockTask(overrides: Partial<TrackerTask> = {}): TrackerTask {
  return {
    id: 'test-001',
    title: 'Test Task',
    status: 'open',
    priority: 2,
    ...overrides,
  };
}

/**
 * Creates a minimal RalphConfig for testing.
 * Uses /tmp paths that don't exist to ensure filesystem functions
 * gracefully return empty strings.
 */
function createMockConfig(): RalphConfig {
  return {
    cwd: '/tmp/ralph-test-nonexistent',
    model: 'test-model',
    agent: { name: 'test', plugin: 'claude', options: {} },
    tracker: { name: 'test', plugin: 'json', options: {} },
    maxIterations: 10,
    iterationDelay: 1000,
    taskRefreshIntervalMs: 0,
    outputDir: '/tmp/ralph-test-nonexistent/output',
    progressFile: '/tmp/ralph-test-nonexistent/progress.md',
    showTui: false,
    errorHandling: {
      strategy: 'skip',
      maxRetries: 3,
      retryDelayMs: 5000,
      continueOnNonZeroExit: false,
    },
  };
}

function createMockAgent(): AgentPlugin {
  return {
    meta: {
      id: 'engine-test-agent',
      name: 'Engine Test Agent',
      description: 'Agent used by ExecutionEngine tests',
      version: '1.0.0',
      defaultCommand: 'engine-test-agent',
      supportsStreaming: false,
      supportsInterrupt: false,
      supportsFileContext: false,
      supportsSubagentTracing: false,
    },
    initialize: async () => undefined,
    isReady: async () => true,
    detect: async () => ({ available: true, version: '1.0.0' }),
    getSandboxRequirements: () => ({
      authPaths: [],
      binaryPaths: [],
      runtimePaths: [],
      requiresNetwork: false,
    }),
    execute: () => ({
      executionId: 'engine-test-execution',
      promise: Promise.resolve({
        executionId: 'engine-test-execution',
        status: 'completed',
        stdout: '',
        stderr: '',
        durationMs: 0,
        interrupted: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      interrupt: () => undefined,
      isRunning: () => false,
    }),
    interrupt: () => false,
    interruptAll: () => undefined,
    getCurrentExecution: () => undefined,
    getSetupQuestions: () => [],
    validateSetup: async () => null,
    validateModel: () => null,
    listModels: () => [],
    preflight: async () => ({ success: true }),
    dispose: async () => undefined,
  };
}

describe('ExecutionEngine', () => {
  describe('initialize', () => {
    test('uses an injected tracker in normal mode', async () => {
      const registry = AgentRegistry.getInstance();
      if (!registry.hasPlugin('engine-test-agent')) {
        registry.registerBuiltin(createMockAgent);
      }

      const config = createMockConfig();
      config.agent = { name: 'engine-test-agent', plugin: 'engine-test-agent', options: {} };
      config.tracker = { name: 'unused', plugin: 'missing-tracker', options: {} };

      let syncCalls = 0;
      const getTasksFilters: TaskFilter[] = [];
      const injectedTracker = {
        ...createMockTracker([createMockTask({ id: 'task-1' })]),
        sync: async () => {
          syncCalls++;
          return {
            success: true,
            message: 'Synced',
            syncedAt: new Date().toISOString(),
          };
        },
        getTasks: async (filter?: TaskFilter) => {
          if (filter) {
            getTasksFilters.push(filter);
          }
          return [createMockTask({ id: 'task-1' })];
        },
      } as TrackerPlugin;

      const engine = new ExecutionEngine(config);

      await engine.initialize(undefined, { tracker: injectedTracker });

      expect(syncCalls).toBe(1);
      expect(getTasksFilters).toEqual([{ status: ['open', 'in_progress'] }]);
      expect(engine.getState().totalTasks).toBe(1);
    });
  });

  describe('generatePromptPreview', () => {
    test('returns prompt for open tasks', async () => {
      const openTask = createMockTask({ id: 'task-open', status: 'open', title: 'Open Task' });
      const mockTracker = createMockTracker([openTask]);

      const engine = new ExecutionEngine(createMockConfig());

      // Inject mock tracker directly
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-open');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-open');
        expect(result.prompt).toContain('Open Task');
      }
    });

    test('returns prompt for in_progress tasks', async () => {
      const inProgressTask = createMockTask({
        id: 'task-progress',
        status: 'in_progress',
        title: 'In Progress Task',
      });
      const mockTracker = createMockTracker([inProgressTask]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-progress');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-progress');
        expect(result.prompt).toContain('In Progress Task');
      }
    });

    test('returns prompt for completed tasks', async () => {
      // This is the key test case - completed tasks should work
      const completedTask = createMockTask({
        id: 'task-done',
        status: 'completed',
        title: 'Completed Task',
      });
      const mockTracker = createMockTracker([completedTask]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-done');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-done');
        expect(result.prompt).toContain('Completed Task');
      }
    });

    test('returns error for non-existent task', async () => {
      const mockTracker = createMockTracker([]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Task not found');
        expect(result.error).toContain('nonexistent');
      }
    });

    test('returns error when no tracker configured', async () => {
      const engine = new ExecutionEngine(createMockConfig());

      // Don't set a tracker - it should be null/undefined

      const result = await engine.generatePromptPreview('any-task');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('No tracker configured');
      }
    });

    test('can generate preview for mixed status tasks', async () => {
      // Verify that the filter includes all three statuses
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Open' }),
        createMockTask({ id: 'task-2', status: 'in_progress', title: 'In Progress' }),
        createMockTask({ id: 'task-3', status: 'completed', title: 'Completed' }),
      ];
      const mockTracker = createMockTracker(tasks);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      // All three should work
      const result1 = await engine.generatePromptPreview('task-1');
      const result2 = await engine.generatePromptPreview('task-2');
      const result3 = await engine.generatePromptPreview('task-3');

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);
    });
  });

  describe('getSubagentDetails', () => {
    test('returns undefined for non-existent subagent', () => {
      const engine = new ExecutionEngine(createMockConfig());
      const result = engine.getSubagentDetails('non-existent-id');
      expect(result).toBeUndefined();
    });

    test('returns undefined when no subagents have been tracked', () => {
      const engine = new ExecutionEngine(createMockConfig());
      // No subagents tracked yet
      const result = engine.getSubagentDetails('any-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getSubagentOutput', () => {
    test('returns undefined for non-existent subagent', () => {
      const engine = new ExecutionEngine(createMockConfig());
      const result = engine.getSubagentOutput('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getActiveSubagentId', () => {
    test('returns undefined when no subagents are active', () => {
      const engine = new ExecutionEngine(createMockConfig());
      const result = engine.getActiveSubagentId();
      expect(result).toBeUndefined();
    });
  });

  describe('getSubagentTree', () => {
    test('returns empty array when no subagents', () => {
      const engine = new ExecutionEngine(createMockConfig());
      const result = engine.getSubagentTree();
      expect(result).toEqual([]);
    });
  });

  describe('filteredTaskIds config', () => {
    test('accepts filteredTaskIds in config', () => {
      const config = createMockConfig();
      config.filteredTaskIds = ['task-1', 'task-2'];

      const engine = new ExecutionEngine(config);

      // Engine should be created successfully with filteredTaskIds
      expect(engine).toBeInstanceOf(ExecutionEngine);
    });

    test('accepts empty filteredTaskIds array', () => {
      const config = createMockConfig();
      config.filteredTaskIds = [];

      const engine = new ExecutionEngine(config);

      expect(engine).toBeInstanceOf(ExecutionEngine);
    });

    test('accepts undefined filteredTaskIds', () => {
      const config = createMockConfig();
      config.filteredTaskIds = undefined;

      const engine = new ExecutionEngine(config);

      expect(engine).toBeInstanceOf(ExecutionEngine);
    });

    test('getNextAvailableTask skips disallowed tasks and finds allowed one', async () => {
      // Create tasks where the first one is NOT in the allowed list
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' }),
        createMockTask({ id: 'task-2', status: 'open', title: 'Task 2' }),
        createMockTask({ id: 'task-3', status: 'open', title: 'Task 3' }),
      ];

      // Mock tracker that returns tasks in order, respecting excludeIds
      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        // Simulate getNextTask that respects excludeIds - returns first non-excluded task
        getNextTask: async (options?: { excludeIds?: string[] }) => {
          const excluded = new Set(options?.excludeIds ?? []);
          return tasks.find((t) => !excluded.has(t.id)) ?? undefined;
        },
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      // Only allow task-2 and task-3 (NOT task-1)
      // So task-1 should be skipped and task-2 should be returned
      const config = createMockConfig();
      config.filteredTaskIds = ['task-2', 'task-3'];

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      // Access private method via type casting
      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const result = await getNextTask();

      // task-1 should be skipped (not in filteredTaskIds), task-2 should be returned
      expect(result).not.toBeNull();
      expect(result?.id).toBe('task-2');
    });

    test('getNextAvailableTask returns null when no allowed tasks exist', async () => {
      // Create tasks where NONE are in the allowed list
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' }),
        createMockTask({ id: 'task-2', status: 'open', title: 'Task 2' }),
      ];

      // Mock tracker that returns tasks in order, respecting excludeIds
      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async (options?: { excludeIds?: string[] }) => {
          const excluded = new Set(options?.excludeIds ?? []);
          return tasks.find((t) => !excluded.has(t.id)) ?? undefined;
        },
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      // Only allow task-99 (which doesn't exist)
      const config = createMockConfig();
      config.filteredTaskIds = ['task-99'];

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const result = await getNextTask();

      // No tasks match filteredTaskIds, so null should be returned
      expect(result).toBeNull();
    });

    test('getNextAvailableTask returns task when in filteredTaskIds', async () => {
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' }),
        createMockTask({ id: 'task-2', status: 'open', title: 'Task 2' }),
      ];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async () => tasks[0], // Returns task-1
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      // Allow task-1 (which is the one returned by getNextTask)
      const config = createMockConfig();
      config.filteredTaskIds = ['task-1', 'task-2'];

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const result = await getNextTask();

      // task-1 should be returned since it's in filteredTaskIds
      expect(result).not.toBeNull();
      expect(result?.id).toBe('task-1');
    });

    test('getNextAvailableTask returns null when filteredTaskIds is empty array', async () => {
      const tasks = [createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' })];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async () => tasks[0],
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      // Empty filteredTaskIds means no tasks are allowed (explicit empty list)
      const config = createMockConfig();
      config.filteredTaskIds = [];

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const result = await getNextTask();

      // Empty filteredTaskIds should return null (no tasks allowed)
      expect(result).toBeNull();
    });

    test('getNextAvailableTask returns task when filteredTaskIds is undefined', async () => {
      const tasks = [createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' })];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async () => tasks[0],
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      // No filteredTaskIds set
      const config = createMockConfig();

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const result = await getNextTask();

      expect(result).not.toBeNull();
      expect(result?.id).toBe('task-1');
    });
  });

  describe('refreshTasks', () => {
    test('emits tasks:refreshed event with fresh tasks', async () => {
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' }),
        createMockTask({ id: 'task-2', status: 'in_progress', title: 'Task 2' }),
      ];
      const mockTracker = createMockTracker(tasks);
      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const events: Array<{ type: string; tasks?: TrackerTask[] }> = [];
      engine.on((event) => {
        if (event.type === 'tasks:refreshed') {
          events.push({ type: event.type, tasks: event.tasks });
        }
      });

      await engine.refreshTasks();

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('tasks:refreshed');
      expect(events[0]!.tasks).toHaveLength(2);
      expect(events[0]!.tasks![0]!.id).toBe('task-1');
    });

    test('updates totalTasks count with open/in_progress only', async () => {
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open' }),
        createMockTask({ id: 'task-2', status: 'in_progress' }),
        createMockTask({ id: 'task-3', status: 'completed' }),
      ];
      const mockTracker = createMockTracker(tasks);
      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      await engine.refreshTasks();

      const state = engine.getState();
      expect(state.totalTasks).toBe(2);
    });

    test('emits totalTasks in tasks:refreshed event', async () => {
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open' }),
        createMockTask({ id: 'task-2', status: 'in_progress' }),
        createMockTask({ id: 'task-3', status: 'completed' }),
        createMockTask({ id: 'task-4', status: 'open' }),
      ];
      const mockTracker = createMockTracker(tasks);
      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const events: Array<{ type: string; totalTasks?: number }> = [];
      engine.on((event) => events.push(event as any));

      await engine.refreshTasks();

      const refreshEvent = events.find((e) => e.type === 'tasks:refreshed');
      expect(refreshEvent).toBeDefined();
      expect(refreshEvent!.totalTasks).toBe(3);
    });

    test('is a no-op when no tracker', async () => {
      const engine = new ExecutionEngine(createMockConfig());
      // Ensure tracker is null (default state before initialize)

      const events: Array<{ type: string }> = [];
      engine.on((event) => events.push({ type: event.type }));

      // Should not throw
      await engine.refreshTasks();

      // Should not emit any events
      const refreshEvents = events.filter((e) => e.type === 'tasks:refreshed');
      expect(refreshEvents).toHaveLength(0);
    });
  });

  describe('new task detection', () => {
    test('getNextAvailableTask picks up externally created tasks after refreshTasks', async () => {
      // Track tasks dynamically to simulate external creation
      let tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Initial Task' }),
      ];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        // Simulate getNextTask that respects excludeIds
        getNextTask: async (options?: { excludeIds?: string[] }) => {
          const excluded = new Set(options?.excludeIds ?? []);
          return tasks.find((t) => !excluded.has(t.id) && t.status === 'open') ?? undefined;
        },
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      // Step 1: Initially, task-1 is available
      const initialTask = await getNextTask();
      expect(initialTask).not.toBeNull();
      expect(initialTask?.id).toBe('task-1');

      // Step 2: Simulate completing task-1
      tasks = [
        createMockTask({ id: 'task-1', status: 'completed', title: 'Initial Task' }),
      ];

      // Step 3: Simulate external task creation (e.g., user creates task-2 while engine is paused)
      // Refresh the task list to pick up the new task
      await engine.refreshTasks();

      // Step 4: Verify task-2 can be picked up (simulate new task availability)
      tasks = [
        createMockTask({ id: 'task-2', status: 'open', title: 'Newly Created Task' }),
      ];

      // Step 5: Call refreshTasks again to pick up the new task
      await engine.refreshTasks();

      // Step 6: getNextAvailableTask should now return the new task
      const newTask = await getNextTask();
      expect(newTask).not.toBeNull();
      expect(newTask?.id).toBe('task-2');
    });

    test('getNextAvailableTask returns null when no tasks available', async () => {
      const tasks: TrackerTask[] = [];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async () => undefined,
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      const task = await getNextTask();
      expect(task).toBeNull();
    });
  });

  describe('runLoop flow', () => {
    test('refreshTasks before getNextAvailableTask: new task becomes available after refresh', async () => {
      // Verifies that refreshTasks() updates the tracker state, then getNextAvailableTask()
      // can pick up tasks that were added after the initial setup.
      // This matches the runLoop pattern: await this.refreshTasks(); → getNextAvailableTask()
      const tasks = [createMockTask({ id: 'task-1', status: 'open', title: 'Task 1' })];

      const mockTracker: Partial<TrackerPlugin> = {
        meta: {
          id: 'mock',
          name: 'Mock Tracker',
          description: 'Mock tracker for testing',
          version: '1.0.0',
          supportsBidirectionalSync: false,
          supportsHierarchy: false,
          supportsDependencies: false,
        },
        getTasks: async () => tasks,
        getNextTask: async (options?: { excludeIds?: string[] }) => {
          const excluded = new Set(options?.excludeIds ?? []);
          return tasks.find((t) => !excluded.has(t.id) && t.status === 'open') ?? undefined;
        },
        getTemplate: () => `Task: {{taskId}}`,
        getPrdContext: async () => null,
      };

      const engine = new ExecutionEngine(createMockConfig());
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker as TrackerPlugin;

      const getNextTask = (engine as unknown as { getNextAvailableTask: () => Promise<TrackerTask | null> })
        .getNextAvailableTask.bind(engine);

      // Step 1: refreshTasks + getNextAvailableTask picks up initial task
      await engine.refreshTasks();
      const initialTask = await getNextTask();
      expect(initialTask?.id).toBe('task-1');

      // Step 2: simulate external task creation (task-2 added)
      tasks.push(createMockTask({ id: 'task-2', status: 'open', title: 'Task 2' }));

      // Step 3: complete task-1 (exclude it via completed task)
      tasks[0] = createMockTask({ id: 'task-1', status: 'completed', title: 'Task 1' });

      // Step 4: refreshTasks + getNextAvailableTask picks up task-2
      await engine.refreshTasks();
      const newTask = await getNextTask();
      expect(newTask?.id).toBe('task-2');
    });
  });

  describe('background task polling', () => {
    test('timer starts when taskRefreshIntervalMs > 0', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = 1000;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      // Verify timer starts
      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      // Check that timer field is set
      const timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).not.toBeNull();
      expect(typeof timer).toBe('object');

      // Clean up
      (engine as unknown as { stopTaskRefreshTimer: () => void }).stopTaskRefreshTimer();
    });

    test('timer does not start when taskRefreshIntervalMs is 0', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = 0;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      const timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).toBeNull();
    });

    test('timer does not start when taskRefreshIntervalMs is negative', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = -100;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      const timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).toBeNull();
    });

    test('stopTaskRefreshTimer clears the timer', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = 1000;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      // Start timer
      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      // Verify timer exists
      let timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).not.toBeNull();

      // Stop timer
      (engine as unknown as { stopTaskRefreshTimer: () => void }).stopTaskRefreshTimer();

      // Verify timer is cleared
      timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).toBeNull();
    });

    test('stop() cleans up the background refresh timer', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = 1000;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      // Start timer
      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      // Verify timer exists
      let timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).not.toBeNull();

      // Call stop() which should clean up the timer
      await engine.stop();

      // Verify timer is cleared
      timer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(timer).toBeNull();
    });

    test('starting a new timer clears any existing timer', async () => {
      const config = createMockConfig();
      config.taskRefreshIntervalMs = 1000;

      const engine = new ExecutionEngine(config);
      (engine as unknown as { tracker: TrackerPlugin }).tracker = createMockTracker([]);

      // Start timer first time
      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      const firstTimer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(firstTimer).not.toBeNull();

      // Start timer again - should clear the first timer
      (engine as unknown as { startTaskRefreshTimer: () => void }).startTaskRefreshTimer();

      const secondTimer = (engine as unknown as { taskRefreshTimer: NodeJS.Timeout | null }).taskRefreshTimer;
      expect(secondTimer).not.toBeNull();

      // The second timer should be different from the first (meaning the first was cleared)
      expect(secondTimer).not.toBe(firstTimer);

      // Clean up
      (engine as unknown as { stopTaskRefreshTimer: () => void }).stopTaskRefreshTimer();
    });
  });
});
