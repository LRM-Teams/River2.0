# AutoDataset Workflow Spec

## Objective

Define an on-demand workflow for using pi to run dataset competitions and iteratively improve a dataset-solving SOP.

The core idea is:

```text
normal pi usage stays unchanged
  ↓
user explicitly starts an AutoDataset workflow for one dataset
  ↓
pi inspects the dataset, builds a local evaluation loop, runs experiments
  ↓
pi records rollout traces and scores
  ↓
pi uses an optimizer-agent mode to propose bounded edits to dataset skills
  ↓
only score-improving skill changes are accepted
  ↓
workflow stops or pauses without affecting normal pi behavior
```

This is inspired by SkillOpt-style self-evolving skills, but scoped to practical dataset work. The training target is not model weights. The training target is a text artifact such as `skill.md`, `workflow.md`, or `best_skill.md` that tells the agent how to work on this class of dataset tasks.

## Design Principle

AutoDataset should be a task-specific workflow, not an always-on behavior.

- Normal pi remains a general coding assistant.
- AutoDataset only starts after an explicit command or user request.
- Dataset-specific skills are loaded only inside the dataset workflow.
- Long-running experiment state is stored in the dataset project, not mixed into general memory by default.
- Promotion into reusable global skills requires review or an explicit approval step.

## Intended User Experience

The user should be able to point pi at a dataset directory and ask it to prepare the workflow:

```text
/autodataset /path/to/competition
```

or in natural language:

```text
帮我看一下这个数据集，搭一个之后可以自动打分和迭代的 workflow
```

Expected behavior:

1. pi scans the dataset directory and documentation.
2. pi identifies files, schema, target column, task type, metric, and submission format when possible.
3. pi creates a local workflow definition, including how to train, evaluate, and validate submissions.
4. pi builds a simple baseline before trying complex modeling.
5. pi records each experiment as a run artifact.
6. pi can later enter an optimization loop that improves both modeling code and dataset-specific skill instructions.
7. When the workflow is not active, pi behaves normally.

## Non-Goals

AutoDataset should not initially try to be a full AutoML platform.

- Do not auto-submit to Kaggle or other public leaderboards in the first version.
- Do not trust public leaderboard score as the primary optimization signal.
- Do not run indefinitely without budgets, checkpoints, and stop rules.
- Do not overwrite original data.
- Do not store dataset secrets, tokens, or private labels in global memory.
- Do not automatically promote a dataset-specific skill into a global skill.
- Do not assume every dataset is tabular CSV; support should be explicit and incremental.

## Repository Layout

A dataset project should contain workflow state in a predictable structure:

```text
competition/
  data/
    train.csv
    test.csv
    sample_submission.csv
  src/
    train.py
    predict.py
    features.py
    validate.py
  skills/
    seed_skill.md
    current_skill.md
    candidate_skill.md
    best_skill.md
    rejected_edits.md
  workflows/
    autodataset.yaml
    workflow.md
  runs/
    0001/
      trace.json
      metrics.json
      train.log
      eval.log
      notes.md
      diff.patch
      submission.csv
    0002/
      ...
  README.md
```

The exact layout can be adapted, but AutoDataset needs stable places for:

- dataset metadata,
- executable workflow config,
- skill versions,
- run artifacts,
- logs and scores,
- accepted and rejected skill edits.

## Workflow Definition

AutoDataset should generate or maintain a workflow file:

```yaml
name: example-competition
task_type: tabular-regression
metric:
  name: rmse
  direction: minimize
data:
  train: data/train.csv
  test: data/test.csv
  sample_submission: data/sample_submission.csv
  target: SalePrice
validation:
  strategy: holdout
  split_seed: 42
  holdout_fraction: 0.2
commands:
  train: python src/train.py
  predict: python src/predict.py
  score: python src/validate.py
budgets:
  max_rounds: 20
  max_minutes_per_round: 30
  max_repair_attempts: 3
acceptance:
  min_delta: 0.001
  require_format_check: true
  require_validation_improvement: true
```

This file is the contract between pi, the dataset, and the scoring gate.

## Phase 1: Dataset Discovery

The first phase is read-only whenever possible.

Checklist:

