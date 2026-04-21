# Wire Library Workflow

Replace custom components with library equivalents (PrimeReact, PrimeNG, MUI, Chakra, AntD, etc) WITHOUT losing Figma fidelity. Agent reads library-specific override patterns from `agents/library-overrides/<lib>.md` before touching code.

**Prereq:**
- `design-contract/meta.yml.library.name` set (e.g. "primereact")
- Library installed: `npm ls primereact` succeeds
- At least one screen built + passing validate

## Phases

### A. Check prerequisite
Read `meta.yml`. If `library.name` null → STOP + ask user "which library? (PrimeReact/MUI/AntD/Chakra/custom-stay)". If user picks a library, install it + update meta.

### B. Load override knowledge
Read `agents/library-overrides/<library>.md`. Contains: library's component catalog, install imports, prop mapping, style override mechanism (theme / CSS vars / PassThrough / sx / styled()), sample overrides for common components (Button, DataTable, Checkbox, Switch, Input, Dialog, Paginator).

Orchestrator MUST load this before emitting any wire plan.

### C. Scan screen
Target screen (from `$ARGUMENTS`) or all screens:
- Read `design-contract/components/*.yml`
- Read screen source + its component imports
- For each imported custom component, check if library has an equivalent:
  - Match by semantic role (button, table, input, toggle, checkbox, date-picker, modal, paginator, tooltip)
  - Confirm via library's component catalog in override knowledge

### D. Plan
Emit table:
```
| custom component | library equivalent | fidelity risk | override strategy |
|------------------|-------------------|---------------|------------------|
| DesktopCta       | PrimeReact Button  | low   | className + PassThrough |
| OnOff            | PrimeReact InputSwitch | medium | CSS var + pt.slider |
| Checkbox         | PrimeReact Checkbox | low | disable default border |
| Paginator        | PrimeReact Paginator | high | full pt override of template |
| TableRow         | PrimeReact DataTable row | high | template column + pt.row |
```

**Fidelity risk**: low = library default looks close, medium = need per-prop overrides, high = need deep pt overrides or template functions. Agent flags "high" items for user awareness.

### E. Confirm
`AskUserQuestion`:
- "Wire all" → proceed with entire plan
- "Wire selected" → ask which rows to include
- "Cancel" → stop
- For any "high" risk row, offer: "Wire now" / "Skip" / "Keep custom + wire later"

### F. Update contract
For each wired component:
- Set `component.classification.kind` → `library-wrapped`
- Set `component.classification.libraryComponent` → `PrimeReact/InputSwitch` etc
- Set `component.classification.importPath` → `primereact/inputswitch`
- Append to `meta.yml.library.components[]` with `figmaName`, `libraryComponent`, `importPath`, `wrappedPrimitive`.

### G. Rebuild wired components
For each wired component, spawn build-component agent with UPDATED slice (classification now library-wrapped). Agent follows R9 — imports library wrapper, applies overrides from `agents/library-overrides/<lib>.md` to match Figma spec.

### H. Update screen
If the screen imports the custom component by name, no change needed (same export name). If screen used raw HTML (`<input type="checkbox">`) where wrapper now exists, R14 applies — replace with wrapper.

### I. Validate
`node scripts/validate.mjs --target <screen-file> --spec <slice> --url <dev> --full`

Fidelity before/after captured in FIXLOG.

### J. Report
- components wired: N
- components skipped: M
- fidelity delta: before → after
- any regressions (new entries in FIXLOG "New" bucket)

## Rules
- R9 library-wrapped → import wrapper, do not build custom
- R14 pages must USE wrappers, not raw HTML (check-wrappers.mjs enforces)
- R23 never silently skip a failed wiring — rollback + report
- Agent MUST read `agents/library-overrides/<lib>.md` before wiring. Skipping it = fidelity regression risk.
