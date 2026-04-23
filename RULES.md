# RULES

Numbered. Cited by ID. Loaded by orchestrator + every agent.

## Audit

**R1** Exhaustive per-node capture. Every descendant node in every target screen captured with full decoration: typography, color, align, spacing, dimensions, icons, imageFrames, children. One instance never enough — walk screen tree, don't enumerate master.

**R2** Icons from library file. Trace mockup instance → `componentKey` → library `fileKey`. Export full Icons page, not mockup subset. Export VECTOR child, not container (padding bakes into viewBox).

**R3** Mock data 1:1. Every text/ID/name/date/status/label visible in screen captured verbatim in `screen.mock_data`. No inventing.

**R4** `client.getFileNodes(fileKey, [screenId], { depth })` not filesystem guesses. REST returns full subtree under screen root — no Plugin API `childCount` pitfalls.

**R5** Never build from memory. Every node captured via `client.getFileNodes` + `transformNode` at screen level before writing code. Master-level reads are derivative — used only to resolve cluster display name, never decoration.

**R6** Token refs, not raw hex. Every color/spacing/radius/typography value stored as CSS var name resolved via `client.getLocalVariables` + `buildTokenMap` + per-node `boundVariables` walk (see `lib/tokens.mjs`). Raw hex in contract = audit incomplete. Requires Enterprise plan for Variables REST endpoint — non-Enterprise falls back to `node.styles` + manually-seeded tokens.

## Contract

**R7** Complete-on-first-build. `layout_sizing`, `dimensions`, `gap`, `padding`, `radius`, `border`, typography all correct at audit time. Validation is verification, not repair.

**R8** Per-variant specs derived from observed instance shapes. Variants = instances grouped by `mainComponentKey` + dedup signature (hash of dimensions + colors + typography + icons + spacing + radius + border). Each variant records `instances: []` (list of source `{screenNodeId, instanceNodeId}`) for traceability. Not from master enumeration.

**R9** Library classification. Components flagged `library-wrapped` in `meta.yml` MUST use library wrapper on first build pass, not custom refactor.

## Build

**R10** One agent per component. One agent per screen. Orchestrator passes ONLY that slice. Agent prompt ≤2000 words.

**R11** Parallel where independent. Components with no deps build concurrently (cap 4). Screens cap 2 (shared router).

**R12** Webfont icon sizing. Webfont glyphs occupy inner 50% of viewBox. `font-size = visible_px * 2`, `line-height: 1`. Contract stores `visible_size_px` per icon usage.

**R13** Custom icons only. Never proxy with another glyph. Extend webfont OR fail loudly.

**R14** Library wrapper USED. If wrapper exists for primitive (table/toggle/checkbox), pages import and use it. No raw HTML equivalents. Validated by grep.

**R15** Tokens in code. Built CSS references project CSS var (e.g. `var(--color-surface-brand)`). No raw hex in component output.

## Validate

**R16** Layered. Run order: structure → layout → color → typography → pixel diff. Fail fast — skip later layers on earlier fail.

**R17** Full size only. Screenshots at Figma frame exact dimensions (2× DPR). No PASS judgments from thumbnails.

**R18** Validation is screen-level only. All layers (structure, layout, color, typography, pixel diff) run on assembled screens. No standalone per-component validate step — components exercised inside hosting screen's DOM. Component correctness enforced earlier by L0 wrapper gate (R28) + schema gates (R7, R19) at prepare-build time.

**R19** Layout_sizing gate. Every component AND every screen frame: FIXED/FILL/HUG enforced. FIXED needs dimensions, FILL has no fixed dim, HUG content-driven.

**R20** Generic. Validation scripts contain ZERO hardcoded component names, class patterns, or CSS expectations. Derived from Figma API + live DOM at runtime.

## Orchestration

**R21** No unrequested questions. Only ask what CLAUDE.md marks "always asked" (framework, project name, FIGMA_PAT, library). Default everything else.

**R22** Never ask to continue/stop. Deliverable is routed app. Build all components AND all screens without pause.

**R23** Never skip failed steps. Any tool/script failure → retry + diagnose. Never proceed past failure silently.

**R24** PAT required. Ask upfront. All Figma reads (metadata, variables, images, icons, components) go through `lib/figma.mjs` with `FIGMA_PAT` (env or passed). No MCP fallback — this fork is REST-only.

