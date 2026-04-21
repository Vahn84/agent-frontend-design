# Orchestration — Cursor

Canonical pipeline = `agents/*.md` + scripts. This file documents Cursor-specific glue.

## Prereq
- Cursor IDE (≥ 2025 version with Agent/Composer mode)
- Figma MCP via Cursor's MCP settings (`~/.cursor/mcp.json`) OR REST API with `FIGMA_PAT`
- Node ≥ 18, npm install done

## No native sub-agents
Cursor Agent mode is a single-threaded loop. No parallel sub-agent spawning. Run builds SEQUENTIALLY — one component per agent turn.

## Loop pattern
Same as Copilot:

```
1. Read .build-slices/components/<name>.json
2. Execute agent_prompt — write component files
3. Run validate --fast
4. Next component
```

Drive with a checklist in the agent instructions: "Build each component slice in order, run validate after each."

## Model assignment
Cursor selects model globally (Claude 4.6 Sonnet, GPT-5, Gemini 2.5, etc.). Pick the strongest available. No per-call override.

## User interaction
- Setup questions → Agent chat
- Progress → checklist maintained in conversation

## Figma mapping
In `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "figma": { "command": "npx", "args": ["@figma/mcp-server"] }
  }
}
```
Then MCP tool names match plugin:figma:figma namespace. Adjust per actual server name.

## Rules integration
Put `RULES.md` content into `.cursor/rules/*.mdc` files with `alwaysApply: true`. Rules auto-inject into every agent turn.

## Shell scripts
Agent mode runs commands directly. Invoke scripts in integrated terminal.

## Session wiring
Cursor auto-reads `.cursor/rules/*.mdc` + `CLAUDE.md` (as fallback context). No extra setup if rules are in the right dir.

## Expected vs Claude
- ~4× slower on builds (serial)
- Equivalent fidelity
- Strong at targeted edits via Composer (`@files`)
- Less throughput on multi-file component scaffolds
