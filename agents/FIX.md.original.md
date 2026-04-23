# Fix Workflow

Target: reduce open issues for one screen. Never fixes blindly — always plan + confirm.

**Prereq:** screen built + at least one validate run. `<project>/FIXLOG.md` populated.

## Modes

- **interactive** (default) — invoked by user `/fix <screen>`. Phase D Confirm is mandatory.
- **auto** (R34 screen-by-screen) — invoked by FIGMA-TO-CODE screen-by-screen workflow after a failing screen validate. Skip Phase D Confirm; apply the diagnosed plan directly. Caller caps iterations at `meta.strategy.fixCap` (R35) and only invokes when fidelity < `meta.strategy.autoFixThreshold` (R36).

Select mode via invocation argument. Interactive is default when unspecified.

## Context budget (R42)

Fix agents run hot on LLM turn time. Trim inputs aggressively:

1. **FIXLOG** — use `head -n 200 <project>/FIXLOG.md` (or equivalent tail-from-top read), not the whole file. Only the TOP entry is consumed in Phase A. Older entries waste tokens + confuse diff logic.
2. **Screen contract slice** — `.build-slices/screens/<screen>.json` ONLY. Do not read the raw `design-contract/pages/<slug>/screens/<screen>.yml` (verbose pre-slice form).
3. **Component slices** — ONLY slices for components in `failingComponents[]` (from last validate result) + direct deps. Ignore the full `builtComponents` set.
4. **Source files** — ONLY files listed in the plan's `file` column. No preemptive grepping of sibling components. Read the file when its row's edit runs — not before.
5. **Grid-diff image** — captured ONCE at start of Phase B, attached to the diagnostic message, reused for every L5/fidelity row. Never re-attach in subsequent turns.
6. **Spec sub-trees** — when inspecting a specific component's variant, read only that component's slice section, not sibling variants.

Target: first-turn FIX context ≤ 30K tokens. If the plan grows past that, split into two outer iterations rather than loading more.

## Phases

### A. Parse FIXLOG
Read TOP 200 lines of `<project>/FIXLOG.md` (newest-first ordering keeps the latest run at top). Extract TOP entry for target screen route (`/<screen>`). Collect `Still open` + `New` issues with their ids. Do not paginate further — anything older is handled by the previous fix cycle.

### B. Diagnose (per issue)

**Interactive mode only — run `validate.mjs --fast --deep` ONCE at Phase B start.** L11 (opt-in per R47) walks every `[data-component]` root + compares computed CSS vs variant spec: padding, gap, radius, border, bg/text colors, FIXED dims. Precise per-property attribution for every structural issue. Auto mode (R34) MUST NOT pass `--deep` — added cost unjustified when humans aren't triaging.

**Diagnostic screenshot budget: 1 grid-diff per outer fix iteration.** Take the 4×4 grid diff ONCE and reuse the ranking for every L5/fidelity row. Do NOT re-screenshot during Phase B after each read. Re-capture only in Phase F (revalidate) or Phase E.empirical (see below).

For each issue, determine root cause:

| Issue pattern | Diagnostic step |
|---------------|-----------------|
| `L2: fill ... vs viewport` | Read screen SCSS root → check width/height declaration |
| `L3: color` fails | Playwright inspect the element → read computed CSS → trace CSS var chain → find wrong hex or missing fallback |
| `L4: fontSize/fontWeight` fails | Compare computed vs spec typography → find wrong class or override |
| `L5: N% mismatch` | Use cached grid-diff (one screenshot, one pixelmatch pass, 4×4 ranking) → top 3 cells → inspect each region's DOM + source |
| `fidelity: <98` | Reuse L5 grid ranking — do not re-screenshot |
| `L1: missing components in DOM` | Grep screen source → confirm imports + usage |

Write diagnostic summary per issue.

### C. Plan
Emit table: issue id → root cause → **class** → target file(s) → proposed change (1–2 line summary).

