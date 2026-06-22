# 本地 Pi 多 Agent Memory/Skill 协同自进化 Spec

Last updated: 2026-06-18 05:53 UTC

## 目标

本 spec 只覆盖本地 Pi 侧开发。Multica 服务器侧数据库、API、Center Curator Daemon、Downflow Matcher 和 Feedback Evaluator 见 `/home/jianghp3/gaia/multica/docs/remote-memory-governance-spec.md`。

目标是在多个 Multica Agent 连接同一个本地 Pi Runtime 时，仍然让每个 Agent 拥有独立的 Memory/Skill 空间，并由本地一个 Curator Manager 统一治理多个 Agent Root：

1. Standalone Pi 保持现有默认目录和体验。
2. Multica-connected Pi 按 `workspace_id + agent_id` 隔离本地 Memory/Skill Root，一期不串记忆。
3. 所有 memory/skill 工具都通过 resolver 读写当前 Agent Root，不再硬编码 `~/.pi/agent/memory` 或 `~/.pi/agent/skill-drafts`。
4. Agent Run 过程中沉淀 daily log、candidate memory、candidate skill、review candidate、tool trace 和 shared unit usage feedback。
5. Run 结束后标记当前 Agent Root dirty，由本地单例 Curator Manager 后台处理。
6. Curator Manager 晋级本地 Memory/Skill，生成 share candidates，更新 profile，维护 sync queue 和 feedback queue。
7. Multica 回流内容只进入 `inbox/`、`shared-cache/` 或 `skills/generated/`，不直接覆盖本地正式 Memory，也不自动启用 Skill。
8. Agent 后续使用回流内容后，写入反馈事件，供 Multica Connector 上传。

一句话：本地 Pi 负责“每个 Agent 独立成长 + 本地治理 + 生成可上传候选 + 接收回流缓存 + 记录使用反馈”，不负责远端团队治理。

## 本地/远端开发边界

### 本地 Pi 开发范围

- Memory/Skill root resolver。
- `PI_MEMORY_DIR`、`PI_SKILL_DRAFTS_DIR`、`PI_AGENT_ROOT` 等环境变量支持。
- memory tools、curator、snapshot/versioning、qmd/search、skill draft 生成和加载逻辑的 scoped root 改造。
- Agent Root 目录初始化。
- 单例 Local Curator Manager：registry、dirty mark、per-root lock、scan、sweep、audit。
- 本地 candidate promotion：`REVIEW.md` -> `MEMORY.md` / `USER.md` / `STATE.md` / `skills/drafts/`。
- share candidate 文件队列：`sync_queue/memory-candidates.jsonl`、`sync_queue/skill-candidates.jsonl`。
- profile 生成：`profile/user-profile.md`、`agent-profile.md`、`task-profile.md`、`capability-profile.md`。
- downflow 接收落盘：`inbox/`、`shared-cache/`、`skills/generated/`。
- feedback 捕获：`feedback/feedback.jsonl`。
- 本地审核提醒：curator 结束、Pi 启动、session 结束时提示 pending review/proposal。

### Multica 开发范围

- Agent Run 启动时注入 workspace/agent/member/run env。
- 创建本地 Agent Root 初始目录。
- Connector upload/download API 对接。
- 服务器保存 Evolution Unit、去重、分类、合并、评分、版本化。
- Profile-based Downflow 和 Feedback Evaluator。
- workspace/project/agent 权限、scope、状态机和审计。

本地 Pi 不实现远端数据库治理；Multica 不直接编辑本地正式 `MEMORY.md`。

## 总体本地架构

```text
Local Pi Runtime
  ├─ Agent Runner
  ├─ Memory Resolver
  ├─ Skill Resolver
  ├─ Local Curator Manager
  ├─ Agent Memory Roots
  ├─ Agent Skill Roots
  ├─ Profile Generator
  ├─ Downflow Inbox / Shared Cache
  ├─ Feedback Queue
  └─ Multica Connector
```

