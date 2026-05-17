# PRD: 运行时任务自动检测

## Quality Gates

Required commands to pass:
```bash
bun run build        # Build successfully
bun run typecheck    # No type errors
bun test             # All tests pass
```

## Context

当前 `ralph-tui run` 执行期间，只在任务**完成后**才调用 `refreshTasks()` 检测新任务。如果外部 agent（如 ClaudeCode 在另一个 shell 中）通过 `br create` 在执行期间创建了新任务，ralph-tui 不会发现，导致漏做。

## User Stories

### US-001: 每次迭代前刷新任务列表

作为 ralph-tui 引擎，
我需要在每次循环迭代开始时调用 `refreshTasks()` 刷新任务列表，
以便能够感知外部新建的任务。

**Acceptance Criteria:**
- [ ] `ExecutionEngine.run()` 循环中，`getNextAvailableTask()` 调用前自动执行 `refreshTasks()`
- [ ] 刷新后 `this.state.totalTasks` 正确反映最新数量
- [ ] 新创建的任务在下一个迭代中被 `getNextTask()` 获取到

### US-002: 新增可选的后台轮询机制

作为用户，
我希望能配置 `taskRefreshIntervalMs` 参数（毫秒），
让引擎在后台定期刷新任务列表，
以便在任务执行期间就能检测到新任务，而不是等任务完成后才发现。

**Acceptance Criteria:**
- [ ] `EngineConfig` 新增 `taskRefreshIntervalMs` 字段，默认 0（不轮询）
- [ ] 当值 > 0 时，启动后台定时器，每 N 毫秒调用 `refreshTasks()`
- [ ] 引擎停止时自动清理定时器
- [ ] 轮询刷新后如果发现有新任务，更新 `this.state.totalTasks`
- [ ] 不阻塞当前任务执行

### US-003: TUI 实时显示任务变化

作为 TUI 用户，
我需要任务列表面板能实时反映新增加的任务和任务总数的变化，
以便看到外部新创建的任务。

**Acceptance Criteria:**
- [ ] `tasks:refreshed` 事件触发后，TUI 更新任务列表显示
- [ ] 新任务显示在列表底部，标记为"new"
- [ ] `totalTasks` 数字实时更新
- [ ] 任务完成比例自动调整

### US-004: 添加测试用例

作为开发者，
我需要新增单元测试验证运行时任务检测逻辑，
确保功能正确性不被回归破坏。

**Acceptance Criteria:**
- [ ] 测试 `refreshTasks()` 在每次迭代前被调用
- [ ] 测试外部新任务创建后，`getNextTask()` 能获取到它
- [ ] 测试 `taskRefreshIntervalMs` 后台轮询功能
- [ ] 测试引擎停止时定时器被正确清理
- [ ] `bun test src/engine/index.test.ts` 全部通过