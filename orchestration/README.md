# Orchestration overlays

Canonical pipeline lives in:
- `agents/*.md` — role instructions (Claude-native tool invocations)
- `schemas/*` — contract shape
- `scripts/*` — Node CLI (tool-agnostic)
- `RULES.md` — numbered rules

These overlays describe ONLY the glue per AI assistant: how to spawn sub-agents, how to batch parallel builds, how to invoke shell scripts, how to map Figma MCP capabilities to the assistant's integration.

| Assistant | File | Parallelism |
|-----------|------|-------------|
| Claude Code | `claude.md` | True parallel (Agent tool) |
| GitHub Copilot | `copilot.md` | Sequential |
| Amazon Kiro | `kiro.md` | Task primitives |
| Cursor | `cursor.md` | Sequential w/ composer |

Shared core never duplicated. Rule edits go in `RULES.md`. Protocol edits in `agents/*.md`.
