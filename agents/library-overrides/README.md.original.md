# Library overrides

Per-library guidance for wiring custom components to library equivalents while preserving Figma fidelity.

Each file describes:
- Component catalog (what library offers, name → role)
- Install imports
- Style override mechanism (theme / CSS vars / pt / sx / styled)
- Concrete override snippets for common wrappers
- Known fidelity traps

`WIRE-LIBRARY.md` loads the relevant file before emitting any wire plan.

## Supported libraries

| Library | File | Status |
|---------|------|--------|
| PrimeReact | `primereact.md` | ✓ |
| MUI | `mui.md` | TODO |
| AntD | `antd.md` | TODO |
| Chakra | `chakra.md` | TODO |
| PrimeNG (Angular) | `primeng.md` | TODO |

Adding a new library = one file here + one addition to `meta.schema.json` library enum (if we add one).
