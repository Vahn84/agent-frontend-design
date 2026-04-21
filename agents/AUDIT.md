# Audit Agent (screens-first, REST)

**Model:** Opus. **Input:** Figma URL + FIGMA_PAT. **Output:** populated `design-contract/`.

Invoked by `/figma-audit` and as Phase 1 of `/figma-to-code`.

Philosophy: **screens are the source of truth.** Every visible decoration — text color, alignment, per-instance size, nested icon child — is captured by walking the screen tree, not by enumerating component masters. Components are **derived** from the clusters of instances observed across screens in a single page. The library is touched exactly once per page (to batch-export the icons page).

## Two modes

Audit runs in **two stages** so big files aren't deep-walked up front:

| Mode | When | Output | Script |
|------|------|--------|--------|
| **INDEX (A1)** | First touch, per file. Cheap. | `design-contract/index.yml` — pages + screens list, token/style counts | `scripts/audit-index.mjs` |
| **PAGE (A2)** | On demand, per page. Deep. | `design-contract/pages/<slug>/{meta,tokens,typography,icons,components,screens}/...` | this agent |

A1 is non-destructive — safe to re-run. A2 operates on one page at a time. Orchestrator picks the page (user choice or auto-route). Further pages = additional A2 invocations; every page contract is self-contained.

`design-contract/index.yml` tracks `pages[].audited` so the orchestrator knows which contracts exist.

## Tools

All Figma reads via `lib/figma.mjs`:

```js
import { createClient } from '../lib/figma.mjs';
import { parseFigmaUrl } from '../lib/url.mjs';
import { transformNode } from '../lib/transform.mjs';
import { buildTokenMap, resolveBoundVariables } from '../lib/tokens.mjs';

const client = createClient({ cacheDir: 'design-contract/.audit-cache/raw' });
```

Key calls:
- `client.getFile(fileKey, { depth })` — used by A1 for page list and A2 for library Icons page.
- `client.getFileNodes(fileKey, [nodeId], { depth })` — screen subtree (A2) or page probe (A1).
- `client.getLocalVariables(fileKey)` — once per file (Enterprise). Cached.
- `client.getFileStyles(fileKey)` — non-Enterprise fallback.
- `client.getImages(fileKey, iconIds, { format:'svg' })` — batched icon export.
- `client.getComponent(componentKey)` — once, to resolve library `file_key` (R33).
- `client.getImageFills(fileKey)` — imageRef → CDN URL map.

## REST call dedup cache (R27)

Two-layer cache:

1. **Raw REST** — `lib/figma.mjs` writes response JSON under `design-contract/.audit-cache/raw/` (keyed by endpoint + params hash). Automatic, set via `createClient({ cacheDir })`. Shared across A1 + A2.
2. **Enriched spec** — A2 writes the post-`transformNode` enriched tree to `design-contract/.audit-cache/<screenNodeId>-enriched.json`. Hit → load from disk and skip re-walk.

Cache invalidates on `--force-refresh`.

---

## A1 — INDEX mode

Runs via `scripts/audit-index.mjs`. Orchestrator should shell out rather than re-implement:

```bash
FIGMA_PAT=... node scripts/audit-index.mjs --url <figma-url>
node scripts/prepare-build.mjs --validate-index
```

Output: `design-contract/index.yml` (schema `index/v1`, see `schemas/index.schema.json`).

Orchestrator reads `index.yml` → shows page list to user → picks one (or auto-picks when only one non-empty page).

---

## A2 — PAGE mode

Input: `{ fileKey, pageNodeId, pageSlug, framework, styling, projectPath, libraryName, strategy }`.

Output root: `design-contract/pages/<pageSlug>/` (complete self-contained contract).

### 1. Parse URL / resolve page
`parseFigmaUrl(url) → { fileKey, nodeId }`. If `nodeId` present and belongs to a page (type CANVAS), use directly. Otherwise resolve the chosen `pageSlug` via `design-contract/index.yml`.

### 2. Screen inventory (R4)
From `index.yml`, read the page's `screens[]`. Each entry already has `{ name, slug, nodeId, width, height, x }`. Sort by `x` ascending (already sorted by A1).

### 3. Tokens (R6, R32)

```js
const vars = await client.getLocalVariables(fileKey);
const tokenMap = buildTokenMap(vars);     // { id → { cssVar, value, modes } }
```

