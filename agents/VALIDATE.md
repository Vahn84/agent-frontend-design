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

### L5 — Pixel diff (R18)
- Screenshot at exact Figma frame `dimensions` × 2 DPR (R17)
- Fetch Figma reference via `client.getImages(fileKey, [screenId], { format:'png', scale:2 })` + `downloadUrl`, or `scripts/screenshot.mjs`
- Diff per-component bboxes inside the screen (data-component regions); unchanged regions composited from screenshot cache
- Threshold: 10 per channel
- FAIL if > 2% mismatched pixels in any bbox

## Incremental mode

Default: `--fast` runs L0–L4 only, skips L5. Full mode `--full` includes L5.

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