本地数据流：

```text
Agent Run
  -> write daily / review / candidate memory / candidate skill / feedback
  -> mark current agent root dirty
  -> Local Curator Manager scans dirty roots
  -> promote local memory/skill or discard/archive/merge
  -> generate share candidates
  -> update profile
  -> connector uploads candidates + feedback
  -> connector receives downflow
  -> write inbox/shared-cache/generated-skills
  -> next run retrieves matched local + shared context
```

## 目录隔离

### Standalone Pi

Standalone Pi 继续使用现有目录：

```text
~/.pi/agent/memory/
~/.pi/agent/skill-drafts/
```

### Multica-connected Pi

Multica-connected Pi 使用 workspace 下的 Agent 隔离目录。一期按 Agent 隔离；二期如需区分同一 Agent 面对不同用户，再扩展为 `agents/<agent_id>/users/<member_id>/`。

```text
~/multica_workspaces/<workspace_id>/.pi/
  agents/
    <agent_id>/
      memory/
        MEMORY.md
        USER.md
        STATE.md
        REVIEW.md
        SCRATCHPAD.md
        daily/
        audit/
        .curator-state.json

      skills/
        drafts/
        generated/
        enabled/

      inbox/
        memory/
        skills/

      shared-cache/
        memory/
        skills/

      profile/
        user-profile.md
        agent-profile.md
        task-profile.md
        capability-profile.md

      feedback/
        feedback.jsonl

      sync_queue/
        memory-candidates.jsonl
        skill-candidates.jsonl
```

可选二期结构：

```text
~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/users/<member_id>/
```

二期引入 user-agent 粒度时，resolver 规则只需要在 `agent_id` 下多拼一层 `users/<member_id>`，其余 curator/connector/feedback 逻辑保持按 root 工作。

## Resolver 设计

Pi 侧不能硬编码默认 memory 或 skill 路径。所有能力必须走统一 resolver。

Multica Runtime 启动 Agent 时建议注入：

```text
MULTICA_WORKSPACE_ID
MULTICA_AGENT_ID
MULTICA_MEMBER_ID
MULTICA_RUN_ID

PI_AGENT_ROOT
PI_MEMORY_DIR
PI_SKILL_DRAFTS_DIR
PI_AGENT_INBOX_DIR
PI_AGENT_SHARED_CACHE_DIR
PI_AGENT_PROFILE_DIR
PI_AGENT_FEEDBACK_DIR
PI_AGENT_SYNC_QUEUE_DIR
```

默认派生：

```text
PI_AGENT_ROOT=~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>
PI_MEMORY_DIR=$PI_AGENT_ROOT/memory
PI_SKILL_DRAFTS_DIR=$PI_AGENT_ROOT/skills/drafts
PI_AGENT_INBOX_DIR=$PI_AGENT_ROOT/inbox
PI_AGENT_SHARED_CACHE_DIR=$PI_AGENT_ROOT/shared-cache
PI_AGENT_PROFILE_DIR=$PI_AGENT_ROOT/profile
PI_AGENT_FEEDBACK_DIR=$PI_AGENT_ROOT/feedback
PI_AGENT_SYNC_QUEUE_DIR=$PI_AGENT_ROOT/sync_queue
```

Memory resolver 优先级：

1. `PI_MEMORY_DIR`。
2. 如果存在 `MULTICA_WORKSPACE_ID` 和 `MULTICA_AGENT_ID`，使用 `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/memory`。
3. fallback 到 `~/.pi/agent/memory`。

Skill draft resolver 优先级：

1. `PI_SKILL_DRAFTS_DIR`。
2. 如果存在 `MULTICA_WORKSPACE_ID` 和 `MULTICA_AGENT_ID`，使用 `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/skills/drafts`。
3. fallback 到 `~/.pi/agent/skill-drafts`。

必须改造的模块：

