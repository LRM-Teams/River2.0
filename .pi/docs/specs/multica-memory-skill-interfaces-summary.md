# Pi Memory/Skill 对接 Multica 接口字段梳理

Last updated: 2026-06-22 UTC

本文基于 `/home/jianghp3/gaia/pi-mono/.pi/docs/specs/memory-governance-share-and-review.md` 和 `/home/jianghp3/gaia/pi-mono` 当前实现整理，聚焦 memory/skill 相关的 Multica 对接字段、目录、JSON schema、API 和工具入口。

## 总览

当前 Multica 对接主要实现集中在 `pi-memory` 包，并同步 vendored 到 `pi-suite/vendor/pi-memory`：

- Spec: `.pi/docs/specs/memory-governance-share-and-review.md`
- Resolver: `.pi/packages/pi-memory/src/paths/resolve-roots.ts`
- Schema: `.pi/packages/pi-memory/src/sync/schemas.ts`
- Connector: `.pi/packages/pi-memory/src/sync/connector.ts`
- Downflow: `.pi/packages/pi-memory/src/sync/downflow.ts`
- Feedback: `.pi/packages/pi-memory/src/sync/feedback.ts`
- Share queue: `.pi/packages/pi-memory/src/sync/queue.ts`
- Pi tool/command 注册: `.pi/packages/pi-memory/index.ts`

核心闭环：Multica 启动 Pi agent 时注入 workspace/agent/env；Pi resolver 把 memory/skill 隔离到当前 agent root；本地 curator 生成 candidate/profile/feedback；`memory_sync_upload` 上传到 Multica；`memory_sync_pull` 拉取当前 agent delivery；回流 memory 只进 `inbox`/`shared-cache`，回流 skill 只进 `inbox/skills`/`skills/generated`，不会覆盖正式 memory，也不会自动启用 skill。

## 环境变量 / Root 字段

