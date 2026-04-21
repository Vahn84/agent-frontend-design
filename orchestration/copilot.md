# Orchestration — GitHub Copilot (Agent Mode / Workspace)

Canonical pipeline = `agents/*.md` + scripts. This file documents Copilot-specific glue.

## Prereq
- VS Code + GitHub Copilot Chat/Agent extension
- Figma MCP configured in VS Code (Copilot Chat MCP support, 2025+) OR Figma REST API with `FIGMA_PAT` env var
- Node ≥ 18, npm install done

## No native sub-agents
Copilot runs a single chat loop. Parallelism is NOT available. Build components SEQUENTIALLY, one per turn.

## Loop pattern

Instead of Claude's "spawn N agents", loop over slice files:

```
Step 1: Read .build-slices/components/Button.json
Step 2: Follow its agent_prompt exactly → write component files
Step 3: Run validate --fast on the just-built component
Step 4: Repeat for next slice
```

Tell Copilot: "For each file in .build-slices/components/, read it, execute the agent_prompt, then run validate on the output."

## Model assignment

Copilot's Agent mode uses whatever model the user picked (typically Claude 4.6 Sonnet or GPT-5). No per-call override. Mixing Opus/Sonnet not possible — pick the strongest model for everything.

## User interaction
- Setup questions → plain chat
- Progress → markdown checklist the agent maintains in the chat

## Figma mapping

If Copilot has Figma MCP:
- `get_design_context`, `get_metadata`, `get_variable_defs`, `get_screenshot` — use Copilot's MCP invocation syntax (`@workspace /figma ...` or tool name)

If no MCP:
- Use Figma REST `GET /v1/files/<fileKey>` + `GET /v1/images` + `GET /v1/variables/...` with `FIGMA_PAT`. Audit prompts cover what to fetch.

## Shell scripts
Invoke via terminal tool: `node scripts/prepare-build.mjs --validate`. Copilot Agent can run commands in integrated terminal.

## Session wiring
Copilot doesn't auto-load project docs. On session start: tell Copilot "read CLAUDE.md and RULES.md to understand the workflow, then follow them."

## Expected vs Claude
- ~4× slower on component build phase (serial vs cap-4 parallel)
- Equivalent fidelity (prompts identical)
- More chat turns needed