Per-node resolution happens inside `transformNode` via `resolveBoundVariables(node.boundVariables, tokenMap)`. Write `pages/<slug>/tokens.yml`:
- Key = Figma variable path
- `cssVar` = `--<collection-slug>-<name-slug>`
- `value` = resolved value
- `modes` = per-mode map

**Non-Enterprise fallback:** seed `tokens.yml` manually; resolve fills via `node.styles` style keys + `client.getFileStyles(fileKey)`.

Tokens are file-global. A2 writes the same map into every page's `tokens.yml` — cheap YAML, simplifies page self-containment.

### 4. Typography from page screens
Walk text nodes across this page's screens. Each `transformNode` output includes `text.style = { fontFamily, fontWeight, fontSize, lineHeight, letterSpacing, textCase, italic }`. Dedupe by signature. Write `pages/<slug>/typography.yml`.

### 5. Icons — screens-first (R2, R33)

5a. **Collect icon nodes from this page's screens.** Walk every enriched screen tree. Any `kind: 'vector'` node OR any instance whose only child is a vector is an icon occurrence. Record `{ screenNodeId, instanceNodeId, vectorNodeId, componentKey, visibleSizePx, name }`.

5b. **Single library-touch (per file, shared via raw cache).** From any ONE icon's `componentRef.mainComponentKey`, `client.getComponent(key)` → `file_key`. Store as `meta.figma.libraryFileKey`. `client.getFile(libraryFileKey, { depth: 2 })` → find page named `Icons`. Raw cache means subsequent A2 runs on the same file skip these calls.

5c. **Batch export.** One `getImages` call per icon-page vector list. R23 — retry any null URL.

5d. **Write `pages/<slug>/icons.yml`** with every icon from the library Icons page (not just screen-referenced subset). Each icon: `name`, `vectorNodeId`, `viewBox`, and either `svgPath` or webfont `{ glyphCode, prefix, fontName }` per `meta.webfont`.

5e. Normalize via `scripts/normalize-icons.mjs --contract design-contract/pages/<slug>` (R25).

### 6. Screens — deep per-node capture (core, R1, R5, R32)

For each screen in the page (cached slug list):

6a. `client.getFileNodes(fileKey, [screenId])` → `response.nodes[screenId].document` = raw subtree. One call per screen.

6b. `const enriched = transformNode(rawNode, { tokenMap });` → full enriched tree.

6c. Walk enriched tree. Per-node shape matches `schemas/screen.schema.json` (unchanged from previous audit). Record instance overrides (R32).

6d. Capture screen-level `mockData` (R3): every text/id/name/date/status/label verbatim from `text.content` nodes. Infer `dataDrivenStyles` for data-bound components.

6e. Write `pages/<slug>/screens/<screen-slug>.yml` with `{ name, nodeId, route, viewportFit, dimensions, layoutSizing, tree, mockData, dataDrivenStyles }`.

### 6f. Modal extraction from overlay screens

Before component derivation, collapse overlay-role screens into modal components on their base screens.

**Preconditions:** every screen entry in `index.yml` carries `role` (base|overlay) and `overlayOf` (parent slug) from A1. A2 honors that as a prior — but A1 only sees names + dimensions. A2 CONFIRMS or OVERRIDES via tree-diff before extracting modals.

**Algorithm (per overlay screen, ordered by `overlayDepth` ASC so parents are already processed):**

1. Load enriched trees for the overlay and its `overlayOf` base.
2. **Subset check.** Walk base tree → collect a stable signature set (nodeId + kind + name + layout hash) for every node. Walk overlay tree → same signature set. Compute `overlaySet − baseSet`. If the delta is a cohesive subtree (shares one common ancestor in overlay) AND `baseSet` is a strict subset of `overlaySet` → confirmed modal.
3. **Extract delta subtree.** Identify the root of the modal — usually a top-level sibling in the overlay's tree that is absent from base. Often shaped as `<backdrop layer> + <dialog frame>` or a single floating frame.
4. **Write modal component** to `pages/<slug>/components/<modalName>.yml` with:
   - `classification.kind = "modal"`
   - `classification.modalOf = <baseSlug>`
   - `variants[]` — each overlay sibling sharing the same `overlayOf` base contributes one variant keyed by the last segment of its name (e.g. `Cambio urgenza` → variants `default`, `Urgenza ON`, `Urgenza OFF` via further overlayDepth chain).