| 字段 | 实现状态 | 默认 / 派生逻辑 | 用途 | 代码位置 |
| --- | --- | --- | --- | --- |
| `PI_MEMORY_DIR` | 已实现 | 显式指定优先；否则 `$PI_AGENT_ROOT/memory`、Multica 派生 root、最后 fallback `~/.pi/agent/memory` | 当前 agent 的 memory root，影响 `MEMORY.md`、`USER.md`、`STATE.md`、`REVIEW.md`、daily、audit 等 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:65` |
| `PI_SKILL_DRAFTS_DIR` | 已实现 | 显式指定优先；否则 `$PI_AGENT_ROOT/skills/drafts`；最后 fallback `~/.pi/agent/skill-drafts` | 当前 agent 的 disabled skill draft root | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:72` |
| `PI_AGENT_ROOT` | 已实现 | 显式指定当前 agent 本地根目录 | 一次性派生 memory、skills、inbox、shared-cache、profile、feedback、sync_queue | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:56` |
| `MULTICA_WORKSPACE_ID` | 已实现 | 与 `MULTICA_AGENT_ID` 一起派生 `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>` | Multica workspace 维度隔离；也写入 candidate/feedback/profile 上下文 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:58` |
| `MULTICA_AGENT_ID` | 已实现 | 与 `MULTICA_WORKSPACE_ID` 一起派生 agent root | 当前 Multica agent 维度隔离；pull delivery 也按 agent id 请求 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:59` |
| `MULTICA_WORKSPACES_ROOT` | 已实现 | 默认 `~/multica_workspaces` | 覆盖 Multica workspace 根目录 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:61` |
| `MULTICA_RUN_ID` | 已实现 | unset 时 feedback 可不带 run id | 写入 feedback event 的 `run_id` | `.pi/packages/pi-memory/src/sync/feedback.ts:27` |
| `PI_AGENT_INBOX_DIR` | 已实现 | 默认 `$PI_AGENT_ROOT/inbox` | server downflow 的 inbox 覆盖目录 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:86` |
| `PI_AGENT_SHARED_CACHE_DIR` | 已实现 | 默认 `$PI_AGENT_ROOT/shared-cache` | shared memory cache 覆盖目录；runtime 会从这里轻量注入 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:90` |
| `PI_AGENT_PROFILE_DIR` | 已实现 | 默认 `$PI_AGENT_ROOT/profile` | profile 生成与上传目录 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:94` |
| `PI_AGENT_FEEDBACK_DIR` | 已实现 | 默认 `$PI_AGENT_ROOT/feedback` | feedback queue 目录，写 `feedback.jsonl` | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:98` |
| `PI_AGENT_SYNC_QUEUE_DIR` | 已实现 | 默认 `$PI_AGENT_ROOT/sync_queue` | memory/skill candidate 上传队列目录 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:102` |
| `PI_MEMORY_REMOTE_URL` | 已实现 | unset 时 upload/pull 直接 skip | Multica API base URL | `.pi/packages/pi-memory/src/sync/connector.ts:31` |
| `PI_MEMORY_REMOTE_TOKEN` | 已实现 | unset 时 upload/pull 直接 skip | Bearer token；用于 upload/pull 请求 | `.pi/packages/pi-memory/src/sync/connector.ts:32` |
| `MULTICA_MEMBER_ID` | spec 里有，当前未参与实现 | spec 标注“一期不参与默认隔离路径” | 预留 user-agent 粒度隔离；当前代码 resolver 没有使用 | `.pi/docs/specs/memory-governance-share-and-review.md:154` |
| `PI_MEMORY_REMOTE_PULL` | spec 里有，当前代码未找到实际使用 | spec 写 `off|review` | 预留远端 pull 策略开关；当前 connector 只看 URL/token | `.pi/docs/specs/memory-governance-share-and-review.md:562` |
| `PI_MEMORY_FEEDBACK_DEFAULT_SUCCESS_HOURS` | spec 里有，当前代码未找到实际使用 | spec 写默认 `24` | 预留自动 feedback 推断窗口；当前 feedback 主要显式记录 | `.pi/docs/specs/memory-governance-share-and-review.md:563` |

## 本地目录接口

| 目录 / 文件 | Memory / Skill | 作用 | 初始化 / 写入位置 |
| --- | --- | --- | --- |
| `$PI_AGENT_ROOT/memory/` | memory | 当前 agent 独立 memory root | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:131` |
| `$PI_AGENT_ROOT/memory/MEMORY.md` | memory | 长期事实/决策 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:136` |
| `$PI_AGENT_ROOT/memory/USER.md` | memory | 用户偏好/profile 来源 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:136` |
| `$PI_AGENT_ROOT/memory/STATE.md` | memory | 当前状态、事件、quota、临时记忆 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:136` |
| `$PI_AGENT_ROOT/memory/REVIEW.md` | memory + skill proposal | candidate/proposal 审核队列 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:136` |
| `$PI_AGENT_ROOT/memory/daily/` | memory | daily log | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:134` |
| `$PI_AGENT_ROOT/memory/audit/` | memory governance | curator audit | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:135` |
| `$PI_AGENT_ROOT/skills/drafts/` | skill | 本地审核通过后的 disabled skill draft | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:137` |
| `$PI_AGENT_ROOT/skills/generated/` | skill | Multica 下发的 generated skill；不会自动启用 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:140` |
| `$PI_AGENT_ROOT/skills/enabled/` | skill | 显式 enable 后的 memory-managed skill | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:141` |
| `$PI_AGENT_ROOT/inbox/memory/` | memory downflow | 服务器下发 memory 的 inbox 落盘 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:142` |
| `$PI_AGENT_ROOT/inbox/skills/` | skill downflow | 服务器下发 skill 的 inbox 落盘 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:143` |
| `$PI_AGENT_ROOT/shared-cache/memory/` | memory runtime cache | shared memory 缓存，runtime 会按关键词/标签 top-k 注入 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:144` |
| `$PI_AGENT_ROOT/shared-cache/skills/` | skill cache | 预留 shared skill cache 目录 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:145` |
| `$PI_AGENT_ROOT/profile/` | profile | 生成 user/agent/task/capability profile 并上传 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:146` |
| `$PI_AGENT_ROOT/feedback/feedback.jsonl` | memory + skill feedback | 使用反馈队列 | `.pi/packages/pi-memory/src/paths/resolve-roots.ts:149` |
| `$PI_AGENT_ROOT/sync_queue/memory-candidates.jsonl` | memory upload | memory share candidate 队列 | `.pi/packages/pi-memory/src/sync/queue.ts:28` |
| `$PI_AGENT_ROOT/sync_queue/skill-candidates.jsonl` | skill upload | skill share candidate 队列 | `.pi/packages/pi-memory/src/sync/queue.ts:28` |
| `$PI_AGENT_ROOT/sync_queue/.upload-checkpoint.json` | sync checkpoint | 记录已上传 candidate id 和 feedback line count，避免重复上传 | `.pi/packages/pi-memory/src/sync/connector.ts:37` |

