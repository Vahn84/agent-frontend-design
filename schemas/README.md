# Schemas

JSON Schema files for the design contract. Shipped with the plugin. Enforced by `scripts/prepare-build.mjs`.

## Contract layout

```
design-contract/
  meta.yml              → meta.schema.json
  tokens.yml            → tokens.schema.json
  typography.yml        → typography.schema.json
  icons.yml             → icons.schema.json
  components/
    <name>.yml          → component.schema.json
  screens/
    <name>.yml          → screen.schema.json
```

## Rule mapping

| Schema constraint | Enforces |
|-------------------|----------|
| `component.variants` min=1, per-variant reference | R1, R8 |
| `icons.source.fileKey` | R2 |
| `icons.icons[].vectorNodeId` required | R2 (export vector child) |
| `screens[].mockData` required | R3 |
| `component.variants[].colors` = token refs only | R6, R15 |
| `component.variants[].layoutSizing` + `dimensions` | R7, R19 |
| `component.classification.kind = library-wrapped` → `libraryComponent` required | R9 |
| `component.icons[].visibleSizePx` required | R12 |