5. **Nested overlays (overlayDepth ≥ 2):** treated as **variants of the parent modal**, not separate modal components. `Modale multiselezione/Cambio urgenza/Urgenza ON` → variant `Urgenza ON` of modal `Modale multiselezione Cambio urgenza`. Decision rule: if `overlayOf` points to another overlay → the nested delta is a variant extension of the parent's modal spec. Merge into the parent's `variants[]` rather than emit a new component.
6. **Attach to base screen** — append an entry to `base.modals[]`:
   ```yaml
   modals:
     - name: Cambio owner
       sourceOverlaySlug: richiedente-elenco-pratiche-cambio-owner
       componentName: ModaleCambioOwner
       variantName: default
       openTrigger: "…best-effort label…"
   ```
7. **Do NOT write a `screens/<overlaySlug>.yml`.** Overlay screens are absorbed into their base. Record the omission in `build-log.json` under `absorbedOverlays[]` for traceability.
8. **Divergent overlay (subset check fails):** log `[audit] divergent overlay <slug>` + demote to standalone screen (write `screens/<slug>.yml`, role=base override). R23 — never silently drop.
9. **Orphan overlay (no base found):** rare; promote to base (pick it as the base) + mark subsequent siblings as its overlays. Log warning.

**Build impact:**
- Base screen gains `modals[]` → page component renders `<ModalX open={state.modal === 'x'} />` conditionally.
- Modal components built like normal components (one agent per component, R10).
- Screen-by-screen mode (R37): when processing a base screen, modal components are pulled in via the same `for-screen` slice (prepare-build recurses `spec.modals[].componentName` into the component slice set).

### 7. Components — DERIVED from instance clusters within the page (R8)

After every screen in this page has been walked:

7a. Collect every `componentRef.mainComponentKey` from every enriched screen tree in this page. Group instances by key.

7b. For each group:
- Component `name`: consistent prefix of instance names, OR one cached `client.getComponent(key)` read for master `name`.
- **Variants = dedup signatures** (stable hash of dimensions + colors + typography + icons + spacing + radius + border). Each variant records `instances: []` for traceability.
- **Classification (R9).** Name match → library-wrapped + `libraryComponent` + `importPath`. Else `custom`.

7c. Write one `pages/<slug>/components/<name>.yml` per cluster.

**Cross-page dedup is NOT performed.** A Button used on both `richiedente` and `admin` pages gets built twice. That's the intentional tradeoff of per-page audit. Post-hoc merge can be added later — out of scope here.

### 8. Meta
Write `pages/<slug>/meta.yml`:

```yaml
figma:
  fileKey: ...
  pageNodeId: ...
  pageSlug: ...
  libraryFileKey: ...
framework: react
styling: tailwind
project:
  name: ...
  path: ...
library:
  name: primereact
  components: [...]
webfont: ...
assets: [...]
strategy:
  mode: screen-by-screen       # R34 default
  fixCap: 3                    # R35 default
  autoFixThreshold: 0.90       # R36 default
  screenOrder: [...]           # R37 — X-ascending from index.yml
  pageScope: <pageSlug>        # A2 self-identifies
```

### 9. Validate page contract
```bash
node scripts/prepare-build.mjs --validate --page <pageSlug>
```
Any schema error → fix + rescan. R23: never skip.

### 10. Mark page audited
Patch `design-contract/index.yml` → find the matching page entry → set `audited: true`. Use `js-yaml` load+dump so other fields stay intact.

## Output

```
design-contract/
  index.yml                              # A1
  pages/
    <pageSlug>/
      meta.yml
      tokens.yml
      typography.yml
      icons.yml
      icons/<icon>.svg
      components/*.yml                   # DERIVED from instance clusters within page
      screens/*.yml                      # enriched per-node tree (source of truth)
  .audit-cache/
    raw/                                 # shared across A1 + A2
    <screenNodeId>-enriched.json         # per-screen enriched cache
```

## Constraints
- Never traverse a component master for decoration (R5, R32). Master read only for display name.
- Never emit a node without reading the screen's `getFileNodes` response first (R5).
- Never include raw hex in contract output (R6). Every color resolves to a token ref via `tokenRefs`.
- Never record a variant not observed on an instance in this page (R8). No master enumeration. Cross-page clusters NOT merged.
- Never skip icon export null (R23).
- Single library touch per file (R33) — cached across page runs.
