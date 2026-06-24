# Pi Memory/Skill 本地形态与 Multica 同步流程

Last updated: 2026-06-23 05:38 UTC

本文说明当前 `/home/jianghp3/gaia/pi-mono` 中 Pi memory/skill 的本地文件形态、Multica agent 连接 Pi 后的本地目录、会话如何沉淀为 memory/skill、哪些 skill 上传到 Multica、回流如何落盘，以及使用后如何反馈。

## 1. 文件形式

### Memory 本地正式文件

Memory 是文本/结构化条目，正式文件位于当前 agent 的 `memory/` 目录：

```text
memory/
  MEMORY.md       # 长期事实、决策、偏好
  USER.md         # 用户画像、稳定偏好
  STATE.md        # 有日期、TTL、事件、额度的当前状态
  REVIEW.md       # 候选、proposal、待审核项
  SCRATCHPAD.md   # checklist
  daily/YYYY-MM-DD.md
  audit/*.jsonl
```

### Memory 上传候选

Memory 共享候选位于：

```text
sync_queue/
  memory-candidates.jsonl
```

每一行是一个 governance 后的 Evolution Candidate，例如：

```json
{
  "type": "memory",
  "workspace_id": "xxx",
  "agent_id": "yyy",
  "content": "Prefer LSP rename for cross-file refactors.",
  "tags": ["coding", "lsp"],
  "suggested_scope": "workspace",
  "status": "candidate"
}
```

### Skill 本地正式/可用形式

Skill 是可运行目录 bundle，不只是单个 `SKILL.md`：

```text
skills/drafts/<slug>/
  SKILL.md
  scripts/...
  templates/...
  references/...

skills/generated/<delivery-id>/
  SKILL.md
  scripts/...

skills/enabled/<skill-name>/
  SKILL.md
  scripts/...
  .pi-skill-enabled.json
```

含义：

- `skills/drafts/`：本地 review approve 后生成的禁用 skill draft。
- `skills/generated/`：Multica server 回流的 generated skill，默认禁用。
- `skills/enabled/`：当前 agent 显式启用的 skill，会注入 prompt。

### Skill 上传候选

Skill 共享候选有两层：

```text
sync_queue/
  skill-candidates.jsonl
  skill-candidates/<local_unit_id>/
    SKILL.md
    scripts/...
    templates/...
    candidate.json
```

`skill-candidates.jsonl` 是队列/manifest，不是 skill 本体；真正可运行 skill 在 `sync_queue/skill-candidates/<local_unit_id>/`。

JSONL 里也会带 Multica 可接收的 bundle 字段：

```json
{
  "type": "skill",
  "name": "bundle-demo",
  "content": "---\nname: bundle-demo\n...\n---\n# Bundle Demo\n",
  "files": [
    { "path": "scripts/run.sh", "content": "echo bundle\n" }
  ],
  "provider": "pi",
  "content_hash": "sha256:...",
  "bundle_path": "skill-candidates/skill_xxx"
}
```

这里：

- `content` = `SKILL.md` 正文。
- `files` = 除 `SKILL.md` 外的 supporting files。
- `bundle_path` = 本地 runnable copy 位置。

## 2. Multica 上建一个 agent 后，本地存哪里

Multica-connected Pi 根据环境变量解析当前 agent root：

```text
PI_AGENT_ROOT
# 或
MULTICA_WORKSPACE_ID + MULTICA_AGENT_ID
```

默认路径：

```text
~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/
```

目录结构：

```text
~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/
  memory/
    MEMORY.md
    USER.md
    STATE.md
    REVIEW.md
    SCRATCHPAD.md
    daily/
    audit/

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
    skill-candidates/
```

每个 Multica agent 是独立 root。Agent A 的 memory/skill 不会进入 Agent B 的目录。

本地 CLI Pi agent 也可以绑定同一个 Multica identity 后参与这套同步，不限于 Multica 上包装的一层 Pi agent。启动本地 Pi 前设置：

```bash
export MULTICA_WORKSPACE_ID=<workspace_id>
export MULTICA_AGENT_ID=<agent_id>
export PI_MEMORY_REMOTE_URL=<multica_server_url>
export PI_MEMORY_REMOTE_TOKEN=<token>
# 可选：不设置时默认派生到 ~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/
export PI_AGENT_ROOT=~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>
```

然后本地 Pi 可以手动调用 `memory_sync_pull` / `memory_sync_upload`，也可以打开 env-gated 自动兜底：

```bash
export PI_MEMORY_AUTO_SYNC_PULL_ON_START=1
export PI_MEMORY_AUTO_SYNC_UPLOAD_ON_SHUTDOWN=1
# 或用一个总开关：export PI_MEMORY_AUTO_SYNC=1
```

这些自动 hook 默认关闭，且失败不阻塞 Pi 启动或退出。

## 3. 本地会话怎么整理成 memory/skill

一次 Pi 会话结束后，大致流程是：

```text
session conversation/tool result
  -> daily/YYYY-MM-DD.md
  -> REVIEW.md candidate
  -> mark current agent root dirty
  -> Local Curator Manager / memory_curate
```

### Memory 路径

```text
REVIEW.md candidate
  -> memory proposal
  -> 用户 approve
  -> MEMORY.md / USER.md / STATE.md
```