- List all files and infer common roles: train, test, labels, sample submission, docs.
- Read README, competition description, data dictionary, and metric instructions.
- Inspect only small samples at first to avoid expensive reads.
- Infer schema: column names, types, missingness, target, ID column, time columns, group columns.
- Identify task type: classification, regression, ranking, time series, NLP, CV, retrieval, generation, or unknown.
- Identify evaluation metric and direction: maximize or minimize.
- Identify submission format: required columns, row count, ID ordering, allowed values.
- Identify leakage risks: target-like columns, future timestamps, duplicated IDs, train/test overlap.

Output:

```text
workflows/workflow.md
workflows/autodataset.yaml
skills/seed_skill.md
```

If target, metric, or evaluation cannot be inferred safely, AutoDataset should stop and ask for clarification instead of hallucinating a scoring rule.

## Phase 2: Baseline Construction

The baseline should be intentionally simple and reproducible.

For tabular tasks, examples include:

- constant or majority-class baseline,
- simple scikit-learn pipeline,
- LightGBM/XGBoost/CatBoost baseline when available,
- deterministic train/validation split,
- fixed random seed,
- strict submission format validation.

The baseline is valuable even if weak because it proves the workflow can run end to end:

```text
read data -> train -> predict -> score -> generate submission -> validate format -> record run
```

The baseline run becomes the first score anchor.

## Phase 3: Rollout Runs

Each experiment is a rollout. A rollout is not just a score; it is the full trace of what happened.

Each run directory should include:

```json
{
  "run_id": "0001",
  "started_at": "2026-06-15T00:00:00Z",
  "skill_version": "current_skill.md@hash",
  "code_version": "git-or-patch-hash",
  "task_type": "tabular-regression",
  "metric": "rmse",
  "direction": "minimize",
  "validation_score": 0.1234,
  "format_check": "passed",
  "status": "success",
  "failure_reason": null,
  "notes": [
    "baseline LightGBM with numeric features only",
    "categorical columns not yet encoded"
  ]
}
```

Trace files should capture:

- commands run,
- failures and stderr summaries,
- data assumptions,
- feature changes,
- model changes,
- validation score,
- submission checks,
- whether the run improved the best score.

## Phase 4: Scoring Gate

The scoring gate decides whether a modeling change or skill change is accepted.

Minimum gate rules:

- A candidate must pass format checks.
- A candidate must be evaluated by the configured local validation method.
- Improvement must beat `min_delta`, not just equal the previous score.
- If the metric direction is `minimize`, lower is better; if `maximize`, higher is better.
- Public leaderboard score must not be the only acceptance signal.
- Suspicious improvements should trigger leakage review.

This gate is the safety layer that prevents the optimizer from accepting plausible but harmful instructions.

## Phase 5: Optimizer-Agent Mode

The optimizer agent can be pi itself running in a different role.

Executor role:

```text
use current_skill.md -> run experiment -> produce trace and score
```

Optimizer role:

```text
read recent traces -> find repeated failure patterns -> propose bounded edits to skill.md
```

Gate role:

```text
run candidate workflow -> compare score -> accept or reject candidate_skill.md
```

The optimizer should not rewrite the whole skill in one step. It should propose bounded edits:

- `add`: add one new rule,
- `delete`: remove one harmful or obsolete rule,
- `replace`: rewrite one narrow rule,
- `reorder`: move a rule if ordering matters.

Suggested edit budget:

```text
max 1-3 edits per optimization round
```

This acts like a textual learning rate. Small edits make it easier to understand why a score changed.

## Skill Lifecycle

AutoDataset uses multiple skill files:

```text
seed_skill.md      initial human or generated SOP
current_skill.md   skill used by the next executor rollout
candidate_skill.md proposed optimizer edit under evaluation
best_skill.md      best accepted skill for this dataset
rejected_edits.md  negative feedback for edits that failed the gate
```

Acceptance flow:

```text
current_skill.md
  ↓
optimizer proposes candidate_skill.md
  ↓
executor runs validation under candidate_skill.md
  ↓
score improves and checks pass?
  ├─ yes: promote candidate_skill.md to best_skill.md and current_skill.md
  └─ no: append edit and reason to rejected_edits.md
```