- `memory_write`
- `memory_read`
- `memory_edit`
- `memory_search`
- `memory_curate`
- `memory_learning_approve`
- `memory_learning_reject`
- `memory_skill_drafts`
- memory snapshot/versioning
- qmd memory collection/search/embed
- curator CLI 和外部 curator service
- skill draft 生成、读取、批准、加载逻辑
- Pi session start / session end memory review summary

验收目标：同一个本地 Pi Runtime 根据不同 Multica Agent 的环境变量，自动读写不同 Agent 的 Memory/Skill 空间。

## Local Curator Manager

不要每个 Agent 起一个 curator daemon。本地只运行一个 Curator Manager，统一管理多个 Agent Root。

```text
Local Curator Manager
  -> maintain root registry
  -> scan dirty roots
  -> lock per root
  -> run memory/skill curator for that root
  -> generate share candidates
  -> update profiles
  -> mark sync queue
  -> append audit
```

registry 示例：

```json
{
  "roots": [
    {
      "workspace_id": "workspace_1",
      "agent_id": "agent_1",
      "agent_root": "~/multica_workspaces/workspace_1/.pi/agents/agent_1",
      "memory_dir": "~/multica_workspaces/workspace_1/.pi/agents/agent_1/memory",
      "skill_dir": "~/multica_workspaces/workspace_1/.pi/agents/agent_1/skills",
      "dirty_since": "2026-06-17T10:00:00Z",
      "last_curated_at": "2026-06-17T09:00:00Z",
      "last_synced_at": "2026-06-17T09:30:00Z",
      "status": "idle"
    }
  ]
}
```

触发方式：

- Agent run 结束后，如果产生 daily/review/candidate/feedback，标记当前 root dirty。
- Curator Manager 每隔 N 分钟扫描 dirty roots。
- 每天做一次 full sweep。
- 每个 root 使用 `.curator.lock` 加锁。
- 同一 root 串行处理，不同 root 可并发处理。
- idle roots 不需要常驻 per-agent curator。

处理结果：

- 本地晋级：`memory/MEMORY.md`、`memory/USER.md`、`memory/STATE.md`、`skills/drafts/<skill_name>/SKILL.md`。
- 共享候选：`sync_queue/memory-candidates.jsonl`、`sync_queue/skill-candidates.jsonl`。
- 画像更新：`profile/*.md`。
- 审计：`memory/audit/curator.jsonl`。

## Agent Run 自进化流程

每次 Agent Run 过程中产生：

- daily log。
- candidate memory。
- candidate skill。
- review candidate。
- tool usage trace。
- shared unit usage feedback。

Run 结束后：

1. daily 写入 `memory/daily/YYYY-MM-DD.md`。
2. candidate memory/skill 进入 `memory/REVIEW.md` 或 skill review/drafts。
3. feedback 写入 `feedback/feedback.jsonl`。
4. 当前 root 标记 dirty。
5. session 结束摘要提示新增候选、合并数量和 pending proposal。

Curator Manager 后台处理：

```text
REVIEW.md candidate
  -> discard
  -> archive
  -> merge
  -> promote to local MEMORY.md / USER.md / STATE.md
  -> promote to local skill draft
  -> generate share memory candidate
  -> generate share skill candidate
```

## REVIEW 候选与本地晋级

`REVIEW.md` 只保留活跃候选和待审核 proposal，不作为无限增长历史库。

```md
[type:review status:candidate id:rev_xxx kind:memory_candidate confidence:medium seen:2 first_seen:2026-06-17 last_seen:2026-06-17]
Signature: use-lsp-rename-for-cross-file-refactor
Summary: Cross-file symbol rename should use LSP rename instead of text replacement when LSP is available.
Evidence: Successful TypeScript refactor used lsp.rename and diagnostics.
Scope: agent,workspace
Shareability: team_candidate
Sensitivity: none
Applicability: coding/refactor tasks with working LSP server.
```

