# Figma REST — Tool Reference

All reads through `lib/figma.mjs` (`createClient`). Auth: `FIGMA_PAT` env or `{ pat }` option → `X-Figma-Token` header. Retries + 429/5xx backoff. Optional on-disk cache (`{ cacheDir }`).

## Read

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `me()` | `/v1/me` | Auth check |
| `getFile(key, { depth, geometry, version })` | `/v1/files/:key` | Full file tree. Heavy — prefer `getFileNodes`. |
| `getFileNodes(key, ids, { depth, geometry })` | `/v1/files/:key/nodes` | Subtree under specific nodeIds. Screen-scoped audit. |
| `getImages(key, ids, { format, scale, svgIncludeId, svgSimplifyStroke, useAbsoluteBounds })` | `/v1/images/:key` | Render → png/jpg/svg/pdf. URLs expire ~30 min. |
| `getImageFills(key)` | `/v1/files/:key/images` | imageRef → CDN URL map (for image fills). |
| `getFileComponents(key)` | `/v1/files/:key/components` | Components in file. |
| `getFileComponentSets(key)` | `/v1/files/:key/component_sets` | Component sets. |
| `getFileStyles(key)` | `/v1/files/:key/styles` | Published styles. |
| `getComponent(componentKey)` | `/v1/components/:key` | **Single library touch (R33)** → `file_key` of owning library. |
| `getComponentSet(key)` | `/v1/component_sets/:key` | Library component set. |
| `getStyle(styleKey)` | `/v1/styles/:key` | Library style. |
| `getLocalVariables(key)` | `/v1/files/:key/variables/local` | **Enterprise only.** Full variable map for token resolution. |
| `getPublishedVariables(key)` | `/v1/files/:key/variables/published` | **Enterprise only.** Published variable refs. |
| `downloadUrl(url)` | — | Raw fetch for image/SVG URLs from `getImages`. |

## MCP → REST equivalents

| Former MCP tool | REST replacement |
|-----------------|------------------|
| `get_metadata` | `getFileNodes(key, ids, { depth })` |
| `get_screenshot` | `getImages(key, ids, { format:'png', scale:2 })` + `downloadUrl` |
| `get_variable_defs` | `getLocalVariables(key)` → `buildTokenMap` → per-node `boundVariables` walk |
| `get_design_context` | `getFileNodes` + `transformNode` (deterministic, no LLM code-gen) |
| `search_design_system` | `getFileComponents` + `getFileStyles` |
| `whoami` | `me()` |

## Writes

**Not supported.** Figma REST is read-only. `/code-to-figma`, `/code-connect` dropped from this fork. `/wire-library` retained (it reads Figma + writes code — no Figma writes).

## URL → params

| URL shape | fileKey | nodeId |
|-----------|---------|--------|
| `figma.com/design/:key/:name?node-id=X-Y` | `:key` | `X:Y` (convert `-`→`:`) |
| `figma.com/design/:key/branch/:branchKey/:name` | `:branchKey` | as above |
| `figma.com/file/:key/...` (legacy) | `:key` | as above |
| `figma.com/board/:key/:name` | `:key` | FigJam — not supported here |
| `figma.com/make/:key/:name` | `:key` | not supported |

`lib/url.mjs` exports `parseFigmaUrl(url) → { fileKey, nodeId, kind, branchKey }`.

## Variables (Enterprise)

`GET /v1/files/:key/variables/local` returns:

```
{ meta: { variables: { [id]: Variable }, variableCollections: { [id]: Collection } } }
```

- `Variable.valuesByMode[modeId]` = `RGBA | number | string | { type:'VARIABLE_ALIAS', id }`.
- Alias chains resolved recursively by `lib/tokens.mjs`.
- `cssVar` derived as `--<collection-slug>-<name-slug>` where `name` uses `/` for nesting.
- Per-node resolution: walk `node.boundVariables` → map each aliased field to `{ cssVar, value }` via `resolveBoundVariables`.

**Non-Enterprise fallback:** use `node.styles` (published style refs) + manually-seeded `tokens.yml`. Loses granular per-field binding.

## Rate limits

- Figma doesn't publish hard limits. Observed: bursts of 50 req/s fine; sustained > 20 req/s sometimes 429.
- `lib/figma.mjs` handles 429 via `Retry-After` header + exponential backoff on 5xx.
- For bulk audits: use `cacheDir` — per-key JSON cache. Entire subtree under a screen root ships in one `getFileNodes` call.

## Gotchas

- `getImages` URLs are signed + expire (~30 min). Download immediately, don't stash URL.
- `getFileNodes` with `depth` limits descendant levels; default = full tree under each ID.
- Icon export: request the **vector child's** nodeId, not the container instance (padding bakes into viewBox otherwise — R2).
- `boundVariables` present on the node means the Figma designer bound a variable; raw `fills`/`strokes` still carry the resolved RGBA — use both: token ref for CSS var, raw for fallback / validation.
- Image fills: `imageRef` is a content hash — resolve to URL via `getImageFills(key)` then `downloadUrl`.
- `webhookV2` events, Dev Mode, plugin state: not exposed via REST. Out of scope here.