**R25** SVG normalization. Every exported icon passes `scripts/normalize-icons.mjs` + `--check`. Raw hex fill = fail.

**R26** Glyph verification. After webfont build, `scripts/verify-glyphs.mjs` compares rendered glyph to Figma reference. Size or shape mismatch = fail.

**R27** REST call cache. Audit persists `getFileNodes` responses per screen-root nodeId and single `getLocalVariables` response to `design-contract/.audit-cache/<nodeId>-<endpoint>.json`. Keyed by screen nodeId + endpoint — one cached blob covers entire descendant subtree. `lib/figma.mjs` also supports `{ cacheDir }` for raw-response caching. Reuse within run + on `/sync`.

**R28** L0 wrapper gate. `scripts/check-wrappers.mjs` runs BEFORE any validation layer. Any raw HTML primitive where wrapper is declared = fail + rebuild.

**R29** Preserve image crop percentages. When Figma reference code emits `<img>` with percentage width/height AND negative offsets (e.g. `w-[121.44%] h-[347.69%] left-[-10.72%] top-[-123.46%]`), capture those values verbatim in contract. Build must replicate — never replace with `object-fit: contain` or `width: 100%`. Collapsing crop loses pixel-accurate positioning, makes visual content look wrong (too small, wrong region visible).

**R31** Viewport-fit per screen. Every screen declares `viewportFit: fill | fixed-design | scale` (default fill). Figma root frames are always FIXED dimensions (Figma limitation) but represent DESIGN REFERENCE, not absolute output size. `fill` = root stretches to viewport, FIXED inner components keep Figma px, cover/sidebar with FILL vertical gets height:100%. `fixed-design` = root locked to spec.dimensions (kiosks, signage). `scale` = transform-scaled frame. Validate L2 branches per mode. L5 pixel diff skipped when `fill` AND viewport size != design size (pixel comparison meaningless at mismatched aspect).

**R32** Instance overrides win. Master is derived, not source. Any decoration visible on instance (text color, alignment, width override, nested icon child, per-instance spacing) captured at screen node level. Audit walks screen tree exhaustively — instance properties shadow master defaults. Master may be HUG while specific instance renders FIXED 264×48: screens-first captures 264×48.

**R33** Single library touch. Library fileKey resolved exactly once (from any icon `componentKey` → `GET /v1/components/<key>`) and used only to batch-export icons page via `GET /v1/images/<libraryFileKey>`. No master enumeration, no per-component library traversal. Everything else is screens.

**R39** Invisible nodes skipped. `transformNode` returns `null` for `node.visible === false` (cascades — no subtree emitted). Paint entries with `visible: false` dropped from `fills` and `strokes` (already applied to `effects`). `audit-index.mjs` and legacy `audit.mjs` skip top-level canvas children where `visible === false`. Designer unhides in Figma to include hidden draft screen/layer. `opacity: 0` NOT same — those remain because they still occupy layout.

**R40** Fix-loop diminishing-returns early exit. In addition to R35 hard cap, auto-fix loop exits early when `fidelity` delta between consecutive iterations < `meta.strategy.fixMinDelta` (default 0.005 / 0.5%). Screen entry in `build-log.json` records `halted: "diminishing-returns"` with final fidelity. Prevents wasted iterations on plateaus where further automated fixes yield no measurable gain. Verifiable: no fix iteration ever logs fidelity-delta below threshold without loop halting.

**R41** Classification precedence. Instance-cluster classification in `clusterComponents` by fixed precedence: (1) `design-contract/overrides.yml` manual rule matching `componentKey` or `nodeId`, (2) `@role=` or `@primereact=` tag in Figma component description, (3) name regex against `PRIMEREACT_MAP`, (4) structural heuristic (e.g. `looksLikeTable` — VERTICAL container w/ ≥2 HORIZONTAL rows, matching child counts ±1, row heights clustered), (5) `kind: custom` fallback. Any cluster falling through to (5) but matching structural heuristic gets flagged in `design-contract/pages/<slug>/review.yml` under `suspected[]` with concrete `action` (add override, rename component, or tag description). `classification.via` records which precedence level won. Verifiable: review.yml exists whenever table-shape clusters classify as custom.

