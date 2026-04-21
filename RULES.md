# RULES

Numbered. Cited by ID. Loaded by orchestrator + every agent.

## Audit

**R1** Exhaustive per-node capture. Every descendant node in every target screen captured with full decoration: typography, color, align, spacing, dimensions, icons, imageFrames, children. One instance never enough — walk the screen tree, don't enumerate the master.

**R2** Icons from library file. Trace mockup instance → `componentKey` → library `fileKey`. Export full Icons page, not mockup subset. Export the VECTOR child, not container (padding bakes into viewBox).

**R3** Mock data 1:1. Every text/ID/name/date/status/label visible in a screen captured verbatim in `screen.mock_data`. No inventing.

**R4** `client.getFileNodes(fileKey, [screenId], { depth })` not filesystem guesses. REST returns the full subtree under the screen root — no Plugin API `childCount` pitfalls.

**R5** Never build from memory. Every node captured via `client.getFileNodes` + `transformNode` at the screen level before writing code. Master-level reads are derivative — used only to resolve a cluster's display name, never decoration.

**R6** Token refs, not raw hex. Every color/spacing/radius/typography value stored as CSS var name resolved via `client.getLocalVariables` + `buildTokenMap` + per-node `boundVariables` walk (see `lib/tokens.mjs`). Raw hex in contract = audit incomplete. Requires Enterprise plan for the Variables REST endpoint — non-Enterprise falls back to `node.styles` + manually-seeded tokens.

## Contract

**R7** Complete-on-first-build. `layout_sizing`, `dimensions`, `gap`, `padding`, `radius`, `border`, typography all correct at audit time. Validation is verification, not repair.

**R8** Per-variant specs derived from observed instance shapes. Variants = instances grouped by `mainComponentKey` + dedup signature (hash of dimensions + colors + typography + icons + spacing + radius + border). Each variant records `instances: []` (list of source `{screenNodeId, instanceNodeId}`) for traceability. Not from master enumeration.

**R9** Library classification. Components flagged `library-wrapped` in `meta.yml` MUST use the library wrapper on first build pass, not custom refactor.

## Build

**R10** One agent per component. One agent per screen. Orchestrator passes ONLY that slice. Agent prompt ≤2000 words.

**R11** Parallel where independent. Components with no deps build concurrently (cap 4). Screens cap 2 (shared router).

**R12** Webfont icon sizing. Webfont glyphs occupy inner 50% of viewBox. `font-size = visible_px * 2`, `line-height: 1`. Contract stores `visible_size_px` per icon usage.

**R13** Custom icons only. Never proxy with another glyph. Extend webfont OR fail loudly.

**R14** Library wrapper USED. If wrapper exists for a primitive (table/toggle/checkbox), pages import and use it. No raw HTML equivalents. Validated by grep.

**R15** Tokens in code. Built CSS references project CSS var (e.g. `var(--color-surface-brand)`). No raw hex in component output.

## Validate

**R16** Layered. Run order: structure → layout → color → typography → pixel diff. Fail fast — skip later layers on earlier fail.

**R17** Full size only. Screenshots at Figma frame exact dimensions (2× DPR). No PASS judgments from thumbnails.

**R18** Validation is screen-level only. All layers (structure, layout, color, typography, pixel diff) run on assembled screens. No standalone per-component validate step — components are exercised inside their hosting screen's DOM. Component correctness is enforced earlier by L0 wrapper gate (R28) + schema gates (R7, R19) at prepare-build time.

**R19** Layout_sizing gate. Every component AND every screen frame: FIXED/FILL/HUG enforced. FIXED needs dimensions, FILL has no fixed dim, HUG content-driven.

**R20** Generic. Validation scripts contain ZERO hardcoded component names, class patterns, or CSS expectations. Derived from Figma API + live DOM at runtime.

## Orchestration

**R21** No unrequested questions. Only ask what CLAUDE.md marks "always asked" (framework, project name, FIGMA_PAT, library). Default everything else.

**R22** Never ask to continue/stop. Deliverable is routed app. Build all components AND all screens without pause.

**R23** Never skip failed steps. Any tool/script failure → retry + diagnose. Never proceed past a failure silently.

**R24** PAT required. Ask upfront. All Figma reads (metadata, variables, images, icons, components) go through `lib/figma.mjs` with `FIGMA_PAT` (env or passed). No MCP fallback — this fork is REST-only.

**R25** SVG normalization. Every exported icon passes `scripts/normalize-icons.mjs` + `--check`. Raw hex fill = fail.

**R26** Glyph verification. After webfont build, `scripts/verify-glyphs.mjs` compares rendered glyph to Figma reference. Size or shape mismatch = fail.