**`class` column — batch routing (R38):**
- **`geometric`** — deterministic, spec-derived (spacing, padding, gap, width/height, flex sizing, layout direction, alignment, radius, border, color tokens, typography classes, element position). Answer readable from Figma spec or computed CSS. Fix once, move on.
- **`empirical`** — no closed-form answer from spec (CSS filters for image brightness/contrast deltas between Figma PNG export and browser JPEG render, subpixel font-rendering differences, anti-aliasing artifacts). Requires measure-tweak-measure.

Example:
```
| id | class | cause | file | change |
|----|-------|-------|------|--------|
| L5:5.25% | geometric | extra 8px gap in toolbar | src/pages/.../ElencoPratiche.module.scss:34 | gap: 16 → 8 |
| fidelity:<98 | geometric | off-by-4 padding in Sidebar | src/components/Sidebar/Sidebar.module.scss:12 | padding: 24 → 20 |
| L5:2.1%(img) | empirical | cover image brighter than Figma export | src/components/Cover/Cover.module.scss | filter: brightness(?) tune |
```

### D. Confirm

**Skip this phase if `mode=auto`** (R34, screen-by-screen workflow). Auto mode applies the Phase C plan directly — FIGMA-TO-CODE owns the iteration cap via R35.

Interactive only — `AskUserQuestion`:
- "Approve plan as-is" → proceed
- "Edit plan" → user pastes revised table
- "Cancel" → stop

### E. Implement (batch-then-tune — R38)

Two sub-phases. Run in order.

**E.1 Geometric batch.** Apply ALL `class=geometric` rows as Edits in one pass. No validate between edits. Coupled fixes (same region, stacked flex/position) are still geometric — the plan rows land together or not at all. After last geometric edit → single `validate.mjs --fast --skip-pixel` run (L5 skipped — structural/color/typography only; fidelity score not needed during batch).

If a geometric fix regresses another layer (new issue appears in FIXLOG), DO NOT attempt inline repair. Capture in report; let the outer fixCap iteration handle it (bisect-then-rebuild on next call).

**E.2 Empirical inner loop.** For each `class=empirical` row (max 2 per fix iteration):
- Start from spec-informed seed value.
- **Image-filter ban (R44):** NEVER apply `filter: brightness|contrast|saturate|hue-rotate` to `<img>` / `imageFrame`. If the only empirical row targets image tone, SKIP and classify as `halt: image-floor`.
- Inner cap: **3 tweak-validate cycles per row**. Use `validate.mjs --fast` (L5 REQUIRED here — empirical tuning reads pixel-diff to decide).
- Early exit: if L5 for the target region drops below 1% after a cycle, accept + stop.
- On cap hit without improvement: revert to seed + flag row in report as `unresolved-empirical`.

Total Playwright invocations per outer fix iteration ≤ 1 (diag) + 1 (geometric validate) + 2×3 (empirical) = **8 max**. Down from unbounded.

### F. Re-validate (final)
`node scripts/validate.mjs --target <screen-file> --spec <slice> --url <dev> --fast`

One final `--fast` validate (L5 runs — fidelity score recorded). ONLY needed if E.2 ran — otherwise E.1's validate is authoritative. Result appears in next FIXLOG entry. Fixed ids auto-detected via diff.

### G. Report
Print:
- fidelity before/after
- ids fixed
- ids still open (if any)
- next recommended action

## Rules
- R23 never skip failed diagnostics. Return error to user if cause can't be determined.
- Never touch more than the plan approves.
- Re-validate is mandatory — no "trust me, it's fixed".
- If a fix regresses another layer, FIXLOG shows it as "New" on next run.
- **R38 batch-then-tune.** Geometric fixes batch into ONE validate (E.1). Only empirical fixes (filters, brightness) run inner tweak loop capped at 3 cycles per row, 2 rows max per outer iteration (E.2). Playwright invocations per outer iteration capped at 8. Diagnostic screenshots cached — one grid-diff per outer iteration, reused across every row in Phase B.
- **R42 context budget.** Fix agents load only TOP 200 lines of FIXLOG, only screen slice (not raw spec), only component slices for `failingComponents[]`, only source files named in plan, single grid-diff image. First-turn context ≤30K tokens; split into multiple outer iterations if exceeded.