**R42** Fix-agent context budget. FIX agent input limited to: TOP 200 lines of `<project>/FIXLOG.md`, one screen build-slice (not verbose pre-slice), component slices ONLY for `failingComponents[]` plus direct deps, source files ONLY as named in current plan row, exactly ONE grid-diff image captured at Phase B start and reused. Target ≤30K first-turn input tokens. If plan exceeds budget, split into multiple outer fix iterations rather than loading more context. Verifiable: FIX agent invocations never attach more than one grid-diff; never read component slices not in `failingComponents[]`.

**R49** Information-preservation gate. `transformNode` + `cleanTree` + `buildVariant` MUST NOT silently drop any non-default Figma field. For every field read, handling is explicit: emit, downgrade, or record-drop via `recordDrop({nodeId, nodeName, field, rawValue, reason})`. Drops accumulate into `design-contract/pages/<slug>/review.yml` under `dropped_fields[]`. Build agents treat any `dropped_fields[]` entry as BLOCKER unless user explicitly acks via `design-contract/overrides.yml` `acked_drops[]`. Per-field handlers (e.g. imageTransform derivation in `deriveImageCrop`, fill/stroke hex-fallback R48) extend coverage; any path using magic default like hardcoded `100/100/0/0` is a violation. Verifiable: grep audit-page.mjs for literal `100, 0` in imageFrame emit returns zero hits.

**R50** Raw↔contract completeness diff. `scripts/check-contract-completeness.mjs` walks every cached raw Figma response (`design-contract/.audit-cache/raw/`) + every contract node, runs detectors for high-risk fields (`imageTransform ≠ identity`, `opacity < 1`, `rotation ≠ 0`, `blendMode != NORMAL|PASS_THROUGH`, `strokeDashes`, `layoutGrids`, `textAlignVertical != TOP`, non-default `constraints`). Any field present in raw but missing or default in contract = silent drop → exit 1. Runs automatically after `audit-page.mjs` (TODO: wire) OR standalone as CI gate. Detectors extend easily — add `{ field, detect, contractHas }` entry. Verifiable: fresh `node scripts/check-contract-completeness.mjs` prints `PASS` on compliant audit.

**R51** Schema strictness. Every schema under `schemas/*.json` sets `additionalProperties: false` at every object depth. Any unknown field propagating through contract trips `prepare-build.mjs --validate`. Flags Figma API drift (new fields) and agent/script bugs (renamed fields). TODO: currently only 4/7 schemas comply at root; deep refactor queued.

**R52** Image-aspect sanity (L13, opt-in via `--deep`). For every rendered `<img>` in screen, compare native asset aspect ratio vs rendered bbox aspect ratio. Diff > 2% AND `object-fit` is `fill`/default AND no R29 crop hint in className (nontrivial pct ≥100% or negative offsets) → fail `img silent-stretch`. Catches aspect distortion at runtime regardless of audit correctness — independent last-line check. Skipped in auto-validate loop (per R47 opt-in policy). Verifiable: validate run against deliberately stretched image emits L13 fail.

**R47** Opt-in deep structural check (L11). Invoked only via `validate.mjs --deep`. Walks every `[data-component=X]` in DOM + finds variant spec in shared registry (`design-contract/components/<X>.yml`), compares computed CSS against variant fields: padding (4 sides), gap, border-radius, border width, background color (token → hex), text color (token → hex), FIXED width/height (±1px). Attribution per-component-per-property. NOT run in auto-validate loop (FIGMA-TO-CODE D.5 + FIX.md E.1/E.2) — added cost (~100ms per component) only justified during manual `/fix` triage. Orchestrator in interactive `/fix <screen>` SHOULD pass `--deep` during Phase B diagnose; auto mode (R34 screen-by-screen fix loop) MUST NOT. Verifiable: L11 only appears in `result.layers` when `--deep` is set.