## 远端 API 对接

| 方向 | API / Tool | Payload | 字段 | 行为 |
| --- | --- | --- | --- | --- |
| Pi -> Multica | `POST /api/evolution/submissions` | `{ candidates }` | `EvolutionCandidate[]` | 上传治理后的 memory/skill candidate；不会上传整份 `MEMORY.md` 或整个 skill 目录 |
| Pi -> Multica | `POST /api/agents/:agentId/evolution-profile` | `{ profiles }` | profile 文件名到 markdown 内容的 map | 上传 `user-profile.md`、`agent-profile.md`、`task-profile.md`、`capability-profile.md` |
| Pi -> Multica | `POST /api/evolution/feedback` | `{ feedback }` | `FeedbackEvent[]` | 上传 injected/used/success/failure/conflict 等反馈 |
| Multica -> Pi | `GET /api/agents/:agentId/evolution-deliveries?limit=N` | `{ deliveries }` 或 `Delivery[]` | `Delivery[]` | 拉取当前 agent 的 memory/skill downflow |
| Pi Tool | `memory_sync_upload` | 无参数 | 读本地 queue/profile/feedback | 调 `syncUpload()` 上传；无 URL/token 时跳过 |
| Pi Tool | `memory_sync_pull` | `limit?: number` | 当前 agent id + limit | 调 `syncPull()` 拉 delivery 并落盘 |
| Pi Tool | `memory_feedback` | shared unit feedback 字段 | 写本地 `feedback.jsonl` | 显式记录共享 memory/skill 使用反馈 |

代码对应：

- Upload endpoint: `.pi/packages/pi-memory/src/sync/connector.ts:50`
- Profile endpoint: `.pi/packages/pi-memory/src/sync/connector.ts:51`
- Feedback endpoint: `.pi/packages/pi-memory/src/sync/connector.ts:52`
- Pull endpoint: `.pi/packages/pi-memory/src/sync/connector.ts:69`
- Feedback tool 注册: `.pi/packages/pi-memory/index.ts:2462`
- Upload tool 注册: `.pi/packages/pi-memory/index.ts:2570`
- Pull tool 注册: `.pi/packages/pi-memory/index.ts:2586`

## JSON Schema 字段

