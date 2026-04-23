# Build Component Agent

**Model:** Sonnet. **One instance per component** (R10). Orchestrator spawns in parallel (cap 4).

**Spawn pattern:** orchestrator passes `slice.agent_prompt` (from `.build-slices/components/<name>.json`) as Agent tool's `prompt` parameter. Agent does NOT read this file — everything needed is in prompt. This file is human documentation of what prompt does.

## R53 — Deterministic variant CSS codegen (binding)

Spec-derivable CSS is NOT written by this agent. Slice carries `prebuiltCss` — one class per variant capturing every `dimensions`, `spacing.gap`, `spacing.padding*`, `radius`, `border`, `colors.*` (→ `background-color` / `color` via token vars), `layoutSizing` (FIXED px / FILL 100% / HUG content-driven), typography class on text slots, icon visible-size. Agent writes `prebuiltCss` verbatim to `<Name>.module.css`, then authors JSX referencing class names.

**Forbidden in agent-authored code:** raw CSS property writes for `gap`, `padding*`, `width`/`height` (FIXED), `border-radius`, `border`, `background-color`, `color`, `flex-direction`, `align-items`, `justify-content`, typography shorthand. All derived from spec and emitted by `prepare-build.mjs`.

**Agent scope:** component prop API (props → variant selection), JSX structure, class dispatch per variant, library-wrapped composition (R9/R14), icon component dispatch (R12/R13), image `<img>` rendering w/ R29 crop percentages (until R53 extends to imageFrames), index.ts re-export, `data-component` attribute.

**R43 registry.** When `design-contract/components/index.yml` exists (emitted by `scripts/consolidate-components.mjs`), orchestrator must consult its `mainComponentKeyToName` map to resolve canonical component names before slicing. Several Figma components with same shape (e.g. Icons1..IconsN, Check/Check2/Check3) collapse into single canonical component with merged variants. Do NOT build one React component per Figma `mainComponentKey` — build one per canonical name, emitting every merged variant as prop combination.

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
Enumerate variants. Variants are **observation-derived** (R8) — each represents unique shape signature observed across screen instances. For each variant, spec fields (colors, typography, dimensions, icons, spacing, radius, border) already reflect rendered instance. Do NOT re-read Figma here — orchestrator already captured everything at screen walk time (R5, R7).

### 2. Classification check (R9, R14)
If `classification.kind = library-wrapped`:
- Import `libraryComponent` from `importPath`.
- Write thin wrapper applying tokens + classes only.
- Skip steps 3–6 — library handles structure.
- Still produce tests + stories.

### 3. Render per variant (R8)
One file. Variants as prop-driven branches (e.g. `variant: 'default' | 'hover' | 'disabled' | 'success'`). Each branch uses its OWN `referenceCode`, `colors`, `spacing`, `typography` — no diff math.

### 4. Apply tokens (R15, R46)
Every color → `var(--<cssVar>)` resolved from `colors.<slot>` → `tokens.map[<path>].cssVar`. NO raw hex in output. Every `var(--x)` emitted MUST match either cssVar from filtered `tokens.yml` slice or whitelisted internal (`--tw-*`, `--pr-*`, `--p-*`, `--radix-*`, `--crop-*`, `--slot-*`, `--component-*`). Inventing var name fails L10 on validate.

### 4b. Styling layer (R45 — NO INLINE STYLES)
FORBIDDEN: React `style={{...}}` / Angular `[style]=` in `<Name>.tsx` / `<Name>.component.ts` — raw CSS properties bypass token pipeline + defeat static analysis. Use:
- **React + Tailwind** — Tailwind utility classes for spacing/layout/typography + CSS var color classes (e.g. `bg-[var(--surface-surface-brand)]`). Arbitrary values OK via `[Npx]` syntax for FIXED dims without utility (`w-[264px] h-[48px]`).
- **React + SCSS (if declared)** — `<Name>.module.scss`. All CSS lives there. Component imports `styles from './<Name>.module.scss'` and applies via `className`.
- **Angular + SCSS** — `<Name>.component.scss` sibling + `styleUrls`.
`style={{...}}` only permitted to set CSS custom properties as token carriers (`style={{ '--crop-w': `${pct}%` }}`), NEVER raw CSS properties like `width`/`color`/`padding`.

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
For `variants[].children[]`, import referenced component and pass `variantName` as prop.

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
- Root element must have `data-component="<name>"` attribute (used by screen validate L1 to attribute failures back to component).
- `index.ts` re-exports named symbol: `export { <Name> } from './<Name>';`.
- NO storybook / stories files.

## Forbidden
- Reading other component specs (context bloat)
- Raw hex in output (R15)
- **Inline styles on JSX elements (R45)** — `style={{...}}` only allowed for `--custom-prop` carriers, never raw CSS props. All layout/color/typo goes to Tailwind classes or component's `.module.scss`.
- Inventing CSS var names outside Figma tokens + whitelisted internals (R46)
- Proxy icons (R13)
- Custom wrapper when library-wrapped declared (R9)
- Inferring missing spec values — fail loudly instead (R7)
- Writing more than this ONE component (R10)
