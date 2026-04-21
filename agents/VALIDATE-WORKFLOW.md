# Validate Workflow

**Prereq:** `design-contract/` + codebase + dev server.

## Phases

### A. Dev server up?
Start if not running (`npm run dev` at project path). Wait for ready.

### A1. Wrapper check (R14, layer L0)
`node scripts/check-wrappers.mjs --contract design-contract --src <app>/src` → grep for raw HTML primitives where a library wrapper exists. FAIL here blocks all later layers — rebuild offending pages before proceeding.

### A2. Glyph verify
If `icons.yml` strategy=webfont: `node scripts/verify-glyphs.mjs --url <dev-url>` → FAIL on glyph mismatch (R13).

### B. Serial screen validate (full, R18)
For each screen route: spawn `VALIDATE.md --full`. Cap 1 at a time (single Playwright context preserves pixel cache). No per-component validate pass — `VALIDATE.md` attributes failing bboxes back to their hosting components via `data-component`, surfaced as `failingComponents` in the output.

### C. Report
Table:
```
SCREEN          L0  L1  L2  L3  L4  L5     VERDICT
/login          ✓   ✓   ✓   ✓   ✓   98.2%  PASS
/orders/list    ✓   ✓   ✓   ✗(2) ✓   91.1%  FAIL  (Button,HeaderBar)
```
For FAILs: print layer-specific diffs (selectors + expected vs actual) + `failingComponents` list.

### D. Next steps
If all PASS: done. If any FAIL: suggest `/fix <screen>` (auto loop rebuilds `failingComponents` + re-validates), or manual edit + re-run `/validate`.