Rejected edits should be preserved because they teach the optimizer what not to repeat.

Example rejected entry:

```md
## Rejected Edit 0004

Proposed rule:
- Prefer public leaderboard movement over local validation when they disagree.

Reason rejected:
- Local validation degraded and this increases leaderboard overfitting risk.
```

## Workflow Activation

AutoDataset should be inactive by default.

Activation options for future implementation:

```text
/autodataset init <dataset-dir>
/autodataset run <dataset-dir>
/autodataset optimize <dataset-dir>
/autodataset status <dataset-dir>
/autodataset stop <dataset-dir>
```

A minimal first version can avoid multiple public commands and use natural language over a single entrypoint:

```text
/autodataset <dataset-dir>
```

The workflow should load dataset-specific context only after activation. When the user exits or pauses AutoDataset, those instructions should not continue to bias normal pi behavior.

## Long-Running Execution

Long-running dataset work needs stronger control than a normal chat turn.

Required runtime features:

- checkpoint after every run,
- resumable state,
- max rounds,
- max wall-clock time per run,
- max consecutive failures,
- no-progress stop rule,
- log compaction,
- safe interruption and resume,
- explicit user approval before expensive or external operations.

Suggested stop rules:

- metric cannot be computed,
- data contract is ambiguous,
- same error repeats after repair budget,
- no validation improvement after N rounds,
- disk/time/token budget is reached,
- credentials or external access are required,
- possible data leakage is detected,
- user interrupts or changes objective.

## Safety And Isolation

AutoDataset should treat datasets as potentially sensitive.

Rules:

- Do not write raw private data into global memory.
- Do not store secrets, API keys, or competition tokens in logs.
- Do not auto-upload submissions.
- Do not delete original data.
- Keep generated artifacts under the dataset project.
- Prefer local scoring before any external evaluation.
- Ask before installing packages, using network, or running expensive jobs.
- Use `.gitignore` for large data, model artifacts, and submissions when appropriate.

## Relationship To pi Memory And Skills

AutoDataset can use pi memory, but should separate local dataset learning from global assistant learning.

Recommended policy:

- Store run-level traces in `competition/runs/`.
- Store dataset-specific SOP in `competition/skills/`.
- Store only high-level durable lessons in pi memory when they generalize beyond the dataset.
- Promote reusable patterns into global skill drafts only after review.
- Version skill changes so the user can inspect, diff, and roll back.

This prevents one dataset's quirks from polluting general pi behavior.

## Future Implementation Stages

### Stage 0: Documentation Only

Record the workflow idea and directory contract. No automation required.

### Stage 1: Manual Workflow Template

Create templates for:

- `workflows/autodataset.yaml`,
- `workflows/workflow.md`,
- `skills/seed_skill.md`,
- `runs/<id>/metrics.json`.

pi can fill these files after inspecting a dataset.

### Stage 2: Local Runner

Implement a local runner that can:

- create run directories,
- execute configured train/predict/score commands,
- capture logs,
- write metrics,
- compare scores.

### Stage 3: Skill Optimization Loop

Add optimizer-agent behavior:

- read recent traces,
- propose bounded skill edits,
- evaluate candidate skill,
- accept or reject by scoring gate,
- append rejected edits.

### Stage 4: Long-Running Orchestrator

Add resumable background or goal-mode orchestration:

- budgets,
- checkpoints,
- crash recovery,
- session handoff,
- status view,
- pause/resume.

### Stage 5: Multi-Dataset Transfer

Promote repeated successful patterns into reusable global skills:

- tabular competition skill,
- time-series skill,
- document QA dataset skill,
- image classification skill,
- ranking/retrieval skill.

Promotion should remain auditable and reversible.

## Minimal First Workflow

The first practical version should be intentionally small:

```text
input: local dataset directory with train/test/sample_submission
output: autodataset.yaml, baseline code, scoring command, first run artifact, seed skill
```

Minimal loop:

```text
1. Inspect dataset and docs.
2. Generate autodataset.yaml.
3. Generate simple baseline.
4. Run local validation.
5. Save run artifact.
6. Write seed_skill.md describing what was learned.
7. Stop and ask user before long optimization.
```

Only after this works should AutoDataset attempt autonomous multi-round optimization.
