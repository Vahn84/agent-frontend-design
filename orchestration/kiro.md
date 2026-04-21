# Orchestration — Amazon Kiro

Canonical pipeline = `agents/*.md` + scripts. This file documents Kiro-specific glue.

## Prereq
- Kiro IDE installed
- Figma MCP server configured in Kiro's MCP settings
- Node ≥ 18, npm install done

## Sub-agents via Kiro Tasks
Kiro has native task/spec primitives. Use Kiro's spec-driven workflow:

1. Create a spec file `specs/build.md` listing each component + screen as separate tasks.
2. Kiro auto-decomposes and runs tasks; use parallel execution where Kiro supports it.
3. Each task's prompt = contents of `.build-slices/components/<name>.json`.

## Parallel batching
Kiro's orchestration engine handles this. Declare independence in the spec:

```
## Tasks
- [x] build CoverIvp (independent)
- [x] build InputDesktop (independent)
- [x] build DesktopCta (independent)
- [ ] build Login screen (depends on: CoverIvp, InputDesktop, DesktopCta)
- [ ] validate login (depends on: build Login screen)
```

Kiro runs independent tasks in parallel automatically.

## Model assignment
Kiro uses a single model per session. Pick the strongest available. Mixing Opus/Sonnet per task not exposed.

## User interaction
- Setup questions → Kiro chat
- Progress → Kiro's task tracker reflects spec checklist

## Figma mapping
Configure Figma MCP in Kiro's `.kiro/mcp.json`. Tool names match plugin:figma:figma namespace. If different naming, adjust accordingly.

## Shell scripts
Invoke via Kiro's terminal execution or as spec task steps:
```
- [ ] run `node scripts/prepare-build.mjs --slice components`
- [ ] run `node scripts/validate.mjs --target ... --spec ... --url ...`
```

## Session wiring
Add CLAUDE.md + RULES.md contents to `.kiro/steering/` so they auto-inject into every session. Rename or alias — Kiro loads everything in the steering directory as context.

## Expected vs Claude
- Parallel builds work via Kiro's spec engine — comparable speed
- Requires upfront spec authoring (more structured, less ad-hoc)
- Strong at deterministic long-running jobs