| 类型 | 字段 | 取值 / 说明 | 用途 |
| --- | --- | --- | --- |
| `EvolutionCandidate` | `type` | `memory` / `skill` / `workflow` / `tool_pattern` / `preference` | 共享候选类型 |
| `EvolutionCandidate` | `workspace_id` | string | 当前 Multica workspace |
| `EvolutionCandidate` | `agent_id` | string | 来源 agent |
| `EvolutionCandidate` | `local_unit_id` | string | 本地稳定 id；默认 `type_hash` |
| `EvolutionCandidate` | `signature` | string | 去重签名；默认 sha256 |
| `EvolutionCandidate` | `content` | string | 候选正文；local path 会脱敏；secret 会拒绝 |
| `EvolutionCandidate` | `tags` | string[] | 标签，用于匹配/检索 |
| `EvolutionCandidate` | `source` | `local_curator` / `memory_review` / `manual` | candidate 来源 |
| `EvolutionCandidate` | `suggested_scope` | `agent` / `workspace` / `project` / `team` / `global` / `agent_type` | 建议共享范围 |
| `EvolutionCandidate` | `status` | `candidate` / `uploaded` / `rejected` | 本地队列状态 |
| `EvolutionCandidate` | `sensitivity` | `none` / `local_path` / `personal` / `secret` / `unknown` | 敏感级别；`secret` 不入队 |
| `EvolutionCandidate` | `source_candidate_ids` | string[] | 来源 REVIEW candidate/proposal id |
| `EvolutionCandidate` | `created_at` | ISO time | 创建时间 |
| `FeedbackEvent` | `shared_unit_id` | string | 远端 shared unit id |
| `FeedbackEvent` | `unit_type` | `memory` / `skill` | 反馈对象类型 |
| `FeedbackEvent` | `workspace_id` | string | 当前 workspace |
| `FeedbackEvent` | `agent_id` | string | 当前 agent |
| `FeedbackEvent` | `run_id` | string optional | 当前 Multica run，默认从 `MULTICA_RUN_ID` 取 |
| `FeedbackEvent` | `task_type` | string optional | 任务类型 |
| `FeedbackEvent` | `event` | `injected` / `used` / `ignored` / `success` / `failure` / `conflict` | 反馈事件 |
| `FeedbackEvent` | `outcome` | `success` / `failure` / `neutral` optional | 结果 |
| `FeedbackEvent` | `timestamp` | ISO time | 反馈时间 |
| `Delivery` | `id` | string | delivery id |
| `Delivery` | `shared_unit_id` | string | server shared unit id |
| `Delivery` | `unit_type` | `memory` / `skill` | 下发类型 |
| `Delivery` | `content` | string | memory 文本或 `SKILL.md` 内容 |
| `Delivery` | `tags` | string[] optional | 标签，用于本地二次过滤 |
| `Delivery` | `score` | number optional | server 匹配分 |
| `Delivery` | `task_types` | string[] optional | 适用任务类型 |
| `Delivery` | `tools` | string[] optional | 相关工具 |
| `Delivery` | `project_types` | string[] optional | 项目类型 |
| `Delivery` | `required_tools` | string[] optional | skill 所需工具 |
| `Delivery` | `metadata` | object optional | 扩展元数据 |

Schema 定义在 `.pi/packages/pi-memory/src/sync/schemas.ts:4`、`.pi/packages/pi-memory/src/sync/schemas.ts:20`、`.pi/packages/pi-memory/src/sync/schemas.ts:32`。

## Memory / Skill 下发行为

| 下发类型 | 落盘位置 | 是否写正式 memory | 是否自动启用 skill | 代码 |
| --- | --- | --- | --- | --- |
| `unit_type: "memory"` | `$PI_AGENT_ROOT/inbox/memory/<id>.json` | 否 | 不涉及 | `.pi/packages/pi-memory/src/sync/downflow.ts:19` |
| `unit_type: "memory"` | `$PI_AGENT_ROOT/shared-cache/memory/<id>.json` | 否 | 不涉及 | `.pi/packages/pi-memory/src/sync/downflow.ts:22` |
| `unit_type: "skill"` | `$PI_AGENT_ROOT/inbox/skills/<id>/SKILL.md` | 不涉及 | 否 | `.pi/packages/pi-memory/src/sync/downflow.ts:27` |
| `unit_type: "skill"` | `$PI_AGENT_ROOT/skills/generated/<id>/SKILL.md` | 不涉及 | 否，需要显式 enable | `.pi/packages/pi-memory/src/sync/downflow.ts:28` |

补充：runtime 会从 `shared-cache/memory` 和 `skills/generated` 做轻量关键词/标签 top-k 注入，并记录 `injected` feedback，但 generated skill 仍不会自动启用。相关逻辑在 `.pi/packages/pi-memory/index.ts:1082` 和 `.pi/packages/pi-memory/index.ts:1116`。

## Skill 相关接口