字段建议：

- `scope`: `agent`, `workspace`, `project`, `team`, `global`。
- `shareability`: `none`, `local_only`, `team_candidate`, `team_ready`。
- `sensitivity`: `none`, `local_path`, `personal`, `secret`, `unknown`。
- `applicability`: 简短场景描述。
- `decision`: `promote_local`, `promote_share`, `reject`, `archive`, `merge`, `propose`。

本地 curator 决策维度：

- 真实性：是否有用户指令、工具输出、文件变更、测试结果、重复证据。
- 重复性：signature、规范化文本、可选 qmd semantic search。
- 适用范围：agent/project/workspace/team/global。
- 共享价值：是否跨任务、跨项目、跨智能体可复用。
- 安全性：是否包含密钥、OTP、API key、个人隐私、本地敏感路径。

## Evolution Unit 与上传队列

本地不上传整份 `MEMORY.md` 或整个 skill 目录，只上传治理后的共享候选单元。

统一抽象：Evolution Unit。

类型：

- `memory`
- `skill`
- `workflow`
- `tool_pattern`
- `preference`

Memory candidate JSONL 示例：

```json
{
  "type": "memory",
  "workspace_id": "workspace_1",
  "agent_id": "agent_1",
  "content": "处理代码修改任务前应先读取项目约束文件和现有测试命令。",
  "tags": ["coding", "workflow", "testing"],
  "source": "local_curator",
  "suggested_scope": "workspace",
  "status": "candidate"
}
```

Skill candidate JSONL 示例：

```json
{
  "type": "skill",
  "workspace_id": "workspace_1",
  "agent_id": "agent_1",
  "name": "multica-issue-triage",
  "content": "# Skill\n...",
  "tags": ["multica", "issue", "triage"],
  "source": "local_curator",
  "suggested_scope": "agent_type",
  "status": "candidate"
}
```

上传前要求：

- `sensitivity` 不能是 `secret`。
- 本地路径、私密用户名、token、OTP、API key 必须脱敏或拒绝。
- candidate 必须带 `workspace_id`、`agent_id`、`source`、`tags`、`status`。
- skill candidate 的正文和附加文件由 connector 打包上传；本地正式 skill 不因上传而自动启用。

## Profile 生成机制

回流不能简单广播，必须基于画像匹配。本地 Curator Manager 维护四类 profile：

```text
profile/
  user-profile.md
  agent-profile.md
  task-profile.md
  capability-profile.md
```

含义：

- `user-profile.md`：用户偏好、表达习惯、长期需求；来源包括 `memory/USER.md` 和已批准偏好。
- `agent-profile.md`：Agent 类型、角色、擅长任务、历史成功任务。
- `task-profile.md`：当前或近期任务类型、关键词、项目上下文。
- `capability-profile.md`：本地工具能力、可用命令、是否有 repo、是否有 Multica CLI、是否有 LSP 等。

profile 用途：

- 上传给 Multica 作为 downflow matching 输入。
- 本地 runtime 从 `shared-cache` 检索时作为二次过滤条件。
- 本地 curator 判断回流内容是否值得保留、拒绝或转为本地 draft。

## 回流接收与本地注入

服务器下发内容不直接覆盖本地正式 Memory/Skill。

回流写入：

```text
agents/<agent_id>/inbox/memory/
agents/<agent_id>/inbox/skills/
agents/<agent_id>/shared-cache/memory/
agents/<agent_id>/shared-cache/skills/
agents/<agent_id>/skills/generated/
```

Memory 回流策略：

```text
server active memory
  -> inbox/memory
  -> shared-cache/memory
  -> runtime 按任务检索注入
```

Skill 回流策略：

```text
server active skill
  -> inbox/skills or skills/generated
  -> 根据 agent/task/tool 能力显式启用
```

重要原则：

