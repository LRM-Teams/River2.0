# Evolution history

One entry per iteration, appended by the evolve agent. Format:

```
## Iteration N — pass X/Y (Z%)
- flips: task-a fail->pass, task-b pass->fail
- changes: chg-1 (component) short description
- lesson: one line
```

---

## Iteration 1 — pass 2/2 (100.0%)
- flips: n/a (initial iteration)
- changes: none; no failed or timed-out tasks provided evidence for a safe targeted workspace edit
- lesson: when pass rate is already 100%, avoid prompt/config churn without failure evidence.
