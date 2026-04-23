# Figma → Code Workflow

Orchestrator recipe. Executed by the main conversation (Opus).

**Prereq:** `FIGMA_PAT` set (env or passed to `createClient`). REST reachable (`client.me()` smoke check).

## Phases

### A. Audit — two stages

#### A1. Index (cheap, always run first)
Run `scripts/audit-index.mjs` directly (no subagent — it's a tight script). Produces `design-contract/index.yml` listing every page and every ≥1280px screen. Validate via `node scripts/prepare-build.mjs --validate-index`.

```bash
FIGMA_PAT=... node scripts/audit-index.mjs --url <figma-url>
node scripts/prepare-build.mjs --validate-index
```

Orchestrator then reads `index.yml` and picks a page:
- Only one non-empty page → auto-pick.
- Multiple non-empty pages → AskUserQuestion with page names + screen counts.
- Figma URL includes `?node-id=<pageId>` → auto-pick that page.

#### A2. Page deep audit (per chosen page)
Spawn `AUDIT.md` PAGE mode agent (Opus). Walks every screen in the chosen page, derives components from instance clusters within that page, writes `design-contract/pages/<pageSlug>/`.

→ `scripts/prepare-build.mjs --validate --page <pageSlug>` must pass.

Additional pages? Loop back to A2 with the next chosen page. Each page contract is self-contained. Cross-page component dedup is NOT performed.

### B. Scaffold
Spawn `SCAFFOLD.md` agent (Sonnet). Project skeleton + tokens + typography + webfont + stub routes.
→ Dev server must boot.

### C. Build components

Branch on `meta.strategy.mode` (R34). Missing `meta.strategy` → treat as `full` (legacy).

All slice + validate commands in Phase C/D/E implicitly scope to the active page via `--page <pageSlug>`. Orchestrator passes `--page` on every `prepare-build.mjs` and `validate.mjs` invocation for the active page.

#### Mode: full
Current behavior. `node scripts/prepare-build.mjs --slice components --page <slug>` produces per-component slice JSON in `.build-slices/<pageSlug>/components/<name>.json`. Each slice includes `agent_prompt` ready to pass directly. Components are derived from instance clusters — each variant's `instances: []` traces back to its source screen(s).

**Order:** (1) library-wrapped primitives first (R9), (2) leaf components, (3) composite components.

**Batch pattern (R11, cap 4):** orchestrator emits ONE assistant message containing up to 4 `Agent` tool calls. For each:
- `subagent_type: "general-purpose"`
- `model: "sonnet"`
- `prompt: <slice.agent_prompt>`

Wait for all returns. No per-component validate pass (R18) — component correctness is enforced pre-build (schema gates) and post-screen-build (via screen validation). Components that fail a screen validate are rebuilt in the fix loop. R23 still applies to any agent failure.

#### Mode: screen-by-screen
Phase C is **DEFERRED**. Components are built inside Phase D, per-screen, via the component-per-screen ordering (R37). Do NOT pre-slice all components. Initialize an in-memory `builtComponents: Set<string>` to track dedup across screens.

### C-pre. Classification + drop review (R41, R49)

Before Phase C/D, orchestrator reads `design-contract/pages/<slug>/review.yml` if present.
- `suspected[]` (R41) — structurally-table clusters classified `custom`. Surface w/ suggested actions; DO NOT block — user may accept current classification.
- `dropped_fields[]` (R49) — non-default Figma fields that couldn't be derived into the contract. **BLOCKS** the build. Each entry names the node + field + raw value + reason. Resolve by (a) extending the relevant audit handler, (b) fixing the Figma source, or (c) acking via `design-contract/overrides.yml` `acked_drops[]`. Print every entry to the user + exit if any unacked.
- Also run `node scripts/check-contract-completeness.mjs --page <slug>` (R50). Exit non-zero blocks build.
After user fixes Figma or writes `overrides.yml`, re-run the page audit (A2) to pick up the changes.

### C-pre2. Consolidate components (R43)

After every in-scope page completes A2 and BEFORE Phase C/D, run `node scripts/consolidate-components.mjs` ONCE. This produces `design-contract/components/` (shared registry) by fingerprint-merging duplicate clusters across pages and promoting icon-button shapes to a single `IconButton`. Output includes `index.yml` w/ `mainComponentKeyToName` map + `consolidation-log.yml` audit trail. Skip this step only when working on a single page AND no prior pages are present. Report: `X → Y components (Z merged, W promoted)`.

### D. Build screens

Branch on `meta.strategy.mode` (R34).

#### Mode: full
Current. `node scripts/prepare-build.mjs --slice screens` produces per-screen slices. Each slice embeds the enriched tree verbatim — build-screen agent never reaches back to Figma (R5). Halt if any `screen.mockData` missing (R3 gate — prepare-build will fail loudly).

**Batch pattern (cap 2):** one assistant message with 2 `Agent` calls (model: sonnet), each receiving `slice.agent_prompt`. After both return: run `node scripts/validate.mjs --target <file> --spec <slice> --url <dev> --full` per screen (includes L5 pixel diff). Rebuild failures before next batch.

#### Mode: screen-by-screen
Sequential. Iterate `meta.strategy.screenOrder` in listed order (AUDIT writes Figma left-to-right X-sort by default; user override allowed).

For each `screen` in order:

1. **Resolve needed components (R37).** Run `node scripts/prepare-build.mjs --slice components --for-screen <screen>` — writes only the component slices referenced by this screen's enriched tree (`mainComponentKey` → component name). Slice filenames are stable (`<component>.json`) so dedup is by filesystem presence + `builtComponents` set.
2. **Build components.** For each slice not in `builtComponents`: batch cap 4, same order tiers as full mode (library-wrapped → leaf → composite). One `Agent` call per slice. Add built names to `builtComponents`. If already in `builtComponents` (reused), skip + log under `reusedComponents[]`. No per-component validate (R18).
3. **Slice screen.** `node scripts/prepare-build.mjs --slice screens --order <screen>` — writes this one screen slice.
4. **Build screen.** ONE `Agent` call (model: sonnet) with `slice.agent_prompt`.
5. **Validate screen full.** `scripts/validate.mjs --target <screen-file> --spec <slice> --url <dev> --full` (L0 wrapper gate + L1–L5). Record `fidelity`. Component regressions surface here — a screen failure whose root cause is a specific component triggers that component's rebuild in the fix loop.
6. **Auto-fix loop (R35/R36/R40).** If `fidelity < meta.strategy.autoFixThreshold`:
   - Invoke `/fix <screen>` in `mode=auto` (see `agents/FIX.md` Modes). Auto mode bypasses Phase D Confirm — plan is derived from the 4×4 grid top-3 mismatch analysis and applied directly.
   - Each iteration: diagnose → edit → re-validate → append entry to `build-log.json` `screens[].fixIterations[]`.
   - Cap at `meta.strategy.fixCap` iterations. On cap hit OR fidelity ≥ threshold, exit loop.
   - **Early-exit (R40).** After any iteration, compare `fidelity` to previous iteration's. If delta < `meta.strategy.fixMinDelta` (default 0.005 = 0.5%) → mark loop `halted: diminishing-returns`, exit. Prevents burning iterations on plateaus.
7. **Advance.** Regardless of final fidelity (R22/R35 — never block), move to next screen. If capped below threshold, write a `halted: true` flag on the screen entry with the last diagnostic.
8. **Persist.** After every screen, overwrite `<project>/build-log.json` with fresh state (not append — full snapshot). Shape:
```json
{
  "mode": "screen-by-screen",
  "startedAt": "...",
  "screens": [
    { "name": "login", "fidelityInitial": 0.93, "fidelityFinal": 0.93, "fixIterations": [], "reusedComponents": [] },
    { "name": "elenco-pratiche", "fidelityInitial": 0.82, "fidelityFinal": 0.94, "fixIterations": [{"i":1,"fidelity":0.88,"fixes":["..."]},{"i":2,"fidelity":0.94,"fixes":["..."]}], "reusedComponents": ["Button","IconButton"] }
  ],
  "components": [
    { "name": "Button", "builtForScreen": "login", "reusedBy": ["elenco-pratiche","dettaglio"] }
  ]
}
```

### E. Final validate
`VALIDATE.md --full` on every route. Summary table.

### F. Report
Print final summary. Dev server URL. Validation pass/fail counts per screen.

## Gates (stop + fix, never skip per R23)
- Contract schema invalid → re-audit affected nodes
- Scaffold fails → fix before build
- L0 wrapper gate fails (raw HTML where wrapper declared) → rebuild offending component (R28)
- Screen validate L1–L4 fails → fix loop (R35/R36)
- Screen validate L5 fails >2% in any bbox → fix loop
- Any icon export null → re-export before proceeding (R23)

## Progress output (R21 concise)

### Mode: full
```
A. audit        ✓ tokens:11  type:8  icons:40  components:24  screens:9
B. scaffold     ✓ server:5173
C. components   ✓ 24/24 built (no per-component validate — R18)
D. screens      ✓ 9/9 (validate L0-L5 pass per screen)
E. validate     ✓ all routes pass
F. done         ~/Documents/DEV/aspi-app → http://localhost:5173
```

### Mode: screen-by-screen
```
A. audit        ✓ tokens:11  type:8  icons:40  components:24  screens:9  strategy:screen-by-screen
B. scaffold     ✓ server:5173
D. login           components:4/4  fidelity:0.94  ✓
D. elenco-pratiche components:+6 (4 reused)  fidelity:0.81 → fix×2 → 0.93  ✓
D. dettaglio       components:+3 (7 reused)  fidelity:0.88 → fix×1 → 0.92  ✓
...
E. validate     ✓ all routes pass
F. done         ~/Documents/DEV/aspi-app → http://localhost:5173
```
