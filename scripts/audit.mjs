#!/usr/bin/env node
// audit.mjs — REST-only Figma audit.
// URL in → design-contract/ out (meta.yml, tokens.yml, typography.yml, icons.yml, screens/, components/).
//
// Usage:
//   FIGMA_PAT=... node scripts/audit.mjs <figma-url> \
//     [--out design-contract] [--page <name>] [--lib <keys>] [--discover-lib] \
//     [--framework react|angular] [--styling tailwind|scss] \
//     [--strategy screen-by-screen|full] [--skip-icons] [--force-refresh]

import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { constants as FS_CONST } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'js-yaml';

import { parseFigmaUrl } from '../lib/url.mjs';
import { createClient, FigmaError } from '../lib/figma.mjs';
import { transformNode } from '../lib/transform.mjs';
import { buildTokenMap, collectUnresolvedKeys, slugify } from '../lib/tokens.mjs';

// ---------- arg parsing ----------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = parseFlags(args);

const URL = positional[0];
if (!URL) fail('usage: audit.mjs <figma-url> [flags]');

const OUT = flags.out || 'design-contract';
const FRAMEWORK = (flags.framework || 'react').toLowerCase();
const STYLING = (flags.styling || (FRAMEWORK === 'react' ? 'tailwind' : 'scss')).toLowerCase();
const STRATEGY_MODE = (flags.strategy || 'screen-by-screen').toLowerCase();
const FORCE_REFRESH = !!flags['force-refresh'];
const SKIP_ICONS = !!flags['skip-icons'];
const TARGET_PAGE = flags.page || null;

const CACHE_DIR = join(OUT, '.audit-cache');
const RAW_CACHE_DIR = join(CACHE_DIR, 'raw');
const ASSETS_DIR = join(OUT, 'assets');
const ICONS_DIR = join(ASSETS_DIR, 'icons');
const IMAGES_DIR = join(ASSETS_DIR, 'images');

const parsed = parseFigmaUrl(URL);
const FILE_KEY = parsed.fileKey;

// ---------- main ----------

const client = createClient({ cacheDir: RAW_CACHE_DIR });

