# Build Component Agent

**Model:** Sonnet. **One instance per component** (R10). Orchestrator spawns in parallel (cap 4).

**Spawn pattern:** orchestrator passes `slice.agent_prompt` (from `.build-slices/components/<name>.json`) as the Agent tool's `prompt` parameter. Agent does NOT read this file — everything needed is in the prompt. This file is human documentation of what the prompt does.

## Input (spec slice — agent sees ONLY this)
- `component.yml` (single file contents)
- `tokens.yml` keys this component uses (filtered)
- `typography.yml` styles this component uses (filtered)
- `icons.yml` entries this component uses (filtered)
- `meta.yml.framework`, `meta.styling`, `meta.library`
- Target path (e.g. `src/components/<name>/`)

Prompt size cap: 2000 words (R10).

## Steps

### 1. Parse spec
Enumerate variants. Variants are **observation-derived** (R8) — each represents a unique shape signature observed across screen instances. For each variant, the spec fields (colors, typography, dimensions, icons, spacing, radius, border) already reflect the rendered instance. Do NOT re-read Figma here — orchestrator already captured everything at screen walk time (R5, R7).

### 2. Classification check (R9, R14)
If `classification.kind = library-wrapped`:
- Import `libraryComponent` from `importPath`.
- Write thin wrapper applying tokens + classes only.
- Skip steps 3–6 — library handles structure.
- Still produce tests + stories.

### 3. Render per variant (R8)
One file. Variants as prop-driven branches (e.g. `variant: 'default' | 'hover' | 'disabled' | 'success'`). Each branch uses its OWN `referenceCode`, `colors`, `spacing`, `typography` — no diff math.

### 4. Apply tokens (R15)
Every color → `var(--<cssVar>)` resolved from `colors.<slot>` → `tokens.map[<path>].cssVar`. NO raw hex in output.

### 5. Layout sizing (R7, R19)
- `FIXED` → explicit `width: <Npx>` / `height: <Npx>` from `dimensions`
- `FILL` → `width: 100%` OR `flex: 1` (depending on parent direction)
- `HUG` → no dim set; rely on content
Implement BOTH horizontal + vertical per spec.

### 6. Icons (R12, R13)
For each `component.icons[]`:
- Use `iconName` from webfont OR import SVG (per `icons.strategy`)
- Set `font-size = visibleSizePx * 2; line-height: 1` (webfont only)
- Apply `colorToken` as `color: var(--...)` (webfont) or via `currentColor` (SVG)
- Never substitute with another icon (R13)

### 7. Spacing + radius + border + shadow
Apply literal values from variant spec. Use token refs where spec includes one.

### 8. Nested children
For `variants[].children[]`, import the referenced component and pass `variantName` as prop.

### 9. Self-check
Cross-reference every CSS property vs spec (R7). Mark any uncertainty as build failure → return error instead of partial code.

### 10. Output
```
src/components/<name>/
  <name>.tsx          (React) OR <name>.component.ts (Angular)
  <name>.module.scss  OR  <name>.scss + tailwind classes inline
  index.ts            (named re-export only)
```

### 11. Conventions (hard)
- NAMED exports only. No `export default`.
- Root element must have `data-component="<name>"` attribute (used by screen validate L1 to attribute failures back to this component).
- `index.ts` re-exports the named symbol: `export { <Name> } from './<Name>';`.
- NO storybook / stories files.

## Forbidden
- Reading other component specs (context bloat)
- Raw hex in output (R15)
- Proxy icons (R13)
- Custom wrapper when library-wrapped declared (R9)
- Inferring missing spec values — fail loudly instead (R7)
- Writing more than this ONE component (R10)