| 能力 | 字段 / 目录 | 说明 |
| --- | --- | --- |
| skill draft root | `PI_SKILL_DRAFTS_DIR` / `$PI_AGENT_ROOT/skills/drafts` | 本地审核通过的 disabled draft 存放处 |
| skill candidate upload | `sync_queue/skill-candidates.jsonl` | `EvolutionCandidate.type === "skill"` 时写这里 |
| skill delivery receive | `Delivery.unit_type === "skill"` | 下发内容写 `inbox/skills/<id>/SKILL.md` 和 `skills/generated/<id>/SKILL.md` |
| skill enable | `memory_skill_enable` / `/memory-skill enable` | 从 `draft:<slug>` 或 `generated:<id>` 显式启用 |
| skill disable | `memory_skill_disable` / `/memory-skill disable` | 禁用 enabled skill |
| generated skill safety | 默认不启用 | spec 里也强调 skill 比 memory 更敏感，必须显式流程 |

## 本地多 Agent Curator Manager 字段

| 字段 | 说明 | 代码 |
| --- | --- | --- |
| `workspace_id` | registry 里记录 workspace | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:13` |
| `agent_id` | registry 里记录 agent | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:14` |
| `agent_root` | 当前 agent 本地 root | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:15` |
| `memory_dir` | 当前 root 的 memory dir | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:16` |
| `skill_dir` | 当前 root 的 skills dir | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:17` |
| `dirty_since` | dirty 标记时间 | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:18` |
| `last_curated_at` | 上次治理时间 | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:19` |
| `last_synced_at` | 预留/记录同步时间 | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:20` |
| `status` | `idle` / `dirty` / `running` / `error` | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:21` |
| `last_error` | 最近错误 | `.pi/packages/pi-memory/src/manager/local-curator-manager.ts:22` |

## 本地 memory/skill 开关

这些不是 Multica API 字段，但会影响 memory/skill 本地治理或运行时行为。

| 字段 | 作用 |
| --- | --- |
| `PI_MEMORY_MANAGER_SCHEDULE` | Local Curator Manager 定时扫描建议 schedule |
| `PI_MEMORY_REVIEW_STARTUP_HINT` | 控制启动时 pending review 提醒 |
| `PI_MEMORY_REVIEW_SESSION_SUMMARY` | 控制 session 结束 learning summary |
| `PI_MEMORY_REVIEW_COMPACT_DAYS` | review compact 相关 |
| `PI_MEMORY_SNAPSHOT` | stable/per-turn memory snapshot 注入策略 |
| `PI_MEMORY_QMD_UPDATE` | qmd 更新策略 |
| `PI_MEMORY_NO_SEARCH` | 关闭每轮 memory search 注入 |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | 是否总结 lifecycle transitions |
| `PI_MEMORY_LEARNING` | learning extraction 模式 |
| `PI_MEMORY_LEARNING_MIN_CONFIDENCE` | learning candidate 最低置信度 |
| `PI_MEMORY_SKILL_DRAFTS` | 是否允许 curator 提出 skill draft |
| `PI_MEMORY_AUTO_APPROVE_MEMORY` | 自动批准 memory proposal |
| `PI_MEMORY_AUTO_APPROVE_SKILL_DRAFTS` | 自动创建 disabled skill draft |

## 当前实现与 Spec 的差异/预留

| 项 | 当前状态 | 说明 |
| --- | --- | --- |
| `MULTICA_MEMBER_ID` | 预留，未参与 resolver | 一期按 `workspace_id + agent_id` 隔离；二期可扩展 user-agent 粒度 |
| `PI_MEMORY_REMOTE_PULL` | spec 有，代码未找到实际使用 | 当前 pull 只依赖 `PI_MEMORY_REMOTE_URL` 和 `PI_MEMORY_REMOTE_TOKEN` |
| `PI_MEMORY_FEEDBACK_DEFAULT_SUCCESS_HOURS` | spec 有，代码未找到实际使用 | 自动 success/failure 推断尚未实现；当前主要通过 `memory_feedback` 显式记录 |
| generated skill 自动启用 | 未实现，且有意不做 | 回流 skill 只进 `skills/generated`，需要显式 enable |
| profile-based semantic ranking | 基础版 | 当前 runtime 注入主要是轻量关键词/标签 top-k |