- 回流内容不直接写入 `memory/MEMORY.md`。
- 回流 skill 不直接变成永久本地 skill draft。
- 正式晋级仍由本地 curator 或用户批准决定。
- 低分或弱相关内容不注入。
- Skill 比 Memory 更严格：Skill 会改变行为流程，应按 Agent 类型、Task 类型和工具能力匹配后再启用。

Agent Run 开始时，本地 Runtime 组装上下文优先级：

1. 本地 Agent Memory。
2. 本地 User/Profile 信息。
3. 与当前任务匹配的 Shared Memory。
4. 与当前任务匹配的 Shared Skill。
5. Run state。

## 使用反馈

Agent 使用回流 Memory/Skill 后，写入反馈事件：

```json
{
  "shared_unit_id": "unit_123",
  "unit_type": "memory",
  "workspace_id": "workspace_1",
  "agent_id": "agent_1",
  "run_id": "run_1",
  "task_type": "coding",
  "event": "used",
  "outcome": "success",
  "timestamp": "2026-06-17T12:00:00Z"
}
```

反馈类型：

- `injected`
- `used`
- `ignored`
- `success`
- `failure`
- `conflict`

本地职责：

- 捕获 runtime 注入、使用、忽略、成功、失败、冲突事件。
- 追加到 `feedback/feedback.jsonl`。
- Connector 上传成功后记录 offset/checkpoint，避免重复上传。
- 不在本地直接修改服务器 score；score 调整由 Multica Feedback Evaluator 负责。

## 审核提醒与命令

### memory_curate 结束提醒

`memory_curate` 返回值必须包含 pending counts：

```text
Curator completed: 3 patches, 2 memory proposals pending, 1 skill proposal pending.
Next: run /memory-review, or approve with memory_learning_approve id=<proposal-id>, reject with memory_learning_reject id=<proposal-id>.
```

如果没有 pending，提示：

```text
No pending memory/skill proposals.
```

### Pi 启动轻量提醒

Pi session start 时，如果 `REVIEW.md` 中存在 pending proposal，注入一行轻量提醒：

```text
Memory review: 2 memory / 1 skill proposals pending. Run /memory-review.
```

要求：

- 每个 session 最多显示一次。
- 可用 `PI_MEMORY_REVIEW_STARTUP_HINT=0` 关闭。
- 读取失败不阻塞启动。

### /memory-review 命令

```text
/memory-review
/memory-review --type memory
/memory-review --type skill
/memory-review --limit 20
/memory-review approve <id>
/memory-review reject <id> [reason]
/memory-review archive <id> [reason]
/memory-review show <id>
```

最小实现可以先只支持列表，并提示使用现有工具 approve/reject；完整实现再支持 mutation 子命令。skill approval 仍然只生成禁用 draft，不自动启用。

### session 结束候选数

```text
Memory learning today: 4 new candidates, 2 merged duplicates, 2 memory proposals pending, 1 skill proposal pending.
```

统计口径：

- `new candidates`: 本次 session 写入的新 `status:candidate` 数量。
- `merged duplicates`: 本次 session 合并到既有候选的数量。
- `pending`: session 结束后当前 `REVIEW.md` 的 pending proposal 数量。

## 配置项

```text
PI_MEMORY_DIR=                              # 显式 memory root
PI_SKILL_DRAFTS_DIR=                        # 显式 skill draft root
PI_AGENT_ROOT=                              # 当前 Multica agent 本地 root
PI_AGENT_INBOX_DIR=                         # 当前 agent downflow inbox
PI_AGENT_SHARED_CACHE_DIR=                  # 当前 agent shared cache
PI_AGENT_PROFILE_DIR=                       # 当前 agent profile dir
PI_AGENT_FEEDBACK_DIR=                      # 当前 agent feedback dir
PI_AGENT_SYNC_QUEUE_DIR=                    # 当前 agent sync queue dir
MULTICA_WORKSPACE_ID=                       # Multica workspace id
MULTICA_AGENT_ID=                           # Multica agent id
MULTICA_MEMBER_ID=                          # 预留；一期不参与默认隔离路径
MULTICA_RUN_ID=                             # 当前 run id
MULTICA_WORKSPACES_ROOT=~/multica_workspaces
PI_MEMORY_REVIEW_STARTUP_HINT=1
PI_MEMORY_REVIEW_SESSION_SUMMARY=1
PI_MEMORY_REVIEW_COMPACT_DAYS=30
PI_MEMORY_REMOTE_URL=                       # Multica API base URL
PI_MEMORY_REMOTE_TOKEN=                     # Multica connector token
PI_MEMORY_REMOTE_PULL=off|review            # 默认 off
PI_MEMORY_FEEDBACK_DEFAULT_SUCCESS_HOURS=24
```


