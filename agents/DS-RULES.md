# DS Rules Workflow

Generate implementation rules for a codebase. Used by Figma's `create_design_system_rules` OR as standalone `rules.md` shipped with the codebase.

## Phases

### A. Scan codebase
- Component inventory from `src/components/**`
- Token usage patterns
- Naming conventions (camelCase vs kebab-case for files, BEM vs CSS modules)
- Layout patterns (flex/grid usage)
- Test file conventions

### B. Derive rules
Emit `rules.md`:
```
## Tokens
- Colors ALWAYS via var(--color-*)
- Spacing ALWAYS via var(--space-*)

## Components
- One component per folder: <Name>.tsx + <Name>.module.scss + index.ts
- Stories required: <Name>.stories.tsx
- ...
```

### C. Figma upload (optional)
If Figma fileKey supplied: `create_design_system_rules` to register rules in Figma for designer reference.

### D. Report
Path to `rules.md` + Figma upload status.

## Reference
Base on `standards/REACT-BEST-PRACTICES.md` / `standards/ANGULAR-BEST-PRACTICES.md` — adapt to actual codebase conventions detected.
