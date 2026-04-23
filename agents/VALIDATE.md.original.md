# Validate Agent

**Model:** Sonnet. Screen-level only (R18). Runs layered checks (R16). One agent per screen. Cap 1 concurrent (shared Playwright context for L5).

## Input
- Screen route (URL path on running dev server)
- Screen contract slice (`screen.yml` + every component it uses)
- Running dev server URL
- Figma `fileKey` + screen nodeId to compare against
- `.validate-cache/` path

## Layers (R16 — fail fast)

### L0 — Wrapper gate (R28)
Before any DOM check: `scripts/check-wrappers.mjs` over the files the screen imports. Any raw HTML primitive where a library wrapper is declared in contract = FAIL immediately.

### L1 — Structure
Playwright: load screen route. Parse full screen DOM. Build tree = `{ tag, className, childCount, dataName, dataComponent }`. From `client.getFileNodes(fileKey, [screenId])` → `transformNode`, build tree = `{ name, type, childCount }`. Match by name heuristic + spatial proximity (R20). FAIL if count mismatch on any level OR name similarity < 0.8 for a matched node. Errors are attributed to the hosting component (via `data-component` on the rendered root) so a failure points to *which* component regressed inside the screen.

### L2 — Layout (R19)
For each matched node: compare bounding box `{ x, y, width, height }` (DOM vs Figma). Tolerance ±2px. Also verify `layoutSizing`:
- FIXED → DOM computed width matches `dimensions.width` ±1px
- FILL → DOM width >= parent width * 0.99
- HUG → DOM width < parent width * 0.99

FAIL on any breach.

### L3 — Color
For each element with a fill/border in spec: read computed `background-color` / `color` / `border-color`. Resolve the CSS var chain to hex. Compare to expected hex (from `tokens.map[<colorToken>].value`). Exact match required. Raw hex in computed styles that doesn't resolve through a CSS var = FAIL (R15).

### L4 — Typography
For each text node: read computed `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`. Compare to `typography.styles[<textStyle>]`. Size ±1px, line-height ±1px, others exact.

### L13 — Image-aspect sanity (R52, opt-in)
Activated only via `--deep`. For every rendered `<img>`, compares native asset aspect ratio vs rendered bbox aspect ratio. FAIL when diff > 2% AND `object-fit` is `fill`/default AND className has no R29 crop hint (≥100% width/height or negative left/top offsets). Catches silent stretch regardless of upstream audit correctness.

### L11 — Node-level structural (R47, opt-in)
Activated only via `--deep`. For each `[data-component]` root in DOM, loads the variant spec from `design-contract/components/<Name>.yml` (shared registry R43) and compares computed CSS: padding (4 sides), gap (flex), border-radius, border-width, background color (token → hex), text color (token → hex), FIXED width/height (±1px). Emits per-component-per-property failures: `{ component, prop, actual, expected, detail }`. NOT run in the auto-validate loop — only during manual `/fix <screen>` Phase B diagnose.

### L10 — Token fidelity (R46)
Cross-verify Figma `tokens.yml` vs project `src/styles/tokens.css` + every `var(--x)` in src/. Delegates to `scripts/check-tokens.mjs`. FAIL on missing Figma token in CSS, value mismatch, unknown var (not in Figma + not internal-whitelisted), raw hex in non-tokens.css files. Warnings (never fail): hex inside `var(..., #hex)` fallback, orphan tokens.

### L5 — Pixel diff (R18)
- Screenshot at exact Figma frame `dimensions` × 2 DPR (R17)
- Fetch Figma reference via `client.getImages(fileKey, [screenId], { format:'png', scale:2 })` + `downloadUrl`, or `scripts/screenshot.mjs`
- Diff per-component bboxes inside the screen (data-component regions); unchanged regions composited from screenshot cache
- Threshold: 10 per channel
- FAIL if > 2% mismatched pixels in any bbox

## Incremental mode

Modes:
- `--fast` — L0–L4 + L5 (non-gating info). Fidelity score computed. Default.
- `--full` — L0–L4 + L5 (gating: fidelity <98% = FAIL).
- `--fast --skip-pixel` — L0–L4 only. L5 skipped entirely (no screenshot, no pixelmatch, no fidelity). Used by FIX.md E.1 geometric batch where fidelity score is not consumed.

### Hash-skip cache
Key = `sha256(readFile(screen_file) + JSON.stringify(screen_slice) + JSON.stringify(component_slices))`. If `.validate-cache/<key>.pass.json` exists → skip all layers + return PASS. Write on success.

### Screenshot cache
Per screen: `.validate-cache/shots/<screenName>.png`. Per-component regions inside the screen are sub-keyed by hash of that component's computed styles tree — only changed regions get re-diffed.

## Output
```json
{
  "target": "src/pages/login/Login.tsx",
  "screen": "login",
  "pass": true,
  "fidelity": 0.94,
  "layers": {
    "L0": "pass",
    "L1": "pass",
    "L2": "pass",
    "L3": { "fails": [{ "selector": ".btn[data-component=Button]", "expected": "#003087", "actual": "#0F3F90" }] },
    "L4": "pass",
    "L5": { "bboxes": [{ "name": "HeaderBar", "mismatchPct": 0.03 }] }
  },
  "failingComponents": ["Button", "HeaderBar"],
  "duration_ms": 2140
}
```

`failingComponents` drives the fix loop (R35/R36): orchestrator rebuilds those components + re-validates the screen.

## Forbidden
- Per-component validate pass (R18) — only screen-level.
- PASS from thumbnail (R17)
- Hardcoded selectors or class names (R20)
- Raw pixel threshold > 10 (R16 layer split)
- Skipping L5 on screens in `--full` runs
