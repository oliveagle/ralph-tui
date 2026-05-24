# AI Agent 冲突解析原理与调试

## 实现架构

### 1. AI Resolver 接入点

**ConflictResolver（冲突解析）**
- **位置**: `src/parallel/conflict-resolver.ts`
- **触发时机**: Git merge 检测到冲突文件时
- **调用链**: `MergeEngine.executeMerge` → `ConflictResolver.resolveConflicts` → `aiResolver(conflict, taskContext)`
- **AI 实现**: `src/parallel/ai-resolver.ts` 的 `createAiResolver()`
- **原理**: 调用 `getAgentRegistry().getInstance(config.agent)` 获取配置的 agent，然后执行 prompt

**DeadlockResolver（死锁解析）**
- **位置**: `src/parallel/deadlock-resolver.ts`
- **触发时机**: `ParallelExecutor.runHealthCheckAndFix()` 检测到死锁任务时
- **调用链**: `runHealthCheckAndFix` → `deadlockResolver.diagnose(task)` → `deadlockResolver.resolve(diagnostic)`
- **原理**: 同样调用 `getAgentRegistry().getInstance(config.agent)`，传入诊断 prompt，获取 AI 决策

### 2. 工作流程

```
并行执行开始
  ↓
任务图分析 → 分组 → 并行执行
  ↓
Worker 完成 → Merge 尝试
  ↓
Merge 成功? → 是 → 关闭任务 → 完成
  ↓ 否
检测到冲突?
  ↓ 是
ConflictResolver → AI Agent 解析冲突 → 质量门禁 → 合并
  ↓ 否
并行执行循环 → Health Check
  ↓
检测到死锁任务?
  ↓ 是
DeadlockResolver → AI Agent 分析状态 → 决策行动 → 执行
```

### 3. AI Agent Prompt 示例

**Conflict Resolution Prompt**:
```
You are resolving a git merge conflict.

File: src/main.py
Task: Task 2: Add subtract and multiply methods to Calculator

Base Version: (file did not exist)
Main Branch: (only Hello World)
Worker Branch: (has Calculator class with subtract/multiply)

Instructions:
1. COMBINE ALL CONTENT from both branches
2. Preserve worker's functional changes
3. Keep main branch updates where possible
OUTPUT ONLY THE RESOLVED FILE CONTENT.
```

**Deadlock Resolution Prompt**:
```
You are analyzing a deadlocked parallel task execution.

Task Status:
- ID: bead-test-ted
- Title: Task 2: Add subtract and multiply methods
- Stuck for: 15 minutes
- Worktree: Exists, has uncommitted changes (src/main.py)

Recommend ONE action:
1. continue - Worktree has changes, commit and continue
2. merge_and_close - Worktree completed, merge and close
3. reset_to_open - Worktree invalid, reset for retry
4. skip_and_close - Task irrelevant, skip and close
```

## 为什么你没看到它工作？

### 可能原因

1. **没有触发 ConflictResolver**
   - Merge 失败 "for unknown reason" 而不是 "conflict"
   - 原因：worker branch 和 session branch 在同一 commit（没有新 commit）
   - 结果：`branchHasCommits()` 返回 false，直接跳过 merge，没有进入冲突解析流程

2. **DeadlockResolver 没有检测到死锁**
   - `checkTaskHealth` 只检查 `task.dependsOn` 字段
   - 但 beads-rust 的依赖在 **dependencies 表**中，不在 `dependsOn` 字段
   - 结果：任务被认为是健康的，没有进入死锁解析流程

3. **AI Agent 调用失败**
   - `getAgentRegistry().getInstance()` 可能返回 null
   - Agent 执行超时或失败
   - 结果：回退到 `safeReset`，没有 AI 决策

## 如何验证 AI Agent 是否工作？

### 检查日志

```bash
# 查找 AI 调用相关日志
grep "AI deadlock resolution\|Deadlock resolved\|Agent execution" .ralph-tui/parallel-*.log

# 查找 conflict resolution 日志
grep "conflict:detected\|conflict:resolved\|Resolving conflict" .ralph-tui/parallel-*.log
```

### 检查配置

```bash
# 检查 agent 配置
ralph info agent

# 检查 conflict resolution 配置
ralph config get conflictResolution
```

## 修复方案

### 1. 确保 DeadlockResolver 检测到真正的死锁

修复 `checkTaskHealth` 使用 `dependencies` 表而不仅仅是 `dependsOn` 字段。

### 2. 确保 merge 进入冲突解析流程

修复 `MergeEngine.executeMerge` 在 "no commits" 时也能正确处理有未提交修改的情况。

### 3. 添加 AI Agent 调用的可见日志

在 `DeadlockResolver.resolve()` 中添加更详细的日志：
- "Calling AI agent for deadlock analysis..."
- "AI agent recommended: ..."
- "Executing AI decision..."
