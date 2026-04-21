# Agent Frontend Design — Architecture

REST-only Figma → Code pipeline. Fork of `ai-frontend-agent` with MCP stripped out.

## Entry points (slash commands)

| Command | Purpose | Produces |
|---------|---------|----------|
| `/design` | Menu. Picks one below. | — |
| `/figma-audit` | Read Figma DS → contract | `design-contract/` |
| `/figma-to-code` | Contract → code | `src/`, routed app |
| `/create-app` | Scaffold + build from prompt (no Figma) | `src/`, reverse contract |
| `/sync` | Diff contract ↔ code, apply | patches |
| `/validate` | Check fidelity vs Figma | report |
| `/ds-rules` | Emit DS rules for codebase | `rules.md` |
| `/wire-library` | Replace custom w/ library components + preserve fidelity | wired components |

**Dropped from this fork:** `/code-to-figma`, `/code-connect` — Figma REST is read-only.

Each command = thin shim → loads agent instruction file.

## Agents (reusable roles)

| Agent | Model | Input | Output |
|-------|-------|-------|--------|
| Orchestrator (main) | Opus | user + contract | agent spawns |
| `audit` | Opus | Figma fileKey + page + PAT | `design-contract/*.yml` |
| `scaffold` | Sonnet | framework + name | project skeleton |
| `build-component` | Sonnet | ONE component spec slice | component file + stories |
| `build-screen` | Sonnet | ONE screen spec slice + built components | routed page |
| `validate` | Sonnet | built artifact + Figma node | pass/fail report |
| `sync-diff` | Sonnet | contract + code | change set |

Orchestrator slices contract per agent. No agent receives full contract.

## REST surface

All Figma reads go through `lib/figma.mjs`. See `REST-REFERENCE.md` for endpoint map.

Key calls per phase:
- **Audit.** `getFileNodes(fileKey, screenIds, { depth })` per screen · `getLocalVariables(fileKey)` once · `getImages(fileKey, iconIds, { format:'svg' })` batched · `getComponent(componentKey)` once (single library touch, R33) · `getFileImages(fileKey)` for image-fill refs.
- **Validate (L5 pixel diff).** `getImages(fileKey, screenId, { format:'png', scale:2 })` + `downloadUrl`.
- **Sync.** Re-run audit-phase calls, diff against current contract.

Transformer (`lib/transform.mjs`) converts raw node JSON → enriched spec (`layoutSizing`, `dimensions`, `spacing`, `fills`, `strokes`, `radius`, `effects`, `text`, `icon`, `imageFrame`, `tokenRefs`, `children`). Replaces the MCP `get_design_context` LLM code-gen — deterministic, no inference.

## Parallelism

Independent work → batch `Agent` calls in one assistant message.

| Phase | Parallel unit | Cap |
|-------|---------------|-----|
| Audit per screen | per screen REST call | 4 |
| Build components | per component | 4 |
| Build screens | per screen | 2 (shared router) |
| Validate screens | per screen | 1 (shared Playwright context for L5) |

Shared state via filesystem only (contract files + built files). No conversational cross-talk between siblings.

## Contract (schema)

```
design-contract/
  tokens.yml          # colors, spacing, radii, shadows, typography — with CSS var names
  typography.yml      # per text-style: font/size/weight/line-height/letter-spacing
  icons.yml           # per icon: node_id, name, visible_size_px, viewBox, export_path
  components/
    <name>.yml        # per-variant reference code, layout_sizing, dimensions, tokens refs
  screens/
    <name>.yml        # layout tree, component refs, mock_data, data_driven_styles
  meta.yml            # fileKey, framework, library choice, project paths, strategy
```

Schema enforced by JSON Schema + `scripts/prepare-build.mjs` gates.

## Data flow (figma-to-code)

```
Figma REST → audit → contract/ → prepare-build → per-agent slices → build-* agents → validate → report
   |                                                      ↓                 ↑
getFileNodes                                           parallel         pixel+layout+color+type
getLocalVariables
getImages
```

## Validation layers

1. **Structure** — DOM tree vs Figma frame tree (names, nesting, count)
2. **Layout** — positions ±2px, sizes ±2px, layout_sizing match
3. **Color** — exact hex from token map. Raw hex = fail
4. **Typography** — font/size/weight exact, line-height/letter-spacing ±1px
5. **Pixel diff** — threshold 10 (anti-alias only), LAST

Fail fast — don't run layer N+1 if N fails.

## Incremental validation (no speed hit)

Validation is screen-level only (R18). No standalone per-component validate pass.

| When | Layers | Scope | Cost |
|------|--------|-------|------|
| Pre-validate gate | L0 wrappers + schema | whole screen slice | <50ms |
| After screen assembly (DOM layers) | 1–4 | whole screen DOM | ~500ms |
| On screen completion (pixel diff) | 5 | changed regions only | ~2s |
| `/validate` full run | 0–5 | everything | full |

**Hash-skip cache:** `.validate-cache/<hash>.json` keyed by `sha256(screen_file + contract_slice)`. **Screenshot cache:** per-screen PNG kept; pixel diff compares only bboxes of changed component regions inside the screen.

## Repo layout

```
.
├── ARCHITECTURE.md       (this file)
├── RULES.md              (numbered rules, shipped)
├── CLAUDE.md             (orchestrator entry, slim)
├── REST-REFERENCE.md     (REST endpoint map, MCP→REST xref)
├── bin/cli.mjs           (smoke CLI for REST + transformer)
├── lib/                  (figma.mjs, transform.mjs, tokens.mjs, url.mjs)
├── commands/             (slash shims)
├── agents/               (role instructions, ≤80 lines each)
├── schemas/              (JSON Schema for contract)
├── scripts/              (prepare-build, validate-*, screenshot)
├── standards/            (REACT, ANGULAR, TESTING)
├── templates/            (scaffold templates per framework)
├── test/                 (node --test smoke tests)
└── orchestration/        (tool-specific glue overlays)
```

## Markdown style

- ≤80 lines per file
- Tables > prose
- No preamble/outro
- One concept per doc
- Numbered rules, not paragraphs
- Code blocks only when syntax is exact