**R46** Token fidelity check. `scripts/check-tokens.mjs` cross-verifies Figma `tokens.yml` vs project `src/styles/tokens.css` + every `var(--x)` reference across src/. Fails on: (a) Figma token absent from tokens.css, (b) value mismatch between Figma and CSS (color compared normalized hex, numbers compared numerically — `px` stripped), (c) `var(--x)` in source where `--x` is neither Figma token nor whitelisted internal (`--tw-*`, `--pr-*`, `--p-*`, `--radix-*`, `--crop-*`, `--slot-*`, `--component-*`), (d) raw hex in any src file outside tokens.css (hex inside `var(..., #fff)` fallback = warning only). Orphan tokens in tokens.css not referenced anywhere = warning. Runs as validate.mjs L10 + standalone script. Verifiable: on passing project, zero `[FAIL]` lines from `node scripts/check-tokens.mjs --contract <path> --src <proj>/src`.

**R45** No inline styles in built output. React `style={{...}}` prop + Angular `[style]=` binding FORBIDDEN in component + screen source. All styling lives in project's styling layer — Tailwind utilities (React+Tailwind), CSS Modules / `.module.scss`, or framework component styles (Angular+SCSS). Dynamic values that MUST vary at runtime (e.g. mock-driven width pct for R29 image crop, computed color from prop) use CSS custom properties set via `style` ONLY as token carriers (`style={{ '--crop-w': value }}`) — never as raw CSS properties like `width`/`color`/`padding`. Rationale: inline styles bypass token pipeline (R6/R15), break dead-code scanning, defeat `.module.scss` encapsulation, blur which values are spec-derived vs agent-invented. Verifiable: `grep -r "style={{" src/` returns only entries setting CSS custom properties (`--*`) or empty string placeholders; no raw `width`, `height`, `color`, `background`, `padding`, `margin`, `border`, `display`, `flex*`, `position`, `top`, `left`, `right`, `bottom`, `z-index`, `filter`, etc.

**R44** Never tune image color via CSS filters. Fix loop MUST NOT apply `filter: brightness(...)`, `contrast(...)`, `saturate(...)`, `hue-rotate(...)` or any compound variant to `<img>` / `imageFrame` elements to close L5 pixel gap. Rationale: residual mismatch between Figma PNG export and browser-rendered JPEG/PNG is intrinsic floor driven by ICC profile, gamma, codec differences — not fixable design defect. Tuning via filter overcompensates in surrounding cells, produces visually wrong images. Residual counts toward accepted floor. If only open issue is image-region L5 mismatch, FIX exits with `halt: image-floor` regardless of R40 delta. Verifiable: no `filter:` property appears on `<img>` or `imageFrame` elements in built output.

**R43** Shared component registry. After per-page audit (A2) completes for every page in scope, `scripts/consolidate-components.mjs` runs once to produce `design-contract/components/` — canonical cross-page component registry. Fingerprint-based merge collapses duplicates (same shape, different colors/icons become new variants on same component). Single-vector tight containers (≤56×56 square, one icon, no text) promote to single `IconButton` regardless of fingerprint variance. `index.yml` maps every `mainComponentKey` in file to canonical component name. `prepare-build.mjs` + build agents read from shared registry when present, falling back to per-page `design-contract/pages/<slug>/components/` only for pages not yet consolidated. Per-page files stay in place for traceability. Verifiable: `components/index.yml.mainComponentKeyToName` present; no two keys map to different canonical names.

## Strategy

**R34** Build strategy selectable at setup. Two modes recorded in `meta.strategy.mode`:
- `full` — parallel batches (Phase C components cap 4, Phase D screens cap 2). Fixes deferred to post-build `/fix`.
- `screen-by-screen` — sequential per-screen with component-per-screen prebuild (R37) + auto-fix loop (R35/R36).
Default for new audits: `screen-by-screen`. Legacy contracts missing `meta.strategy` read as `full` (backward compat). Agents MUST branch on `meta.strategy.mode` — never hard-assume one flow.

**R35** Auto-fix loop cap = `meta.strategy.fixCap` (default 3) per screen. After N iterations below `autoFixThreshold`, orchestrator halts fix loop, writes diagnostic to `build-log.json`, advances to next screen. Never blocks overall build. Verifiable: count of `fixIterations` per screen in `build-log.json` ≤ `fixCap`.

**R36** Auto-fix trigger threshold = `meta.strategy.autoFixThreshold` (default 0.90). After initial screen validate:
- fidelity ≥ threshold → advance without fix.
- fidelity < threshold → invoke `/fix` flow in `mode=auto` (bypasses Phase D Confirm). Re-validate; repeat until ≥ threshold OR R35 cap reached.
Verifiable: no auto-fix iterations logged when fidelity ≥ threshold on first validate.