await main().catch((err) => {
  if (err instanceof FigmaError) {
    console.error(`[figma ${err.status ?? ''}] ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});

async function main() {
  log(`audit start — ${URL}`);

  if (FORCE_REFRESH) await rm(CACHE_DIR, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  // Phase 1: page inventory
  log('phase 1 — page inventory');
  const fileSummary = await client.getFile(FILE_KEY, { depth: 2 });
  const pages = fileSummary.document.children.map((p) => ({
    id: p.id,
    name: p.name,
    // R-visibility: skip hidden top-level frames.
    frames: (p.children || []).filter((n) => n.type === 'FRAME' && n.visible !== false),
  }));
  const candidates = pages.filter((p) => p.frames.length > 0);
  const targetPage = pickPage(candidates, TARGET_PAGE);
  if (!targetPage) fail(`no usable page found (pages: ${pages.map((p) => p.name).join(', ')})`);
  log(`  → page: ${targetPage.name} (${targetPage.id}) — ${targetPage.frames.length} frames`);

  // Phase 2: token map (with library discovery)
  log('phase 2 — tokens');
  const tokenMap = await buildTokenMapWithLibs(FILE_KEY);
  const unresolved = collectUnresolvedKeys(tokenMap);
  if (unresolved.length) log(`  ⚠ ${unresolved.length} library var key(s) unresolved: ${unresolved.slice(0, 3).join(', ')}${unresolved.length > 3 ? ', ...' : ''}`);
  log(`  → ${Object.keys(dedupTokenMapByName(tokenMap)).length} unique tokens`);

  // Phase 3: screen classification + enrichment
  log('phase 3 — screens');
  const screens = classifyScreens(targetPage.frames);
  log(`  → ${screens.length} screen frames`);

  const enrichedScreens = [];
  for (const s of screens) {
    const enriched = await auditScreen(s, tokenMap);
    enrichedScreens.push(enriched);
  }

  // Phase 4: typography
  log('phase 4 — derive typography');
  const typography = extractTypography(enrichedScreens);
  log(`  → typography ${Object.keys(typography.styles).length}`);

  // Phase 5a: images — resolve imageRef → CDN URL → download. Stamp assetName on nodes.
  log('phase 5a — images');
  const assets = await resolveAndDownloadImages(enrichedScreens);
  log(`  → ${assets.length} image assets`);

  // Phase 5b: icons
  log('phase 5b — icons');
  const iconsData = SKIP_ICONS
    ? { source: { fileKey: FILE_KEY }, strategy: 'svg', icons: [] }
    : await collectIcons(enrichedScreens);
  log(`  → ${iconsData.icons.length} icons${iconsData.source.fileKey !== FILE_KEY ? ' (library: ' + iconsData.source.fileKey + ')' : ' (no library resolved)'}`);

  // Phase 5c: stamp _iconName on vector nodes inside icon instances so component variants
  // can emit a library-correct iconName in icons[].
  stampIconNames(enrichedScreens, iconsData);

  // Phase 6: derive components (after icon names stamped so variants pick them up).
  log('phase 6 — derive components');
  const components = clusterComponents(enrichedScreens, { iconNameByComponentKey: iconsData._iconNameByComponentKey || {} });
  log(`  → components ${components.length}`);

  // Phase 7: write contract files
  log('phase 7 — write contract');
  await writeContract({
    tokenMap,
    typography,
    iconsData,
    enrichedScreens,
    components,
    targetPage,
    libraryFileKey: iconsData.source.fileKey !== FILE_KEY ? iconsData.source.fileKey : null,
    assets,
  });
  log(`  → wrote ${OUT}/`);

  log('audit done.');
}

// ---------- phases ----------

function pickPage(candidates, hint) {
  if (!candidates.length) return null;
  if (hint) {
    const match = candidates.find((p) => p.id === hint || slugify(p.name) === slugify(hint) || p.name.toLowerCase().includes(hint.toLowerCase()));
    if (match) return match;
    fail(`page hint "${hint}" not found. Available: ${candidates.map((p) => p.name).join(', ')}`);
  }
  // prefer page with the most frames
  return [...candidates].sort((a, b) => b.frames.length - a.frames.length)[0];
}

async function buildTokenMapWithLibs(fileKey) {
  const main = await safeVariables(fileKey);
  if (!main) {
    log('  ⚠ variables endpoint empty — Enterprise plan required for full token resolution');
    return {};
  }
  const responses = [main];

  let libKeys = [];
  if (flags.lib) libKeys.push(...String(flags.lib).split(',').map((s) => s.trim()).filter(Boolean));
  if (flags['discover-lib']) {
    const discovered = await discoverLibraryFileKeys(fileKey);
    log(`  → discovered libs: ${discovered.join(', ') || 'none'}`);
    libKeys.push(...discovered);
  }
  libKeys = [...new Set(libKeys.filter((k) => k !== fileKey))];

  for (const lib of libKeys) {
    const libResp = await safeVariables(lib);
    if (libResp) responses.push(libResp);
    else log(`  ⚠ skipped lib ${lib} (no variables access)`);
  }
  return buildTokenMap(responses);
}

async function discoverLibraryFileKeys(fileKey) {
  const file = await client.getFile(fileKey, { depth: 3 });
  const remoteKeys = [...new Set(Object.values(file.components ?? {}).filter((c) => c.remote && c.key).map((c) => c.key))];
  const sample = remoteKeys.slice(0, 16);
  const results = await Promise.all(sample.map(async (k) => {
    try {
      const resp = await client.getComponent(k);
      return resp?.meta?.file_key ?? null;
    } catch {
      return null;
    }
  }));
  return [...new Set(results.filter((k) => k && k !== fileKey))];
}

function classifyScreens(frames) {
  // Screens = top-level frames (>= 1024 wide — lax threshold).
  return frames
    .filter((f) => (f.absoluteBoundingBox?.width ?? 0) >= 1024)
    .map((f) => ({ id: f.id, name: f.name, width: f.absoluteBoundingBox.width, height: f.absoluteBoundingBox.height, x: f.absoluteBoundingBox.x }))
    .sort((a, b) => a.x - b.x);
}

async function auditScreen(screen, tokenMap) {
  const cachePath = join(CACHE_DIR, `${screen.id.replace(/[:/]/g, '_')}-enriched.json`);
  if (!FORCE_REFRESH && await exists(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }
  const nodesRes = await client.getFileNodes(FILE_KEY, screen.id);
  const entry = nodesRes.nodes[screen.id];
  if (!entry) fail(`screen ${screen.id} not in response`);
  const tree = transformNode(entry.document, {
    tokenMap,
    components: entry.components,
    componentSets: entry.componentSets,
    styles: entry.styles,
  });
  const enriched = {
    screenId: screen.id,
    name: screen.name,
    route: routeFromName(screen.name),
    viewportFit: 'fill',
    dimensions: { width: screen.width, height: screen.height },
    layoutSizing: tree.layoutSizing ?? { horizontal: 'FIXED', vertical: 'FIXED' },
    tree,
  };
  await writeFile(cachePath, JSON.stringify(enriched));
  return enriched;
}

// ---------- typography extraction ----------

function extractTypography(screens) {
  const sigMap = new Map(); // sig → { styleName, style }
  let counter = 0;
  for (const s of screens) {
    walk(s.tree, (n) => {
      if (n.kind !== 'text' || !n.text?.style) return;
      const st = n.text.style;
      const sig = sigOf({ f: st.fontFamily, s: st.fontSize, w: st.fontWeight, lh: st.lineHeight, ls: st.letterSpacing });
      if (!sigMap.has(sig)) {
        const name = `t${++counter}`;
        sigMap.set(sig, { name, style: { fontFamily: st.fontFamily || 'inherit', fontSize: withUnit(st.fontSize, 'px'), fontWeight: st.fontWeight || 400, lineHeight: withUnit(st.lineHeight, 'px'), letterSpacing: withUnit(st.letterSpacing, 'px'), textTransform: caseToTransform(st.textCase), textDecoration: st.textDecoration || null } });
      }
      n._textStyleName = sigMap.get(sig).name; // stamp for later use
    });
  }
  const styles = {};
  for (const { name, style } of sigMap.values()) {
    const clean = { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
    if (style.letterSpacing) clean.letterSpacing = style.letterSpacing;
    if (style.textTransform) clean.textTransform = style.textTransform;
    if (style.textDecoration) clean.textDecoration = style.textDecoration;
    styles[name] = clean;
  }
  return { styles };
}

function caseToTransform(tc) {
  if (!tc || tc === 'ORIGINAL') return null;
  const map = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
  return map[tc] ?? null;
}

function withUnit(v, unit) {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  return `${v}${unit}`;
}

// ---------- component clustering ----------

function clusterComponents(screens, ctx = {}) {
  const groups = new Map();

  for (const s of screens) {
    walk(s.tree, (n) => {
      if (n.kind !== 'instance' || !n.componentRef) return;
      const key = n.componentRef.mainComponentKey || n.componentRef.componentSetKey || n.componentRef.componentId;
      if (!key) return;
      if (!groups.has(key)) {
        const rawName = n.componentRef.componentSetName || n.componentRef.componentName || n.name;
        groups.set(key, { name: deriveComponentName(rawName), instances: [] });
      }
      groups.get(key).instances.push({ screenNodeId: s.screenId, instanceNodeId: n.id, node: n });
    });
  }

  const components = [];
  for (const [key, g] of groups) {
    const variants = deriveVariants(g.instances, ctx);
    components.push({
      name: uniqueName(components, g.name),
      nodeId: g.instances[0].instanceNodeId,
      classification: { kind: 'custom' },
      variants,
      _mainComponentKey: key,
    });
  }
  return components;
}

function deriveComponentName(raw) {
  if (!raw) return 'Component';
  // "Button/Primary" → "ButtonPrimary" if fully nested; better: take first segment.
  const first = raw.split('/')[0].trim();
  return first.replace(/[^a-zA-Z0-9]+/g, '');
}

function uniqueName(list, base) {
  let name = base || 'Component';
  let n = 2;
  const taken = new Set(list.map((c) => c.name));
  while (taken.has(name)) name = `${base}${n++}`;
  return name;
}

function deriveVariants(instances, ctx = {}) {
  const bySig = new Map();
  for (const inst of instances) {
    const sig = variantSignature(inst.node);
    if (!bySig.has(sig)) bySig.set(sig, { instances: [], node: inst.node });
    bySig.get(sig).instances.push({ screenNodeId: inst.screenNodeId, instanceNodeId: inst.instanceNodeId });
  }
  const variants = [];
  let i = 0;
  for (const { instances: insts, node } of bySig.values()) {
    variants.push(buildVariant(i === 0 ? 'default' : `variant-${i + 1}`, node, insts, ctx));
    i++;
  }
  return variants;
}

function variantSignature(node) {
  const fills = (node.fills || []).map((f) => f.color ?? f.type).join(',');
  const radius = typeof node.radius === 'object' ? JSON.stringify(node.radius) : node.radius ?? '';
  const dims = node.layoutSizing?.horizontal === 'FIXED' || node.layoutSizing?.vertical === 'FIXED' ? `${node.dimensions?.width}x${node.dimensions?.height}` : `${node.layoutSizing?.horizontal}/${node.layoutSizing?.vertical}`;
  const spacing = node.spacing ? `${node.spacing.gap ?? 0}|${node.spacing.paddingTop ?? 0}|${node.spacing.paddingRight ?? 0}|${node.spacing.paddingBottom ?? 0}|${node.spacing.paddingLeft ?? 0}` : '';
  const variant = node.componentRef?.componentProperties ? JSON.stringify(Object.fromEntries(Object.entries(node.componentRef.componentProperties).map(([k, v]) => [k, v.value]))) : '';
  return `${fills}|${radius}|${dims}|${spacing}|${variant}`;
}

function buildVariant(name, node, instances, { iconNameByComponentKey } = {}) {
  const layoutSizing = node.layoutSizing ?? { horizontal: 'FIXED', vertical: 'FIXED' };
  const fixedH = layoutSizing.horizontal === 'FIXED';
  const fixedV = layoutSizing.vertical === 'FIXED';
  const dims = {
    width: fixedH ? node.dimensions?.width ?? null : null,
    height: fixedV ? node.dimensions?.height ?? null : null,
  };
  const spacing = {
    gap: node.spacing?.gap ?? null,
    paddingTop: node.spacing?.paddingTop ?? 0,
    paddingRight: node.spacing?.paddingRight ?? 0,
    paddingBottom: node.spacing?.paddingBottom ?? 0,
    paddingLeft: node.spacing?.paddingLeft ?? 0,
  };
  const typography = [];
  const colors = {};
  const icons = [];
  const imageFrames = [];
  let radius = typeof node.radius === 'number' ? node.radius : null;

  // Walk includes the root node itself so root-level fills/images are captured.
  walk(node, (child) => {
    if (child.kind === 'text' && child.text && child._textStyleName) {
      const color = child.tokenRefs?.fills?.[0]?.name;
      typography.push({
        textStyle: child._textStyleName,
        role: child.name?.toLowerCase() || 'label',
        colorToken: color || 'unresolved',
      });
    }
    if (child.kind === 'vector' && child.icon) {
      const color = child.tokenRefs?.fills?.[0]?.name;
      const libName = iconNameByComponentKey && findIconNameForVector(child, iconNameByComponentKey);
      icons.push({
        iconName: libName || slugifyIconName(child.name || 'icon'),
        visibleSizePx: child.icon.visibleSizePx || 16,
        colorToken: color || 'unresolved',
      });
    }
    if (child.imageFrame) {
      imageFrames.push({
        slot: slugifyIconName(child.name || 'image'),
        assetName: child._assetName || slugifyIconName(child.name || 'image'),
        container: { widthPx: child.dimensions?.width ?? 0, heightPx: child.dimensions?.height ?? 0 },
        imageWidthPct: 100,
        imageHeightPct: 100,
        imageLeftPct: 0,
        imageTopPct: 0,
        scaleMode: ['FIT', 'FILL', 'CROP', 'TILE'].includes(child.imageFrame.scaleMode) ? child.imageFrame.scaleMode : 'FILL',
      });
    }
    const fill = child.tokenRefs?.fills?.[0];
    if (fill?.name && child.name && child !== node) colors[child.name] = fill.name;
  });

  const rootFill = node.tokenRefs?.fills?.[0]?.name;
  if (rootFill) colors.root = rootFill;

  const variant = {
    name,
    nodeId: instances[0].instanceNodeId,
    instances,
    layoutSizing,
    dimensions: dims,
    spacing,
    typography,
    colors,
    radius,
  };
  if (icons.length) variant.icons = icons;
  if (imageFrames.length) variant.imageFrames = imageFrames;
  return variant;
}

// Look up the icon library name for a vector inside an instance whose main component
// belongs to the icons page. Traverses up via ctx chain of parent componentKeys.
function findIconNameForVector(vectorNode, iconNameByComponentKey) {
  // On screen walk, a vector inside an icon-instance carries the parent mainComponentKey
  // via the enclosing instance's componentRef. We stamped `_iconName` during icon collection.
  return vectorNode._iconName || null;
}

// ---------- icons ----------

async function collectIcons(screens) {
  // Collect vector nodes + instances that wrap a vector; pick one remote componentKey to hop.
  const iconOccurrences = [];
  for (const s of screens) {
    walk(s.tree, (n) => {
      if (n.kind === 'vector' && n.icon) {
        iconOccurrences.push({ node: n, screen: s, mainKey: null });
      } else if (n.kind === 'instance' && n.children?.length === 1 && n.children[0].kind === 'vector') {
        iconOccurrences.push({ node: n.children[0], screen: s, mainKey: n.componentRef?.mainComponentKey });
      }
    });
  }

  if (!iconOccurrences.length) return { source: { fileKey: FILE_KEY }, strategy: 'svg', icons: [] };

  // Collect unique mainComponentKeys to probe. Nested instance componentKeys often 404
  // (derived/local). Try each until one resolves to a library file_key. (R23 — retry, don't
  // silently skip.)
  const uniqueKeys = [...new Set(iconOccurrences.map((o) => o.mainKey).filter(Boolean))];
  if (!uniqueKeys.length) {
    return buildPlaceholderIcons(iconOccurrences);
  }

  let libraryFileKey = null;
  let triedCount = 0;
  for (const key of uniqueKeys) {
    triedCount++;
    try {
      const resp = await client.getComponent(key);
      if (resp?.meta?.file_key) {
        libraryFileKey = resp.meta.file_key;
        log(`  → library resolved via key ${key.slice(0, 8)}… after ${triedCount} probe(s)`);
        break;
      }
    } catch (err) {
      // 404 on nested/local-derived keys is expected. Continue probing.
      if (!(err instanceof FigmaError && err.status === 404)) {
        log(`  ⚠ getComponent(${key.slice(0, 8)}…) → ${err.message}`);
      }
    }
  }
  if (!libraryFileKey) {
    log(`  ⚠ no library file_key resolvable from ${uniqueKeys.length} icon key(s)`);
    return buildPlaceholderIcons(iconOccurrences);
  }

  const libFile = await client.getFile(libraryFileKey, { depth: 3 });
  const iconsPage = libFile.document.children.find((p) => /^icons?$/i.test(p.name) || p.name.toLowerCase().includes('icon'));
  if (!iconsPage) return buildPlaceholderIcons(iconOccurrences);

  const iconComponents = (iconsPage.children || []).filter((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET');
  const flatIcons = iconComponents.flatMap((n) => (n.type === 'COMPONENT_SET' ? n.children || [] : [n])).filter((n) => n.type === 'COMPONENT');

  if (!flatIcons.length) return buildPlaceholderIcons(iconOccurrences);

  // Component keys live in libFile.components[nodeId].key, not on the node itself.
  const libComponents = libFile.components ?? {};
  const keyOf = (iconNode) => libComponents[iconNode.id]?.key ?? null;

  // Export SVGs in batches of 50. Also build componentKey → iconName map for
  // cross-referencing from screen-tree instances.
  await mkdir(ICONS_DIR, { recursive: true });
  const batches = chunk(flatIcons.map((n) => n.id), 50);
  const icons = [];
  const iconNameByComponentKey = {};
  for (const batch of batches) {
    const { images } = await client.getImages(libraryFileKey, batch, { format: 'svg', svgSimplifyStroke: true });
    for (const iconNode of flatIcons.filter((n) => batch.includes(n.id))) {
      const name = slugifyIconName(iconNode.name);
      const componentKey = keyOf(iconNode);
      if (componentKey) iconNameByComponentKey[componentKey] = name;
      const url = images[iconNode.id];
      if (!url) continue;
      const svg = await client.downloadUrl(url);
      const relPath = join('assets', 'icons', `${name}.svg`);
      await writeFile(join(OUT, relPath), svg);
      icons.push({
        name,
        nodeId: iconNode.id,
        vectorNodeId: iconNode.id,
        componentKey,
        svgPath: relPath,
      });
    }
  }
  return { source: { fileKey: libraryFileKey, pageId: iconsPage.id }, strategy: 'svg', icons, _iconNameByComponentKey: iconNameByComponentKey };
}

// Walk screen trees; for every vector node inside an instance whose mainComponentKey
// resolves to a library icon, stamp `_iconName` on the vector. Consumed by buildVariant.
function stampIconNames(enrichedScreens, iconsData) {
  const map = iconsData?._iconNameByComponentKey;
  if (!map || !Object.keys(map).length) return;
  for (const s of enrichedScreens) {
    walk(s.tree, (n) => {
      if (n.kind !== 'instance' || !n.componentRef) return;
      const key = n.componentRef.mainComponentKey || n.componentRef.componentSetKey;
      const iconName = key && map[key];
      if (!iconName) return;
      walk(n, (child) => {
        if (child === n) return;
        if (child.kind === 'vector') child._iconName = iconName;
      });
    });
  }
}

// Collect every unique imageRef across all enriched screens, resolve to CDN URLs via
// GET /v1/files/:key/images, download each, write to design-contract/assets/images/,
// stamp `_assetName` on nodes. Returns meta.assets[] entries.
async function resolveAndDownloadImages(enrichedScreens) {
  // Collect refs.
  const refNodes = new Map(); // imageRef → { nodes: [node], name }
  for (const s of enrichedScreens) {
    walk(s.tree, (n) => {
      const ref = n.imageFrame?.imageRef;
      if (!ref) return;
      if (!refNodes.has(ref)) refNodes.set(ref, { nodes: [], name: slugifyIconName(n.name || 'image') });
      refNodes.get(ref).nodes.push(n);
    });
  }
  if (!refNodes.size) return [];

  // Resolve URLs.
  const { meta } = await client.getImageFills(FILE_KEY);
  const imageMap = meta?.images ?? {};

  await mkdir(IMAGES_DIR, { recursive: true });
  const assets = [];
  for (const [ref, info] of refNodes) {
    const url = imageMap[ref];
    if (!url) {
      log(`  ⚠ no URL for imageRef ${ref.slice(0, 8)}… (${info.name})`);
      continue;
    }
    const buf = await client.downloadUrl(url);
    const ext = detectImageExt(buf);
    const baseName = info.name || `img-${ref.slice(0, 8)}`;
    const assetName = uniqueAssetName(assets, baseName);
    const relPath = join('assets', 'images', `${assetName}.${ext}`);
    await writeFile(join(OUT, relPath), buf);
    for (const n of info.nodes) n._assetName = assetName;
    assets.push({ kind: 'image', name: assetName, path: `src/${relPath}`, figmaNodeId: info.nodes[0].id });
  }
  return assets;
}

function uniqueAssetName(list, base) {
  const taken = new Set(list.map((a) => a.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function detectImageExt(buf) {
  // PNG signature 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // JPEG FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // WebP — "RIFF...WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57) return 'webp';
  // GIF87a/GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  // SVG starts with "<"
  if (buf[0] === 0x3c) return 'svg';
  return 'bin';
}

function buildPlaceholderIcons(occurrences) {
  const names = new Map();
  for (const o of occurrences) {
    const name = slugifyIconName(o.node.name || 'icon');
    if (!names.has(name)) names.set(name, { name, nodeId: o.node.id, vectorNodeId: o.node.id });
  }
  return { source: { fileKey: FILE_KEY }, strategy: 'svg', icons: [...names.values()] };
}

function slugifyIconName(name) {
  return slugify((name || 'icon').replace(/[/]/g, '-')) || 'icon';
}

// ---------- write contract ----------

async function writeContract({ tokenMap, typography, iconsData, enrichedScreens, components, targetPage, libraryFileKey, assets = [] }) {
  // meta.yml
  const meta = {
    figma: {
      fileKey: FILE_KEY,
      pageId: targetPage.id,
      url: URL,
      libraryFileKey: libraryFileKey ?? null,
    },
    framework: FRAMEWORK,
    styling: STYLING,
    project: {
      name: flags.project || slugify(targetPage.name) || 'app',
      path: flags['project-path'] || `~/Documents/DEV/${flags.project || slugify(targetPage.name) || 'app'}`,
    },
    assets,
    strategy: {
      mode: STRATEGY_MODE,
      fixCap: 3,
      autoFixThreshold: 0.9,
      screenOrder: enrichedScreens.map((s) => slugify(s.name)),
    },
  };
  await writeYaml(join(OUT, 'meta.yml'), meta);

  // tokens.yml
  const tokensYaml = { map: dedupTokenMapByName(tokenMap) };
  await writeYaml(join(OUT, 'tokens.yml'), tokensYaml);

  // typography.yml
  await writeYaml(join(OUT, 'typography.yml'), typography);

  // icons.yml
  await writeYaml(join(OUT, 'icons.yml'), iconsData);

  // screens/*.yml
  await mkdir(join(OUT, 'screens'), { recursive: true });
  for (const s of enrichedScreens) {
    const outShape = {
      name: slugify(s.name),
      nodeId: s.screenId,
      route: s.route,
      viewportFit: s.viewportFit,
      dimensions: s.dimensions,
      layoutSizing: s.layoutSizing,
      tree: [cleanTree(s.tree)],
      mockData: extractMockData(s.tree),
    };
    await writeYaml(join(OUT, 'screens', `${slugify(s.name)}.yml`), outShape);
  }

  // components/*.yml
  await mkdir(join(OUT, 'components'), { recursive: true });
  for (const c of components) {
    const { _mainComponentKey, ...rest } = c;
    rest.mainComponentKey = _mainComponentKey;
    await writeYaml(join(OUT, 'components', `${slugify(c.name)}.yml`), rest);
  }
}

function dedupTokenMapByName(tokenMap) {
  const out = {};
  const seen = new Set();
  for (const t of Object.values(tokenMap)) {
    if (!t.name || seen.has(t.id)) continue;
    seen.add(t.id);
    const type = mapTokenType(t.type);
    const value = sanitizeTokenValue(t.value, type);
    // Drop tokens that resolve to an empty value — they produce invalid CSS downstream.
    if (value === null) continue;
    const modesStr = {};
    for (const [k, v] of Object.entries(t.modes || {})) {
      const sv = sanitizeTokenValue(v, type);
      if (sv !== null) modesStr[k] = sv;
    }
    out[t.name] = {
      cssVar: t.cssVar,
      value,
      type,
      modes: modesStr,
    };
  }
  return out;
}

// Render a token value as a safe CSS value string. Returns null to signal "skip this token".
// - null/undefined/empty string → null (drop)
// - numbers → unitless string ("8")
// - colors (#hex) → verbatim
// - strings → double-quoted CSS string, with internal double-quotes escaped
function sanitizeTokenValue(raw, type) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (type === 'color') return s;
  if (type === 'number') return s;
  // For 'string' and fallback: quote if it contains anything other than digits/hex/dash/percent/unit chars.
  const isCssSafe = /^[a-zA-Z0-9#%.\-_]+$/.test(s);
  if (isCssSafe) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function mapTokenType(type) {
  switch (type) {
    case 'COLOR': return 'color';
    case 'FLOAT': return 'number';
    case 'STRING': return 'string';
    case 'BOOLEAN': return 'string';
    default: return 'string';
  }
}

function cleanTree(node) {
  if (!node) return null;
  const { componentRef, tokenRefs, fills, strokes, effects, styles, constraints, visible, type,
    _textStyleName, _assetName, _iconName, ...keep } = node;
  const out = { ...keep };
  // Drop null/undefined enum-valued fields so schema doesn't reject.
  for (const k of ['alignItems', 'justifyContent', 'direction']) {
    if (out[k] == null) delete out[k];
  }
  // Hoist commonly-used token refs to named fields.
  const colorToken = tokenRefs?.fills?.[0]?.name;
  if (colorToken) out.colorToken = colorToken;
  if (componentRef?.mainComponentKey) {
    out.mainComponentId = componentRef.componentId;
    out.mainComponentKey = componentRef.mainComponentKey;
  }
  if (node.text && _textStyleName) {
    out.text = { ...node.text, style: _textStyleName };
    const txtColor = tokenRefs?.fills?.[0]?.name;
    if (txtColor) out.text.color = txtColor;
  }
  if (node.imageFrame) {
    out.imageFrame = normalizeImageFrame(node);
  } else {
    delete out.imageFrame;
  }
  if (node.children) out.children = node.children.map(cleanTree);
  return out;
}

function normalizeImageFrame(node) {
  // Map Figma REST scaleMode values to the schema enum.
  // Figma exposes: FIT | FILL | TILE | STRETCH | CROP. Schema allows FIT|FILL|CROP|TILE.
  const SCALE_MODE_MAP = { FIT: 'FIT', FILL: 'FILL', CROP: 'CROP', TILE: 'TILE', STRETCH: 'FILL' };
  const dim = node.dimensions || {};
  const src = node.imageFrame;
  return {
    assetName: node._assetName || slugifyIconName(node.name || 'image'),
    container: { widthPx: dim.width ?? 0, heightPx: dim.height ?? 0 },
    scaleMode: SCALE_MODE_MAP[src.scaleMode] || 'FILL',
    imageLeftPct: 0,
    imageTopPct: 0,
    imageWidthPct: 100,
    imageHeightPct: 100,
  };
}

function extractMockData(tree) {
  const out = {};
  let idx = 0;
  walk(tree, (n) => {
    if (n.kind === 'text' && n.text?.content) {
      const key = n.name ? slugify(n.name) : `text_${idx}`;
      out[key] = n.text.content;
      idx++;
    }
  });
  return out;
}

// ---------- helpers ----------

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function sigOf(obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

async function writeYaml(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const yaml = YAML.dump(obj, { lineWidth: 120, noRefs: true });
  await writeFile(path, yaml);
}

function routeFromName(name) {
  const s = slugify(name);
  if (s === 'login') return '/login';
  return `/${s}`;
}

async function exists(path) {
  try { await access(path, FS_CONST.F_OK); return true; } catch { return false; }
}

async function safeVariables(fileKey) {
  try { return await client.getLocalVariables(fileKey); } catch (err) {
    if (err instanceof FigmaError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function parseFlags(rawArgs) {
  const out = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    if (body.includes('=')) {
      const [k, v] = body.split('=');
      out[k] = v;
    } else {
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('--')) { out[body] = next; i++; }
      else out[body] = true;
    }
  }
  return out;
}

function log(msg) { console.error(`[audit] ${msg}`); }
function fail(msg) { console.error(`[audit] ${msg}`); process.exit(1); }