## 当前实现状态（2026-06-18 05:53 UTC）

本地 Pi 侧已经在 `/home/jianghp3/gaia/pi-mono/.pi/packages/pi-memory` 和 `pi-suite` vendored `pi-memory` 中完成第一轮实现，并通过本地测试。当前能力状态：

已完成：

- Standalone fallback 和 Multica Agent scoped root resolver：`PI_MEMORY_DIR`、`PI_SKILL_DRAFTS_DIR`、`PI_AGENT_ROOT`、`MULTICA_WORKSPACE_ID`、`MULTICA_AGENT_ID`、`MULTICA_WORKSPACES_ROOT`。
- `ensureAgentRoot()` 初始化 `memory/`、`skills/drafts`、`skills/generated`、`skills/enabled`、`inbox/`、`shared-cache/`、`profile/`、`feedback/`、`sync_queue/`。
- memory tools、curator、review proposal、daily/session summary、qmd collection、curator service、skill draft approval/list 使用 resolved root。
- vendored `pi-memory` evolution snapshot/versioning 使用 resolved memory root 和 resolved skill draft root。
- `/memory-review` 支持 list/show/approve/reject/archive/compact，并有 startup hint、`memory_curate` pending counts、session shutdown learning summary。
- Local Curator Manager 基础能力：registry、dirty mark、`scanDirtyRoots()`、per-root `.curator.lock`、CLI/tool 手动扫描。
- share candidate queue：`sync_queue/memory-candidates.jsonl`、`sync_queue/skill-candidates.jsonl`，含 secret/local path sensitivity handling、去重 id。
- profile 生成：`profile/user-profile.md`、`agent-profile.md`、`task-profile.md`、`capability-profile.md`。
- downflow receive：memory 写 `inbox/memory` + `shared-cache/memory`；skill 写 `inbox/skills` + `skills/generated`；不覆盖正式 memory，不启用 skill。
- runtime shared-cache 轻量关键词/标签 top-k 注入，并记录 `injected` feedback。
- feedback queue：`memory_feedback` / `appendFeedbackEvent()` 写 `feedback/feedback.jsonl`。
- Multica connector 本地端：`memory_sync_upload` / `/memory-sync-upload` 上传 candidates/profile/feedback，`memory_sync_pull` / `/memory-sync-pull` 拉当前 Agent deliveries。
- 测试覆盖 resolver、pending review、sync queue、downflow、feedback、compact，并同步到 vendored 包。

已验证：

```bash
npm --prefix .pi/packages/pi-memory test
npm --prefix .pi/packages/pi-suite/vendor/pi-memory test
git diff --check -- .pi/packages/pi-memory .pi/packages/pi-suite
```

后续未完成/待产品化：