### Skill 路径

```text
REVIEW.md skill_candidate
  -> memory_curate 生成 skill_promotion proposal
  -> 用户 approve
  -> skills/drafts/<slug>/SKILL.md
```

当前自动 proposal 生成器主要先生成 `SKILL.md`。但传输和启用链路已经支持完整目录：如果这个 draft 或 generated skill 目录里有 `scripts/`、`templates/` 等文件，后续上传、回流、enable 都会保留。

启用本地 skill：

```text
memory_skill_enable source=draft:<slug>
# 或
memory_skill_enable source=generated:<delivery-id>
```

启用后会复制完整目录到：

```text
skills/enabled/<skill-name>/
```

下次 run 会注入 `<available_skills>`，agent 看到任务匹配时读取对应 `SKILL.md`。

## 4. 哪个 skill 文件传到 Multica

默认传的是经过治理后的 share candidate，不是所有 enabled skill 自动上传。

来源通常是：

```text
skills/drafts/<slug>/
```

触发点：

```text
REVIEW.md 里有 shareable skill_promotion
  -> generateShareCandidatesFromReview()
  -> 读取 promotes_to 指向的 skills/drafts/<slug>/SKILL.md
  -> load 整个 skills/drafts/<slug>/ 目录
  -> 写 sync_queue/skill-candidates.jsonl
  -> 写 sync_queue/skill-candidates/<local_unit_id>/
```

实际上传内容是：

```text
sync_queue/skill-candidates/<local_unit_id>/SKILL.md
sync_queue/skill-candidates/<local_unit_id>/<supporting files>
```

上传 payload 对应 Multica 的 shared skill bundle 形态：

```text
content = SKILL.md
files = supporting files
content_hash = sha256 over content + files
```

上传工具：

```text
memory_sync_upload
```

它会上传：

```text
sync_queue/memory-candidates.jsonl
sync_queue/skill-candidates.jsonl
profile/*.md
feedback/feedback.jsonl
```

## 5. 怎么回流

Multica server 做远端治理/匹配后，对当前 agent 下发 delivery。

本地拉取：

```text
memory_sync_pull
```

### Memory 回流

Memory 回流写到：

```text
inbox/memory/<shared_unit_id>.json
shared-cache/memory/<shared_unit_id>.json
```

不会直接写入：

```text
memory/MEMORY.md
```

### Skill 回流

Skill 回流写到：

```text
inbox/skills/<shared_unit_id>/
  SKILL.md
  supporting files
  delivery.json

skills/generated/<shared_unit_id>/
  SKILL.md
  supporting files
```

不会自动写入：

```text
skills/enabled/
```

回流 skill 默认是“可审核/可启用”，不是自动生效。

如果要让它真正成为当前 agent 的 skill：

```text
memory_skill_enable source=generated:<shared_unit_id>
```

然后它会复制完整目录到：

```text
skills/enabled/<skill-name>/
```

## 6. 回流后怎么使用和反馈

### 回流 memory

- Run 开始时从 `shared-cache/memory` 做轻量匹配。
- 匹配上会注入 `Matched Shared Cache`。
- 自动写一条 `injected` feedback。

### 回流/generated skill

- 当前实现会对 `skills/generated/<id>/SKILL.md` 做轻量关键词匹配。
- 匹配上可能作为 shared context 摘要注入。
- 完整 skill 流程仍建议显式 enable 后使用。

### 反馈文件

反馈写到：

```text
feedback/feedback.jsonl
```

事件类型：

```text
injected
used
ignored
success
failure
conflict
```

自动部分：

```text
shared-cache/generated 匹配注入
  -> feedback.jsonl 写 injected
```

显式部分：

```text
memory_feedback({
  shared_unit_id: "...",
  unit_type: "skill",
  event: "used" | "success" | "failure" | "conflict",
  outcome: "success" | "failure" | "neutral"
})
```

上传反馈：

```text
memory_sync_upload
```

它会按 checkpoint 上传新增 feedback，避免重复上传。

## 7. 完整闭环

```text
Multica agent created
  -> local root: ~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/

Pi session
  -> memory/daily + memory/REVIEW.md

curator
  -> MEMORY.md / USER.md / STATE.md
  -> skills/drafts/<slug>/SKILL.md
  -> sync_queue/memory-candidates.jsonl
  -> sync_queue/skill-candidates.jsonl
  -> sync_queue/skill-candidates/<id>/SKILL.md + files

memory_sync_upload
  -> Multica receives governed memory/skill candidates + profiles + feedback

Multica server
  -> dedupe/rank/match/downflow

memory_sync_pull
  -> memory: inbox/memory + shared-cache/memory
  -> skill: inbox/skills + skills/generated

runtime
  -> matched memory/generated skill context injected
  -> optional memory_skill_enable generated:<id>

feedback
  -> feedback/feedback.jsonl
  -> memory_sync_upload
```

## 8. 一句话总结

本地正式使用的是 `memory/*.md` 和 `skills/{drafts,generated,enabled}/<name>/`；上传给 Multica 的 skill 是从本地 skill 目录打出来的完整 bundle，落在 `sync_queue/skill-candidates/<id>/`，JSONL 只是队列索引和上传 manifest。
