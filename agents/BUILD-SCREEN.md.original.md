# Build Screen Agent

**Model:** Sonnet. **One instance per screen** (R10). Orchestrator spawns cap 2 (shared router).

**Spawn pattern:** orchestrator passes `slice.agent_prompt` (from `.build-slices/screens/<name>.json`) as the Agent tool's `prompt` parameter. Agent does NOT read this file — everything needed is in the prompt.

**R43 registry.** When `design-contract/components/index.yml` exists, orchestrator resolves every `mainComponentKey` in the screen tree via `index.mainComponentKeyToName` before slicing. Multiple Figma keys may map to the same canonical component — screen imports ONE React component per canonical name and supplies the correct variant/props. Never import one component per key.

## Input (spec slice)
- `screen.yml` (enriched per-node tree — every descendant captured, R1/R32)
- Names + import paths of components referenced (resolved via `mainComponentKey` → canonical name via R43 registry)
- `meta.yml.framework`, `meta.styling`
- Target path (e.g. `src/pages/<name>/`)

## Steps

### 1. Mock file (R3)
Write `src/pages/<name>/<name>.mock.ts`:
```ts
export const mock = { ... }  // verbatim from screen.mockData — no inventing
```
If `mockData` is empty/missing → STOP, return error (R23 gate).

### 2. Walk the enriched tree
The tree is the **source of truth**. For each node, dispatch on `kind`:

| `kind` | Emit |
|--------|------|
| `frame` / `group` / `rectangle` / `ellipse` | `<div>` with captured `layoutSizing`, `dimensions`, `spacing`, `direction`, `alignItems`, `justifyContent`, `colorToken` (as `background-color: var(--...)`), `radius`, `border`. Recurse into `children`. |
| `text` | `<h1|h2|p|span class={<style>}>{<content>}</…>` with `color: var(--<colorToken>)`, `text-align: <text.textAlign>`. Style class maps to `typography.styles[node.text.style]`. If `content` matches a `mockData` key → bind from `mock`. |
| `instance` | Import `<ComponentName>` (resolved from `mainComponentKey`). Variant = the one whose signature matches (provided in slice as `variantName`). Pass any node-level `dimensions` / `layoutSizing` as style overrides ONLY when they differ from the variant's defaults (R32 — instance override wins). |
| `vector` (with `icon`) | Icon component sized `visibleSizePx`, colored `colorToken` (R12, R13). |
| `imageFrame` (any node) | R29 percentage crop: container `position: relative; overflow: hidden` at `container.widthPx/heightPx`; `<img>` at `position: absolute; width: <imageWidthPct>%; height: <imageHeightPct>%; left: <imageLeftPct>%; top: <imageTopPct>%`. Never collapse to `object-fit: contain`. |

Legacy fallback: nodes with `kind: component` / `kind: container` are still accepted (old contract shape). Treat `component` like `instance`, `container` like `frame`.

### 2b. Styling layer (R45 — NO INLINE STYLES)
FORBIDDEN: `style={{...}}` on any JSX element in `<Name>.tsx`. Use ONLY:
- **React + Tailwind** — utility classes. Arbitrary values via `[Npx]` / `[var(--x)]` syntax.
- **React + SCSS (if declared in meta)** — sibling `<Name>.module.scss`.
- CSS variables emitted by tokens.css map every color token — use `bg-[var(--tokens-surface-surface-brand)]` / `text-[var(--tokens-text-text-primary)]` / `border-[var(--tokens-stroke-stroke-primary)]`.
- Dynamic per-mock values (R29 image crop %, computed dims) → set as `--custom-*` carriers only: `style={{ '--crop-w': '80%' }}` paired with a CSS rule `width: var(--crop-w)` in the scss module. NEVER raw `width: '80%'` inline.
- R46 gate: every `var(--x)` must resolve to a Figma token or whitelisted internal (`--tw-*`, `--pr-*`, `--p-*`, `--radix-*`, `--crop-*`, `--slot-*`, `--component-*`). L10 fails the validate otherwise.

### 3. Screen root (R19, R31)
Screen frame gets `layoutSizing` + `dimensions`. Root element honors `viewportFit`:
- `fill` → `.root { width: 100vw; height: 100vh }` + flex from captured direction
- `fixed-design` → root locked to `spec.dimensions.width/height`
- `scale` → transform-scaled stage

### 4. Route registration
Add route in `src/App.tsx` (React) or `app.routes.ts` (Angular). Path = `screen.route`.

### 5. Library usage check (R14)
Before writing, grep planned JSX for raw HTML equivalents of wrapped primitives (`<table>`, `<input type="checkbox">`, `<input type="range">`). If found AND a wrapper exists in `meta.library.components[]` → use wrapper instead.

### 6. Output
```
src/pages/<name>/
  <Name>.tsx         (React) OR <Name>.component.ts (Angular)
  <Name>.mock.ts
  <Name>.module.scss
```

### 7. Conventions (hard)
- NAMED export only. `export function <Name>()`. No default.
- Root element sets `data-screen="<name>"` attribute.
- Do NOT modify `main.tsx` or router files — scaffold already registered routes.

## Forbidden
- Inventing mock data (R3)
- Raw HTML when library wrapper exists (R14)
- Skipping any tree node (the enriched tree is the spec; every node renders)
- Applying inline styles in JSX (R45 — forbidden entirely; `style` only allowed for setting CSS custom properties as token carriers, never raw props). Bypasses the token pipeline + R15.
- Reaching back to Figma — the tree IS the data (R5)
- Building more than this ONE screen (R10)
