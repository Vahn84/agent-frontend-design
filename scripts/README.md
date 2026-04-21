# Scripts

| Script | Purpose |
|--------|---------|
| `prepare-build.mjs --validate` | Validate `design-contract/` against JSON Schemas + rule gates |
| `prepare-build.mjs --slice components` | Write per-component slices to `.build-slices/components/` |
| `prepare-build.mjs --slice screens` | Write per-screen slices to `.build-slices/screens/` |
| `validate.mjs --target <file> --spec <slice> --url <base> [--fast\|--full]` | Run layered validation L1–L4 (fast) or L1–L5 (full). Hash-skip cache in `.validate-cache/`. |
| `screenshot.mjs --file-key <k> --node <id> --out <path> --pat <PAT>` | Download Figma reference screenshot for L5 pixel diff. |
| `normalize-icons.mjs --dir <svg-dir> [--check]` | Strip hardcoded fills → currentColor. `--check` fails on remaining hex. (R25) |
| `verify-glyphs.mjs --contract <dir> --url <dev>` | Render glyph in browser, pixel-diff vs Figma reference. (R26) |
| `check-wrappers.mjs --contract <dir> --src <app>/src` | Grep built files for raw HTML primitives where wrapper declared. (R28, R14) |

## Rule gates enforced by `prepare-build.mjs`

| Rule | Check |
|------|-------|
| R1 | `dataDrivenStyles` must cover every distinct mockData value for each mapped field |
| R3 | `screens[].mockData` non-empty |
| R6 | `component.variants[].colors` values are keys in `tokens.map` |
| R7 | FIXED layoutSizing → requires dimensions; FILL/HUG → forbids dimensions |
| R9 | `library-wrapped` classification requires `libraryComponent` |
| R12 | `component.icons[].visibleSizePx` required |

## Cache

- `.build-slices/` — per-agent spec slices (regenerated each run)
- `.validate-cache/` — hash-keyed pass records + screenshot cache