**R37** Component-per-screen ordering (screen-by-screen mode only). For each screen in `meta.strategy.screenOrder`:
1. Resolve every `mainComponentKey` in screen's enriched tree (recursive walk).
2. Map keys → component names via `components/*.yml` `mainComponentKey` field.
3. Build only components not-yet-built (dedup across earlier screens). Batch cap 4 within same tier (library-wrapped → leaf → composite).
4. Proceed to screen build. Components validated only via screen validate (R18) — no standalone component validate pass.
Component shared across N screens built exactly once. Verifiable: `build-log.json` `components[].builtForScreen` stamps first-build owner; subsequent screens list reused under `reusedComponents[]`.

**R38** Fix batch-then-tune. `/fix` Phase E splits plan rows by `class`:
- `geometric` (spec-derived: spacing/dimensions/color tokens/typography) — batched; all edits applied then ONE `validate.mjs --fast` run (E.1).
- `empirical` (filters, brightness, anti-aliasing — no closed-form answer) — inner tweak loop, cap 3 cycles per row, cap 2 rows per outer iteration (E.2).
Diagnostic 4×4 grid-diff captured ONCE per outer iteration and reused for every L5/fidelity row in Phase B. Total Playwright invocations per outer fix iteration ≤ 8. Verifiable: FIXLOG entry cites ≤8 validate runs per outer iteration; `class` column present on plan table.

**R53** Deterministic frame CSS codegen. Spec-derivable CSS properties MUST be emitted by script (`prepare-build.mjs` or dedicated `emit-frame-css.mjs`), NOT by build-screen/build-component LLM agents. Per frame/instance/text node, deterministic emitter writes class in prebuilt `.module.css` capturing: `display: flex`, `flex-direction` from `direction`, `gap` from `spacing.gap`, `padding` from `spacing.padding*`, `align-items` from `alignItems`, `justify-content` from `justifyContent`, `border-radius` from `radius`, `border` from `border`, `background-color` from `colorToken`, `width`/`height` from `dimensions` when `FIXED`, `flex:1` or `width:100%` when `FILL`, `color` + typography class for text nodes. Build agent receives prebuilt `.module.css` in slice under `slice.prebuiltCss`. Agent prompt forbids writing frame-level properties — only JSX composition, class references, prop API, component dispatch, mock binding, image handling, icon dispatch. LLM freedom to silently drop spec fields becomes impossible at source. Validate + fix loop become second line of defense, not primary enforcement. Verifiable: slice JSON contains `prebuiltCss` string field; grep agent-generated `.module.css` confirms zero `gap:`, `padding:`, `border-radius:`, `flex-direction:` written by agent (only `composes` + compositional rules) — all structural properties live in prebuilt module.

**R54** Skip redundant final validate when fix loop halted. Phase E final `validate.mjs` run is skipped whenever a screen halted inside fix loop (any `halted` flag in `build-log.json` `screens[].halted`). Fix agent's last internal validate in FIXLOG is authoritative — re-running validates the same build against the same state and burns 30-60s + context for no new data. Phase E validate runs only when: (a) screen passed initial validate without entering fix loop, or (b) dev server restarted between fix-end and Phase E (state could differ). Verifiable: for any screen with `halted` flag, `build-log.json` timestamps show zero additional validate invocations between fix-end and next-screen-start.

**R55** Fix-loop context pre-warm. Before spawning fix agent, orchestrator pre-captures: (a) live screenshot at viewport dims via Playwright, (b) figma reference screenshot (if missing from `.validate-cache/shots/`), (c) 4×4 grid-diff ranking (top-3 mismatch cells) via helper script. Paths + grid-diff JSON passed to fix agent in initial prompt. Agent starts from diagnosis using cached artifacts, not setup. Target iter-1 duration ≤ 3 min, iter-2 ≤ 2 min for small geometric plans. Playwright browser re-launched per-iteration is the bottleneck — pre-warm eliminates first-iter setup tax. Verifiable: fix agent prompt contains paths to pre-captured artifacts; agent's first tool call is not Playwright launch.
