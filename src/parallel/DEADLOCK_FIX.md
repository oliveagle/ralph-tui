# 并行执行死锁问题修复方案

## 根本原因分析

经过深入分析日志和代码，确认了 **3 层 bug 叠加导致完全死锁**：

### Bug 1: Worker AI agent 完成任务但没有 git commit
- Worker AI agent 修改了 `src/main.py`，但 worktree 中没有新 commit
- 原因：AI agent 先调用 `br close` 失败（被依赖阻塞），导致任务状态没有正确流转，auto-commit 代码路径没被触发
- 结果：worker branch 和 session branch 指向同一个 commit

### Bug 2: Merge 总是失败 "for unknown reason"  
- 因为 worker branch 和 session branch 在同一 commit
- `branchHasCommits()` 返回 false，merge 直接跳过

### Bug 3: `br close` 被依赖阻塞
- AI agent 调用 `br close` 但 `br` 拒绝（"blocked by: bead-test-n7d"）
- 工作树里的 beads 数据库和主仓库不同步

## 修复方案

### 1. AI 智能 DeadlockResolver（已实现）

在 `src/parallel/deadlock-resolver.ts` 中：

**新增能力：**
- **自动检测 worktree 中的未提交修改**：`getWorktreeState` 现在会检查 `hasUncommittedChanges` 和 `modifiedFiles`
- **智能 commit 机制**：`commitWorktreeChanges` 会自动 stage 并提交修改
- **AI 决策驱动的解析**：`resolve` 方法会：
  1. 首先检查是否有未提交的修改
  2. 如果有，尝试自动 commit
  3. 如果 commit 成功，继续执行
  4. 如果 commit 失败或没有修改，调用 AI agent 决定下一步
- **确定性回退策略**：当 AI 调用失败时，使用 `deterministicResolution` 做出合理决策而不是直接失败

### 2. Coordinator Agent 增强

Coordinator 现在具备以下 AI 驱动能力：

1. **死锁检测**：`runHealthCheckAndFix` 会：
   - 扫描所有 `in_progress` 任务
   - 检查每个任务的 worktree 状态
   - 发现有未提交修改的 worktree

2. **AI 决策**：对每个死锁任务：
   - 收集完整诊断信息（git 状态、worktree 状态、依赖关系）
   - 调用 AI agent 分析并推荐行动
   - AI 可以选择：继续、合并并关闭、重置为 open、跳过并关闭

3. **自动恢复**：
   - 如果 worktree 有未提交修改，自动 commit
   - 如果依赖阻塞，智能处理（重置依赖任务、跳过等）
   - 保留工作树用于手动恢复（如果需要）

### 3. Worker 模式下的行为修正

Worker 现在不会调用 `tracker.completeTask`，而是：
- 专注于完成代码实现
- 通过 `<promise>COMPLETE</promise>` 信号报告完成
- 让 ParallelExecutor 统一处理合并和任务关闭

### 使用方式

当 `raloop --parallel 5` 运行时：

1. 如果任务卡在 `in_progress` 状态
2. Coordinator 会自动检测并调用 AI agent
3. AI agent 会分析情况并推荐解决方案
4. Coordinator 执行 AI 的决策
5. 执行继续或优雅退出

### AI Agent 决策示例

**场景 1：Worker 有未提交修改**
```
AI 建议：continue
原因：Worktree 有未提交的代码修改，应该 commit 后继续执行
```

**场景 2：Worker 已完成但 merge 失败**
```
AI 建议：merge_and_close
原因：Worktree 已有有效 commit，应该合并并关闭任务
```

**场景 3：依赖阻塞**
```
AI 建议：reset_to_open
原因：依赖任务未完成，应该重置为 open 等待下次调度
```

## 关键改进

1. **完全 AI 驱动**：不是写死逻辑，而是调用 AI agent 做决策
2. **自动恢复**：能够自动 commit 未提交的修改
3. **确定性回退**：AI 失败时有合理的回退策略
4. **状态同步**：正确处理 worktree 和主仓库的状态同步问题