- Local Curator Manager 还没有独立常驻 systemd/cron 单例服务；当前是工具/CLI/外部调度触发。
- 本地治理决策还不是完整显式 policy engine；当前是现有 lifecycle/proposal + share candidate helper 的保守规则组合。
- `REVIEW.md compact` 是最小实现；没有 `REVIEW_ARCHIVE.md`，audit 仅摘要级。
- session shutdown summary 未精确统计本 session 的 merged duplicate 数。
- feedback 的 `used/success/failure/ignored/conflict` 主要由工具显式记录，尚未基于任务结果自动推断。
- runtime shared-cache 匹配是关键词/标签轻量 top-k，尚未接入完整 profile-based semantic ranking、failure_cases 和工具能力过滤。
- connector API 按 spec 约定实现，尚未与真实 Multica 服务端做 integration test。
- 回流/generated skill 默认不启用；尚未实现 generated skill sandbox 测试、binding 或显式 enable 流程。
- scoped qmd collection 已按 root hash 隔离，但没有已有 collection 迁移/清理工具。
- `.pi/packages/pi-memory` 包当前缺少 `tsconfig.json`，`npm run build` 仍不可用；以 `tsx --test` 测试作为验证。

## MVP 阶段

### Phase 0：Agent Memory/Skill 路径隔离（已完成）

目标：不同 Multica Agent 不串记忆。

交付：

- Multica Runtime 注入 `PI_MEMORY_DIR` / `PI_SKILL_DRAFTS_DIR`。
- 每个 Agent 有独立本地 root。
- Standalone Pi 行为不变。

验收：

- Agent A 写入的 memory 不出现在 Agent B。
- Agent A 的 skill draft 不出现在 Agent B。
- Standalone Pi 仍写 `~/.pi/agent/memory` 和 `~/.pi/agent/skill-drafts`。

### Phase 1：Resolver 全链路改造（已完成）

目标：所有 memory/skill 功能都走 resolver。

交付：

- memory tools 支持 scoped root。
- curator CLI 支持 scoped root。
- qmd/search 支持 scoped root。
- snapshot/versioning 支持 scoped root。
- skill draft 支持 scoped root。

验收：

- `memory_write`、`memory_read`、`memory_curate` 都只操作当前 Agent root。
- skill draft 写入当前 Agent skill root。

### Phase 2：Local Curator Manager（部分完成，待常驻服务）

目标：一个本地 manager 管多个 Agent root。

交付：

- root registry。
- dirty 标记。
- root lock。
- 定时扫描和 daily sweep。
- per-root curator。
- per-root audit。

验收：

- 10 个 Agent 只启动一个 curator manager。
- dirty root 会被处理。
- 同一 root 不会并发写坏。

### Phase 3：Share Candidate 生成与上传准备（已完成本地端，待服务端联调）

目标：本地晋级内容可以形成可上传 candidate。

交付：

- Memory candidate schema。
- Skill candidate schema。
- `sync_queue/`。
- connector upload adapter。

验收：

- 本地 curator 可生成 share candidate。
- candidate 带 workspace/agent/source/tags/status。
- sensitive/secret 内容不会进入 queue。

### Phase 4：Profile 与 Downflow 本地接收（已完成基础版，待 semantic/profile ranking 增强）

目标：本地支持 profile-based downflow 的输入和落盘。

交付：

- profile 生成。
- connector pull deliveries。
- `inbox/`、`shared-cache/`、`skills/generated/` 写入。
- runtime 注入前二次过滤。

验收：

- 不同 Agent 有不同 profile。
- 回流内容不覆盖本地正式 memory。
- 弱相关 shared unit 不注入。

### Phase 5：Feedback Loop 本地端（已完成显式记录与上传 checkpoint，待自动效果推断）

目标：Agent 使用效果可上传给 server。

交付：

- feedback event schema。
- local feedback capture。
- feedback upload checkpoint。

验收：

- success/failure/ignored/conflict 能写入 `feedback.jsonl`。
- connector 可上传并避免重复。

## 一期 MVP 建议范围

一期最小闭环只做：

- Agent 级 Memory/Skill root 隔离。
- `PI_MEMORY_DIR` / `PI_SKILL_DRAFTS_DIR` resolver。
- 一个 Local Curator Manager 管多个 root。
- 本地 memory candidate 上传 server。
- Server active memory 回流到 `shared-cache`。
- Agent 使用后上传 success/failure/ignored feedback。

