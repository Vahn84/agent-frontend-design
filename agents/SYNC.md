# Sync Workflow

**Prereq:** `design-contract/` exists + codebase exists + `FIGMA_PAT` set (REST client smoke-checked).

## Phases

### A. Diff
Spawn `SYNC-DIFF.md` agent. Output: `sync-changes.json` + `design-contract-next/`.

### B. User confirm destructive
If change set includes `token_removed` OR `component_removed` OR `screen_removed`:
- Show diff summary
- Ask: apply / skip destructive / abort
Otherwise auto-proceed (R22).

### C. Promote contract
`mv design-contract-next/* design-contract/` for accepted changes only.

### D. Update tokens
If `token_changed` or `token_added`: rewrite `src/styles/tokens.css` from updated `tokens.yml`. No code rebuild needed.

### E. Rebuild impacted components
Spawn `BUILD-COMPONENT.md` per impacted component (parallel cap 4).

### F. Rebuild impacted screens
Spawn `BUILD-SCREEN.md` per impacted screen (cap 2).

### G. Validate
`VALIDATE.md --full` on every impacted route. Fail = rebuild + retry (R23).

### H. Report
Table of: changes applied → files updated → validation result.
