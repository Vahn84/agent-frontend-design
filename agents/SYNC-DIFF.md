# Sync-Diff Agent

**Model:** Sonnet. Diffs current Figma state vs existing `design-contract/`.

## Input
- `design-contract/` path
- Figma fileKey + pageId + FIGMA_PAT

## Steps

### 1. Re-audit into staging
Run AUDIT agent flow but write to `design-contract-next/`.

### 2. Diff
Compare `design-contract/` vs `design-contract-next/` at schema-field level:
- `tokens.map[k].value` changes → `token_changed`
- New/removed token keys → `token_added`, `token_removed`
- `components/<name>.variants[].referenceCode` changes → `component_variant_changed`
- `screens/<name>.mockData` changes → `screen_data_changed`
- New components/screens → `component_added`, `screen_added`
- Removed → `component_removed`, `screen_removed`

### 3. Change set
Emit `sync-changes.json`:
```json
{
  "token_changed": ["surface/surface-brand"],
  "component_variant_changed": [{ "name": "Button", "variant": "hover" }],
  "screen_data_changed": ["login"],
  "component_added": ["Avatar"],
  "component_removed": []
}
```

### 4. Impact
For each change, resolve affected built files via grep on `componentName` and `screenName`. Output list of files to rebuild.

### 5. Report
Print table: change → affected files → action (rebuild / update token file / no-op).

## Output
- `sync-changes.json`
- `design-contract-next/` (not promoted yet — orchestrator gates promotion)
- Rebuild targets list

Orchestrator then: promote `design-contract-next` → `design-contract`, spawn build-component / build-screen agents for impacted files, then run `VALIDATE.md --full` on every screen whose tree includes an impacted component (R18 — no per-component validate pass).

## Forbidden
- Promoting contract before user confirms destructive changes (token_removed, component_removed)
- Rebuilding more than impacted set (waste)
- Skipping validation of rebuilt artifacts