一期暂缓：

- 自动 skill 启用。
- 复杂 embedding 聚类。
- 跨 workspace 共享。
- user-agent 粒度隔离。
- 自动把回流内容晋级到本地正式 memory。
- skill 自动测试和沙箱验证。

## 非目标

- 本地 Pi 不实现 Multica 服务器数据库治理。
- 不上传完整 `MEMORY.md`、`USER.md`、raw transcript 或 secrets。
- 不自动启用回流 skill。
- 不把所有 session 过程信息都变成长记忆。
- 不在 Pi core 中硬编码该流程；优先在 `@jhp/pi-memory` / `@lebronj/pi-suite` 等 package 中实现。
- 不把 Multica Agent 的长期 memory 默认放进 per-run `workdir`。
- 不用语义模型静默删除正式 `MEMORY.md` 内容。

## 总体验收标准

1. 未设置 Multica env 时，本地 Pi 继续使用现有 `~/.pi/agent/memory` 和 `~/.pi/agent/skill-drafts`。
2. 设置 `PI_MEMORY_DIR` 或 Multica env 时，memory tools、daily log、review proposal、audit、curator service、snapshot/versioning 都使用 resolved memory root。
3. 设置 `PI_SKILL_DRAFTS_DIR` 或 Multica env 时，skill draft 生成/读取/批准都使用 resolved skill root。
4. Agent A 写入的 memory/skill 不出现在 Agent B。
5. `REVIEW.md` 不再作为无限增长的活跃队列；已处理项可 compact 到 audit/archive。
6. `memory_curate` 返回 pending memory/skill 数量和下一步命令。
7. Pi 启动和 session 结束可提示 pending proposal 和今日新增候选数。
8. Local Curator Manager 单例可处理多个 dirty roots，并用 per-root lock 防并发写坏。
9. 本地 curator 能把 agent/project 经验晋级到本地正式记忆或画像。
10. 本地 curator 能生成 memory/skill share candidates 到 `sync_queue/`。
11. 回流 memory 只进入 `inbox/` 或 `shared-cache/`，回流 skill 只进入 `inbox/skills` 或 `skills/generated/`。
12. 使用反馈写入 `feedback/feedback.jsonl`，可被 Multica Connector 上传。
13. 敏感信息不会进入 `sync_queue/`、`shared-cache/`、`skills/generated/` 或远端上传 payload。


## 后续迭代 Backlog（2026-06-18 后）

1. 给 Local Curator Manager 增加真正的单例后台服务：systemd/cron 安装、每 N 分钟 dirty scan、daily full sweep、状态查询和失败重试。
2. 抽象完整 Governance Decision Engine：统一输出 `discard`、`archive`、`merge`、`promote_local_memory`、`promote_local_skill`、`promote_share_candidate`、`needs_review`，并写详细 audit。
3. 完善 `REVIEW.md` compact：逐条 audit、可选 `REVIEW_ARCHIVE.md`、敏感 evidence 脱敏归档、幂等测试。
4. 精确 session summary 统计：new candidate、merged duplicate、pending proposal 均按本 session 口径统计。
5. 自动 feedback 推断：任务成功/失败、用户负反馈、conflict、工具缺失触发对应 feedback event。
6. 强化 shared-cache runtime 注入：profile-based semantic ranking、score threshold、failure_cases、required_tools、project/language/framework filter。
7. 与 Multica 服务端 API 做 integration test，确认 upload/pull payload、checkpoint、幂等和认证错误处理。
8. 补齐 shared skill 生命周期：generated skill sandbox 测试、显式 approve/binding/enable 流程、使用反馈。
9. 增加 qmd scoped collection 迁移和清理命令。
10. 给 `.pi/packages/pi-memory` 增加或修复 `tsconfig.json`，恢复 `npm run build` 验证。