**R27** REST call cache. Audit persists `getFileNodes` responses per screen-root nodeId and the single `getLocalVariables` response to `design-contract/.audit-cache/<nodeId>-<endpoint>.json`. Keyed by screen nodeId + endpoint — one cached blob covers the entire descendant subtree. `lib/figma.mjs` also supports `{ cacheDir }` for raw-response caching. Reuse within run + on `/sync`.

**R28** L0 wrapper gate. `scripts/check-wrappers.mjs` runs BEFORE any validation layer. Any raw HTML primitive where a wrapper is declared = fail + rebuild.

**R29** Preserve image crop percentages. When Figma reference code emits an `<img>` with percentage width/height AND negative offsets (e.g. `w-[121.44%] h-[347.69%] left-[-10.72%] top-[-123.46%]`), capture those values verbatim in contract. Build must replicate them — never replace with `object-fit: contain` or `width: 100%`. Collapsing the crop loses pixel-accurate positioning and makes visual content look wrong (too small, wrong region visible).

**R31** Viewport-fit per screen. Every screen declares `viewportFit: fill | fixed-design | scale` (default fill). Figma root frames are always FIXED dimensions (Figma limitation) but they represent DESIGN REFERENCE, not absolute output size. `fill` = root stretches to viewport, FIXED inner components keep Figma px, cover/sidebar with FILL vertical gets height:100%. `fixed-design` = root locked to spec.dimensions (kiosks, signage). `scale` = transform-scaled frame. Validate L2 branches per mode. L5 pixel diff skipped when `fill` AND viewport size != design size (pixel comparison is meaningless at mismatched aspect).

**R32** Instance overrides win. Master is derived, not source. Any decoration visible on an instance (text color, alignment, width override, nested icon child, per-instance spacing) is captured at the screen node level. Audit walks the screen tree exhaustively — instance properties shadow master defaults. A master may be HUG while a specific instance renders FIXED 264×48: screens-first captures 264×48.

**R33** Single library touch. The library fileKey is resolved exactly once (from any icon `componentKey` → `GET /v1/components/<key>`) and used only to batch-export the icons page via `GET /v1/images/<libraryFileKey>`. No master enumeration, no per-component library traversal. Everything else is screens.

## Strategy

**R34** Build strategy selectable at setup. Two modes recorded in `meta.strategy.mode`:
- `full` — parallel batches (Phase C components cap 4, Phase D screens cap 2). Fixes deferred to post-build `/fix`.
- `screen-by-screen` — sequential per-screen with component-per-screen prebuild (R37) + auto-fix loop (R35/R36).
Default for new audits: `screen-by-screen`. Legacy contracts missing `meta.strategy` are read as `full` (backward compat). Agents MUST branch on `meta.strategy.mode` — never hard-assume one flow.

**R35** Auto-fix loop cap = `meta.strategy.fixCap` (default 3) per screen. After N iterations below `autoFixThreshold`, orchestrator halts the fix loop, writes diagnostic to `build-log.json`, and advances to the next screen. Never blocks the overall build. Verifiable: count of `fixIterations` per screen in `build-log.json` ≤ `fixCap`.

**R36** Auto-fix trigger threshold = `meta.strategy.autoFixThreshold` (default 0.90). After initial screen validate:
- fidelity ≥ threshold → advance without fix.
- fidelity < threshold → invoke `/fix` flow in `mode=auto` (bypasses Phase D Confirm). Re-validate; repeat until ≥ threshold OR R35 cap reached.
Verifiable: no auto-fix iterations logged when fidelity ≥ threshold on first validate.

**R37** Component-per-screen ordering (screen-by-screen mode only). For each screen in `meta.strategy.screenOrder`:
1. Resolve every `mainComponentKey` in the screen's enriched tree (recursive walk).
2. Map keys → component names via `components/*.yml` `mainComponentKey` field.
3. Build only components not-yet-built (dedup across earlier screens). Batch cap 4 within same tier (library-wrapped → leaf → composite).
4. Proceed to screen build. Components are validated only via the screen validate (R18) — no standalone component validate pass.
A component shared across N screens is built exactly once. Verifiable: `build-log.json` `components[].builtForScreen` stamps first-build owner; subsequent screens list reused components under `reusedComponents[]`.

**R38** Fix batch-then-tune. `/fix` Phase E splits plan rows by `class`:
- `geometric` (spec-derived: spacing/dimensions/color tokens/typography) — batched; all edits applied then ONE `validate.mjs --fast` run (E.1).
- `empirical` (filters, brightness, anti-aliasing — no closed-form answer) — inner tweak loop, cap 3 cycles per row, cap 2 rows per outer iteration (E.2).
Diagnostic 4×4 grid-diff captured ONCE per outer iteration and reused for every L5/fidelity row in Phase B. Total Playwright invocations per outer fix iteration ≤ 8. Verifiable: FIXLOG entry cites ≤8 validate runs per outer iteration; `class` column present on plan table.
