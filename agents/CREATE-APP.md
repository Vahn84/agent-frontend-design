# Create App Workflow

No Figma input. User provides: framework, project name, app description (prompt or examples), optional library.

## Phases

### A. Gather intent
Ask (batched): framework, project name, description, component library (default none), theme seed (primary color OR reference image).

### B. Synthesize contract
Orchestrator (Opus) writes initial `design-contract/`:
- `meta.yml` from inputs
- `tokens.yml` — derived palette from primary color (generates surface/text/border/state tokens via chroma stepping)
- `typography.yml` — sane defaults (system fonts or specified)
- `icons.yml` — strategy=svg, source=lucide (or user pick). Empty icons array initially.
- `components/*.yml` — from description, emit per-component spec with sensible default variants
- `screens/*.yml` — from description, emit per-screen spec with placeholder mockData

User reviews contract. Edits inline if needed.

### C. Scaffold
Spawn `SCAFFOLD.md` agent. Same as figma-to-code Phase B.

### D. Build components
Spawn `BUILD-COMPONENT.md` agents (parallel cap 4). Each receives ONE slice.

### E. Build screens
Spawn `BUILD-SCREEN.md` agents (cap 2).

### F. Validate (screens only — R18)
`VALIDATE.md --fast` per screen runs L0–L4 (no Figma reference, so L5 skipped — compares only against its own synthesized spec).

### G. Reverse-contract check
After build, run an "observational audit" — orchestrator reads each built page, measures computed styles, confirms they match the synthesized spec. Corrects drift in contract so future `/sync` works.

### H. Report
Dev server URL. Contract path. (No Figma push — this fork is REST read-only.)

## Differences from figma-to-code
- No Figma reads → no R4/R5 audit phase
- Contract is synthesized, not extracted
- L5 pixel diff not applicable — structural validation only
- Mock data invented from description (acceptable here — no Figma truth exists)
