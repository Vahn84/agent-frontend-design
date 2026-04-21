# Orchestration — Claude Code

Canonical pipeline = `agents/*.md` + scripts. This file documents Claude-specific glue. **REST-only** — no Figma MCP server.

## Prereq
- Claude Code CLI (supports Agent tool with `model` override)
- `FIGMA_PAT` in env or session
- Node ≥ 18.17, `npm install` done

## Spawn sub-agents

Use the `Agent` tool:

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "Build <name>",
  prompt: <slice.agent_prompt from .build-slices/...>
)
```

## Parallel batching

Emit MULTIPLE `Agent` tool calls in ONE assistant message = true parallel. Caps:
- Components: 4 concurrent
- Screens: 2 concurrent (shared router state)
- Validate: 4 concurrent components, 1 screen at a time for L5

## Model assignment

| Role | Model |
|------|-------|
| Orchestrator (main conversation) | Opus |
| `audit` | Opus |
| `scaffold`, `build-component`, `build-screen`, `validate`, `sync-diff` | Sonnet |

## User interaction
- Setup questions → `AskUserQuestion`
- Progress → `TaskCreate` / `TaskUpdate`

## Figma capability mapping (REST)

| Capability | Implementation |
|------------|---------------|
| Read design (subtree) | `client.getFileNodes(fileKey, ids, { depth })` |
| Read node tree | same as above |
| Read tokens | `client.getLocalVariables(fileKey)` → `buildTokenMap` → per-node `resolveBoundVariables` |
| Screenshot | `client.getImages(fileKey, ids, { format:'png', scale:2 })` + `downloadUrl` (or `scripts/screenshot.mjs`) |
| Icon batch export | `client.getImages(libraryFileKey, vectorIds, { format:'svg' })` |
| Library lookup | `client.getComponent(componentKey)` → `file_key` |
| Image fill URLs | `client.getImageFills(fileKey)` |

Replaces `get_design_context`: `transformNode(rawNode, { tokenMap })` in `lib/transform.mjs` — deterministic enriched spec (`layoutSizing`, `dimensions`, `spacing`, `fills`, `tokenRefs`, ...).

## Shell scripts
Invoke via `Bash` tool: `node scripts/prepare-build.mjs --validate`, `node bin/cli.mjs ...`, etc. Normal stdin/stdout — agent reads output for decisions.

## Session wiring
`CLAUDE.md` (project root) loaded automatically on session start. No extra setup.
