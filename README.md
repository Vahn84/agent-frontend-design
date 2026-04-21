# Agent Frontend Design (REST)

Figma → Code pipeline, **REST-only**. Fork of `ai-frontend-agent` with all MCP calls replaced by `lib/figma.mjs` (Figma REST) + `lib/transform.mjs` (deterministic node → spec transformer).

## What it does

1. **Audit** a Figma file → structured `design-contract/` (tokens, typography, icons, components, screens)
2. **Scaffold** a React or Angular project from the contract
3. **Build** each component and screen via sub-agents (parallel where supported)
4. **Validate** pixel fidelity layer-by-layer (structure → layout → color → typography → pixel diff)
5. **Sync** subsequent Figma changes back into code
6. **Wire** custom components into a library (e.g. PrimeReact, shadcn)

## Why REST (not MCP)

- **Deterministic.** `transformNode` produces the same spec every run. No LLM drift in the middle of the pipeline.
- **No plugin dep.** Works from any environment with `FIGMA_PAT` + network.
- **Cacheable.** Raw REST responses serialize cleanly; cache is just JSON on disk.
- **Bulk-friendly.** Screen subtree + library icons page in ~3 calls each.

Trade-off: **no writes.** `/code-to-figma` and `/code-connect` are dropped in this fork. `/wire-library` stays (code-side work).

## Prerequisites

- Node ≥ 18.17 (native `fetch`, `node --test`)
- `npm install` inside this repo
- `FIGMA_PAT` (Figma personal access token) — https://www.figma.com/settings/security
- **Enterprise plan** for `/v1/files/:key/variables/local` (token resolution). Non-Enterprise fallback: manually-seeded `tokens.yml` + `node.styles` refs.
- Playwright browsers for validation: `npx playwright install chromium`

## Quick start

```bash
npm install
FIGMA_PAT=figd_xxx node bin/cli.mjs me
FIGMA_PAT=figd_xxx node bin/cli.mjs node 'https://www.figma.com/design/KEY/Name?node-id=1-2'
FIGMA_PAT=figd_xxx node bin/cli.mjs tokens 'https://www.figma.com/design/KEY/Name'
```

Or run the orchestrator: open Claude Code in this repo, say "hi", pick a workflow.

## CLI

```
node bin/cli.mjs me                                     auth check
node bin/cli.mjs raw <url>                              raw Figma node JSON
node bin/cli.mjs node <url>                             transformed enriched spec
node bin/cli.mjs image <url> [--format=png|svg] [--scale=2] [--out=file]
node bin/cli.mjs tokens <url>                           token map from variables/local
node bin/cli.mjs components <url>                       file components
node bin/cli.mjs styles <url>                           file styles
```

Flags:
- `--cache <dir>` — on-disk cache for raw REST responses
- `--depth <n>` — limit descendant levels

## Workflows

| Command | Protocol file | Purpose |
|---------|--------------|---------|
| `/design` | — | Show menu |
| `/figma-audit` | `agents/AUDIT.md` | Figma → `design-contract/` |
| `/figma-to-code` | `agents/FIGMA-TO-CODE.md` | Contract → full app |
| `/create-app` | `agents/CREATE-APP.md` | No-Figma greenfield |
| `/sync` | `agents/SYNC.md` | Diff + apply changes |
| `/validate` | `agents/VALIDATE-WORKFLOW.md` | Check fidelity, write FIXLOG |
| `/fix` | `agents/FIX.md` | Parse FIXLOG → plan → confirm → fix → re-validate |
| `/ds-rules` | `agents/DS-RULES.md` | Emit rules.md |
| `/wire-library` | `agents/WIRE-LIBRARY.md` | Replace custom w/ library |

## Architecture

```
.
├── CLAUDE.md                 orchestrator entry
├── RULES.md                  numbered rules R1..R37
├── ARCHITECTURE.md           data flow + validation layers
├── REST-REFERENCE.md         Figma REST endpoint map + MCP xref
├── bin/cli.mjs               smoke CLI
├── lib/                      figma.mjs, transform.mjs, tokens.mjs, url.mjs
├── agents/                   role + workflow protocols
├── schemas/                  JSON Schema contract shape
├── scripts/                  Node CLI (prepare-build, validate, etc.)
├── standards/                React / Angular / Testing best practices
├── templates/                scaffold templates
├── test/                     node --test smoke
└── design-contract/          (generated) audit output
```

### Key rules (summary)

- R1 exhaustive variant scan
- R3 mock data 1:1 Figma (no inventing)
- R6 tokens only, no raw hex
- R10 one agent per component, ≤2000 word prompts
- R14 library wrappers USED, not just built
- R19 layoutSizing enforced (FIXED/FILL/HUG)
- R23 never skip failed steps
- R24 FIGMA_PAT required, all Figma reads via `lib/figma.mjs`
- R27 REST call cache (per screen root)
- R33 single library touch (one `getComponent` → `file_key` → icons page export)

Full list in `RULES.md`.

## Scripts

```bash
npm test                        # node --test
npm run validate-contract       # schema + rule gates
npm run slice components        # per-agent JSON slices
npm run slice screens
npm run validate -- --target <file> --spec <slice> --url <dev> --fast
npm run normalize-icons -- --dir <svg-dir> [--check]
npm run check-wrappers -- --contract design-contract --src <app>/src
npm run verify-glyphs -- --url <dev>
npm run screenshot -- --file-key <k> --node <id> --out <path> --pat <PAT>
```

## License

Proprietary. Internal use by TechEdge Labs / Avvale. Not for external distribution.
