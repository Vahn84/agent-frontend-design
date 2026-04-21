#!/usr/bin/env node
/**
 * audit-page.mjs — A2 PAGE mode (see AUDIT.md).
 *
 * Deep-walks a single page's screens + emits a self-contained page contract at
 * design-contract/pages/<pageSlug>/{meta,tokens,typography,icons,components,screens}.
 *
 * Preconditions:
 *   - design-contract/index.yml exists (A1 output).
 *   - FIGMA_PAT env var set.
 *
 * Usage:
 *   FIGMA_PAT=... node scripts/audit-page.mjs \
 *     --file-key <key> --page-slug <slug> \
 *     [--page-node-id <id>] [--contract design-contract] \
 *     [--framework react|angular] [--styling tailwind|scss] \
 *     [--project-name <n>] [--project-path <p>] \
 *     [--library <name>] [--strategy screen-by-screen|full] \
 *     [--force-refresh]
 */
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { constants as FS_CONST } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

import { createClient, FigmaError } from '../lib/figma.mjs';
import { transformNode } from '../lib/transform.mjs';
import { buildTokenMap, collectUnresolvedKeys, slugify } from '../lib/tokens.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- PrimeReact classification map (R9) ----------
// Name patterns used in Figma → PrimeReact library component + import path.
const PRIMEREACT_MAP = [
  { pattern: /^button\b/i, libraryComponent: 'Button', importPath: 'primereact/button', wrappedPrimitive: 'button' },
  { pattern: /^icon\s*button\b/i, libraryComponent: 'Button', importPath: 'primereact/button', wrappedPrimitive: 'button' },
  { pattern: /\bcta\b/i, libraryComponent: 'Button', importPath: 'primereact/button', wrappedPrimitive: 'button' },
  { pattern: /^password\b/i, libraryComponent: 'Password', importPath: 'primereact/password', wrappedPrimitive: 'input' },
  { pattern: /^input(?:\s*text)?\b/i, libraryComponent: 'InputText', importPath: 'primereact/inputtext', wrappedPrimitive: 'input' },
  { pattern: /^textfield\b/i, libraryComponent: 'InputText', importPath: 'primereact/inputtext', wrappedPrimitive: 'input' },
  { pattern: /^text\s*field\b/i, libraryComponent: 'InputText', importPath: 'primereact/inputtext', wrappedPrimitive: 'input' },
  { pattern: /^textarea\b/i, libraryComponent: 'InputTextarea', importPath: 'primereact/inputtextarea', wrappedPrimitive: 'textarea' },
  { pattern: /^checkbox\b/i, libraryComponent: 'Checkbox', importPath: 'primereact/checkbox', wrappedPrimitive: 'checkbox' },
  { pattern: /^radio\b/i, libraryComponent: 'RadioButton', importPath: 'primereact/radiobutton', wrappedPrimitive: 'radio' },
  { pattern: /^switch\b/i, libraryComponent: 'InputSwitch', importPath: 'primereact/inputswitch', wrappedPrimitive: 'switch' },
  { pattern: /^toggle\b/i, libraryComponent: 'InputSwitch', importPath: 'primereact/inputswitch', wrappedPrimitive: 'switch' },
  { pattern: /^select\b/i, libraryComponent: 'Dropdown', importPath: 'primereact/dropdown', wrappedPrimitive: 'select' },
  { pattern: /^dropdown\b/i, libraryComponent: 'Dropdown', importPath: 'primereact/dropdown', wrappedPrimitive: 'select' },
  { pattern: /^dialog\b/i, libraryComponent: 'Dialog', importPath: 'primereact/dialog' },
  { pattern: /^modal\b/i, libraryComponent: 'Dialog', importPath: 'primereact/dialog' },
  { pattern: /^tooltip\b/i, libraryComponent: 'Tooltip', importPath: 'primereact/tooltip' },
  { pattern: /^datepicker\b/i, libraryComponent: 'Calendar', importPath: 'primereact/calendar', wrappedPrimitive: 'datepicker' },
  { pattern: /^calendar\b/i, libraryComponent: 'Calendar', importPath: 'primereact/calendar', wrappedPrimitive: 'datepicker' },
  { pattern: /^table\b/i, libraryComponent: 'DataTable', importPath: 'primereact/datatable', wrappedPrimitive: 'table' },
  { pattern: /^datatable\b/i, libraryComponent: 'DataTable', importPath: 'primereact/datatable', wrappedPrimitive: 'table' },
  { pattern: /^slider\b/i, libraryComponent: 'Slider', importPath: 'primereact/slider', wrappedPrimitive: 'slider' },
  { pattern: /^chip\b/i, libraryComponent: 'Chip', importPath: 'primereact/chip' },
  { pattern: /^tag\b/i, libraryComponent: 'Tag', importPath: 'primereact/tag' },
  { pattern: /^badge\b/i, libraryComponent: 'Badge', importPath: 'primereact/badge' },
];

function classifyByName(rawName, libraryName) {
  if (!libraryName || libraryName.toLowerCase() !== 'primereact') return { kind: 'custom' };
  const name = (rawName || '').trim();
  for (const entry of PRIMEREACT_MAP) {
    if (entry.pattern.test(name)) {
      return {
        kind: 'library-wrapped',
        libraryComponent: entry.libraryComponent,
        importPath: entry.importPath,
        ...(entry.wrappedPrimitive ? { wrappedPrimitive: entry.wrappedPrimitive } : {}),
      };
    }
  }
  return { kind: 'custom' };
}

// ---------- arg parsing ----------
const flags = parseFlags(process.argv.slice(2));

const FILE_KEY = flags['file-key'];
const PAGE_SLUG = flags['page-slug'];
const PAGE_NODE_ID_ARG = flags['page-node-id'] || null;
const CONTRACT_ROOT = flags.contract || join(ROOT, 'design-contract');
const FRAMEWORK = (flags.framework || 'react').toLowerCase();
const STYLING = (flags.styling || (FRAMEWORK === 'react' ? 'tailwind' : 'scss')).toLowerCase();
const PROJECT_NAME = flags['project-name'] || PAGE_SLUG;
const PROJECT_PATH = flags['project-path'] || `~/Documents/DEV/${PROJECT_NAME}`;
const LIBRARY_NAME = flags.library || null;
const STRATEGY_MODE = (flags.strategy || 'screen-by-screen').toLowerCase();
const FORCE_REFRESH = !!flags['force-refresh'];

if (!FILE_KEY) fail('--file-key required');
if (!PAGE_SLUG) fail('--page-slug required');
if (!process.env.FIGMA_PAT) fail('FIGMA_PAT env var required');

const PAGE_DIR = join(CONTRACT_ROOT, 'pages', PAGE_SLUG);
const CACHE_DIR = join(CONTRACT_ROOT, '.audit-cache');
const RAW_CACHE_DIR = join(CACHE_DIR, 'raw');
const ICONS_DIR = join(PAGE_DIR, 'icons');

// ---------- main ----------
const client = createClient({ cacheDir: RAW_CACHE_DIR });

await main().catch((err) => {
  if (err instanceof FigmaError) {
    console.error(`[audit-page] figma ${err.status ?? ''} ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});

async function main() {
  log(`A2 start — page=${PAGE_SLUG} file=${FILE_KEY}`);
  if (FORCE_REFRESH) await rm(PAGE_DIR, { recursive: true, force: true });
  await mkdir(PAGE_DIR, { recursive: true });
  await mkdir(ICONS_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  // 1. Resolve screens from index.yml.
  const indexPath = join(CONTRACT_ROOT, 'index.yml');
  if (!(await exists(indexPath))) fail(`index.yml not found at ${indexPath}. Run audit-index first.`);
  const index = YAML.load(await readFile(indexPath, 'utf8'));
  const pageEntry = index.pages.find((p) => p.slug === PAGE_SLUG);
  if (!pageEntry) fail(`page "${PAGE_SLUG}" not in index.yml`);
  const pageNodeId = PAGE_NODE_ID_ARG || pageEntry.nodeId;
  log(`  page "${pageEntry.name}" nodeId=${pageNodeId} screens=${pageEntry.screens.length}`);

  // 2. Tokens (file-global; Enterprise variables or styles fallback).
  log('phase 1 — tokens');
  const { tokenMap, tokensMeta } = await buildPageTokenMap(FILE_KEY);
  const unresolved = collectUnresolvedKeys(tokenMap);
  if (unresolved.length) log(`  ⚠ ${unresolved.length} unresolved lib var key(s): ${unresolved.slice(0, 3).join(', ')}${unresolved.length > 3 ? ', ...' : ''}`);
  log(`  → ${tokensMeta.unique} unique tokens (source=${tokensMeta.source})`);

  // 3. Screens (enriched subtrees).
  log('phase 2 — screens');
  // Only base screens get their own screens/ file. Overlays absorbed into modals[] (A2 6f).
  // Since Login page has 1 screen, this collapses to single-screen path.
  const baseScreens = pageEntry.screens.filter((s) => s.role === 'base');
  const enrichedScreens = [];
  for (const s of baseScreens) {
    const enriched = await auditScreen(s, tokenMap);
    enrichedScreens.push(enriched);
  }
  log(`  → ${enrichedScreens.length} screen(s)`);

  // 4. Typography.
  log('phase 3 — typography');
  const typography = extractTypography(enrichedScreens);
  log(`  → ${Object.keys(typography.styles).length} styles`);

  // 5a. Images (imageRef → CDN → download).
  log('phase 4a — images');
  const assets = await resolveAndDownloadImages(enrichedScreens);
  log(`  → ${assets.length} image assets`);

  // 5b. Icons (library Icons page batch export).
  log('phase 4b — icons');
  const iconsData = await collectIcons(enrichedScreens);
  log(`  → ${iconsData.icons.length} icons (lib=${iconsData.source.fileKey !== FILE_KEY ? iconsData.source.fileKey : 'none resolved'})`);

  // 5c. Stamp iconName on vector nodes inside icon instances.
  stampIconNames(enrichedScreens, iconsData);

  // 6. Components (derived from instance clusters in this page).
  log('phase 5 — components');
  const components = clusterComponents(enrichedScreens, {
    iconNameByComponentKey: iconsData._iconNameByComponentKey || {},
    libraryName: LIBRARY_NAME,
    tokenMap,
    typographyKeys: new Set(Object.keys(typography.styles)),
  });
  const variantCount = components.reduce((a, c) => a + c.variants.length, 0);
  log(`  → ${components.length} components (${variantCount} variants)`);

  // 7. Write contract.
  log('phase 6 — write contract');
  await writeContract({
    pageEntry,
    pageNodeId,
    tokenMap,
    typography,
    iconsData,
    enrichedScreens,
    components,
    assets,
    libraryFileKey: iconsData.source.fileKey !== FILE_KEY ? iconsData.source.fileKey : null,
  });
  log(`  → wrote ${PAGE_DIR}/`);

  // 8. Patch index.yml → audited=true.
  log('phase 7 — mark audited');
  await markAudited(indexPath, PAGE_SLUG);

  log('A2 done.');
}

// ---------- tokens ----------
async function buildPageTokenMap(fileKey) {
  let vars = null;
  try {
    vars = await client.getLocalVariables(fileKey);
  } catch (err) {
    if (!(err instanceof FigmaError && (err.status === 403 || err.status === 404))) throw err;
  }
  if (vars) {
    const tokenMap = buildTokenMap(vars);
    const deduped = dedupTokenMapByName(tokenMap);
    return { tokenMap, tokensMeta: { source: 'variables', unique: Object.keys(deduped).length } };
  }
  // Non-Enterprise fallback: seed minimal token map from styles.
  log('  ⚠ variables unavailable — falling back to file styles (non-Enterprise)');
  const styles = await client.getFileStyles(fileKey).catch(() => ({ meta: { styles: [] } }));
  const seeded = seedTokenMapFromStyles(styles);
  return { tokenMap: seeded, tokensMeta: { source: 'styles', unique: Object.keys(dedupTokenMapByName(seeded)).length } };
}

function seedTokenMapFromStyles(stylesResp) {
  const out = {};
  const list = stylesResp?.meta?.styles || [];
  for (const s of list) {
    if (s.style_type !== 'FILL') continue;
    const name = s.name.replace(/\s+/g, '-').toLowerCase();
    const id = `VariableID:style-${s.node_id}`;
    out[id] = {
      id,
      key: s.key,
      name: s.name,
      collection: 'styles',
      type: 'COLOR',
      cssVar: `--color-${slugify(s.name)}`,
      value: '#000000',
      modes: {},
    };
  }
  return out;
}

function dedupTokenMapByName(tokenMap) {
  const out = {};
  const seen = new Set();
  for (const t of Object.values(tokenMap)) {
    if (!t?.name || seen.has(t.id)) continue;
    seen.add(t.id);
    const type = mapTokenType(t.type);
    const value = sanitizeTokenValue(t.value, type);
    if (value === null) continue;
    const modesStr = {};
    for (const [k, v] of Object.entries(t.modes || {})) {
      const sv = sanitizeTokenValue(v, type);
      if (sv !== null) modesStr[k] = sv;
    }
    out[t.name] = { cssVar: t.cssVar, value, type, modes: modesStr };
  }
  return out;
}

function sanitizeTokenValue(raw, type) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (type === 'color') return s;
  if (type === 'number') return s;
  const isCssSafe = /^[a-zA-Z0-9#%.\-_]+$/.test(s);
  return isCssSafe ? s : `"${s.replace(/"/g, '\\"')}"`;
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

// ---------- screens ----------
async function auditScreen(screen, tokenMap) {
  const safeId = screen.nodeId.replace(/[:/]/g, '_');
  const cachePath = join(CACHE_DIR, `${safeId}-enriched.json`);
  if (!FORCE_REFRESH && await exists(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }
  const nodesRes = await client.getFileNodes(FILE_KEY, screen.nodeId);
  const entry = nodesRes.nodes[screen.nodeId];
  if (!entry) fail(`screen ${screen.nodeId} not in REST response`);
  const tree = transformNode(entry.document, {
    tokenMap,
    components: entry.components,
    componentSets: entry.componentSets,
    styles: entry.styles,
  });
  const enriched = {
    screenId: screen.nodeId,
    name: screen.name,
    slug: screen.slug,
    route: routeFromSlug(screen.slug),
    viewportFit: 'fill',
    dimensions: { width: screen.width, height: screen.height },
    layoutSizing: tree.layoutSizing ?? { horizontal: 'FIXED', vertical: 'FIXED' },
    tree,
  };
  await writeFile(cachePath, JSON.stringify(enriched));
  return enriched;
}

// ---------- typography ----------
function extractTypography(screens) {
  const sigMap = new Map();
  let counter = 0;
  for (const s of screens) {
    walk(s.tree, (n) => {
      if (n.kind !== 'text' || !n.text?.style) return;
      const st = n.text.style;
      const sig = JSON.stringify({ f: st.fontFamily, s: st.fontSize, w: st.fontWeight, lh: st.lineHeight, ls: st.letterSpacing });
      if (!sigMap.has(sig)) {
        const name = `t${++counter}`;
        sigMap.set(sig, {
          name,
          style: {
            fontFamily: st.fontFamily || 'inherit',
            fontSize: withUnit(st.fontSize, 'px'),
            fontWeight: st.fontWeight || 400,
            lineHeight: withUnit(st.lineHeight, 'px'),
            letterSpacing: withUnit(st.letterSpacing, 'px'),
            textTransform: caseToTransform(st.textCase),
            textDecoration: st.textDecoration || null,
          },
        });
      }
      n._textStyleName = sigMap.get(sig).name;
    });
  }
  const styles = {};
  for (const { name, style } of sigMap.values()) {
    const out = {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
    if (style.letterSpacing) out.letterSpacing = style.letterSpacing;
    if (style.textTransform) out.textTransform = style.textTransform;
    if (style.textDecoration) out.textDecoration = style.textDecoration;
    styles[name] = out;
  }
  return { styles };
}

function caseToTransform(tc) {
  if (!tc || tc === 'ORIGINAL') return null;
  return { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[tc] ?? null;
}

function withUnit(v, unit) {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  return `${v}${unit}`;
}

// ---------- images ----------
async function resolveAndDownloadImages(enrichedScreens) {
  const refNodes = new Map();
  for (const s of enrichedScreens) {
    walk(s.tree, (n) => {
      const ref = n.imageFrame?.imageRef;
      if (!ref) return;
      if (!refNodes.has(ref)) refNodes.set(ref, { nodes: [], name: slugifyName(n.name || 'image') });
      refNodes.get(ref).nodes.push(n);
    });
  }
  if (!refNodes.size) return [];

  const { meta } = await client.getImageFills(FILE_KEY);
  const imageMap = meta?.images ?? {};
  const IMAGES_DIR = join(PAGE_DIR, 'images');
  await mkdir(IMAGES_DIR, { recursive: true });

  const assets = [];
  for (const [ref, info] of refNodes) {
    const url = imageMap[ref];
    if (!url) { log(`  ⚠ no URL for imageRef ${ref.slice(0, 8)}…`); continue; }
    const buf = await client.downloadUrl(url);
    const ext = detectImageExt(buf);
    const assetName = uniqueAssetName(assets, info.name || `img-${ref.slice(0, 6)}`);
    const relPath = join('images', `${assetName}.${ext}`);
    await writeFile(join(PAGE_DIR, relPath), buf);
    for (const n of info.nodes) n._assetName = assetName;
    assets.push({
      kind: 'image',
      name: assetName,
      path: `src/assets/images/${assetName}.${ext}`,
      figmaNodeId: info.nodes[0].id,
    });
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
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57) return 'webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x3c) return 'svg';
  return 'bin';
}

// ---------- icons ----------
async function collectIcons(enrichedScreens) {
  const iconOccurrences = [];
  for (const s of enrichedScreens) {
    walk(s.tree, (n) => {
      if (n.kind === 'vector' && n.icon) {
        iconOccurrences.push({ node: n, mainKey: null });
      } else if (n.kind === 'instance' && n.children?.length === 1 && n.children[0].kind === 'vector') {
        iconOccurrences.push({ node: n.children[0], mainKey: n.componentRef?.mainComponentKey });
      }
    });
  }
  if (!iconOccurrences.length) return { source: { fileKey: FILE_KEY }, strategy: 'svg', icons: [] };

  const uniqueKeys = [...new Set(iconOccurrences.map((o) => o.mainKey).filter(Boolean))];
  if (!uniqueKeys.length) return buildPlaceholderIcons(iconOccurrences);

  let libraryFileKey = null;
  let tried = 0;
  for (const key of uniqueKeys) {
    tried++;
    try {
      const resp = await client.getComponent(key);
      if (resp?.meta?.file_key) {
        libraryFileKey = resp.meta.file_key;
        log(`  → library resolved after ${tried} probe(s): ${libraryFileKey}`);
        break;
      }
    } catch (err) {
      if (!(err instanceof FigmaError && err.status === 404)) {
        log(`  ⚠ getComponent(${key.slice(0, 8)}…) ${err.message}`);
      }
    }
  }
  if (!libraryFileKey) {
    log(`  ⚠ library unresolvable from ${uniqueKeys.length} icon key(s)`);
    return buildPlaceholderIcons(iconOccurrences);
  }

  const libFile = await client.getFile(libraryFileKey, { depth: 3 });
  const iconsPage = libFile.document.children.find((p) => /^icons?$/i.test(p.name) || p.name.toLowerCase().includes('icon'));
  if (!iconsPage) return buildPlaceholderIcons(iconOccurrences);

  const iconComponents = (iconsPage.children || []).filter((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET');
  const flatIcons = iconComponents.flatMap((n) => (n.type === 'COMPONENT_SET' ? n.children || [] : [n])).filter((n) => n.type === 'COMPONENT');
  if (!flatIcons.length) return buildPlaceholderIcons(iconOccurrences);

  const libComponents = libFile.components ?? {};
  const keyOf = (iconNode) => libComponents[iconNode.id]?.key ?? null;

  const batches = chunk(flatIcons.map((n) => n.id), 50);
  const icons = [];
  const iconNameByComponentKey = {};
  for (const batch of batches) {
    let response = null;
    let attempt = 0;
    while (attempt < 3) {
      try {
        response = await client.getImages(libraryFileKey, batch, { format: 'svg', svgSimplifyStroke: true });
        break;
      } catch (err) {
        attempt++;
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    const { images = {} } = response;
    for (const iconNode of flatIcons.filter((n) => batch.includes(n.id))) {
      const name = slugifyName(iconNode.name);
      const componentKey = keyOf(iconNode);
      if (componentKey) iconNameByComponentKey[componentKey] = name;
      const url = images[iconNode.id];
      if (!url) {
        log(`  ⚠ null URL for icon ${name} (${iconNode.id}) — skipping`);
        continue;
      }
      const svg = await client.downloadUrl(url);
      const relPath = join('icons', `${name}.svg`);
      await writeFile(join(PAGE_DIR, relPath), svg);
      icons.push({
        name,
        nodeId: iconNode.id,
        vectorNodeId: iconNode.id,
        componentKey: componentKey || undefined,
        svgPath: relPath,
      });
    }
  }
  return {
    source: { fileKey: libraryFileKey, pageId: iconsPage.id },
    strategy: 'svg',
    icons,
    _iconNameByComponentKey: iconNameByComponentKey,
  };
}

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

function buildPlaceholderIcons(occurrences) {
  const names = new Map();
  for (const o of occurrences) {
    const name = slugifyName(o.node.name || 'icon');
    if (!names.has(name)) names.set(name, { name, nodeId: o.node.id, vectorNodeId: o.node.id });
  }
  return { source: { fileKey: FILE_KEY }, strategy: 'svg', icons: [...names.values()] };
}

function slugifyName(name) {
  return slugify((name || 'icon').replace(/[/]/g, '-')) || 'icon';
}

// ---------- components ----------
function clusterComponents(enrichedScreens, ctx) {
  const groups = new Map();
  for (const s of enrichedScreens) {
    walk(s.tree, (n) => {
      if (n.kind !== 'instance' || !n.componentRef) return;
      const key = n.componentRef.mainComponentKey || n.componentRef.componentSetKey || n.componentRef.componentId;
      if (!key) return;
      if (!groups.has(key)) {
        const rawName = n.componentRef.componentSetName || n.componentRef.componentName || n.name;
        groups.set(key, { rawName, instances: [] });
      }
      groups.get(key).instances.push({ screenNodeId: s.screenId, instanceNodeId: n.id, node: n });
    });
  }

  const components = [];
  const usedNames = new Set();
  for (const [key, g] of groups) {
    const baseName = deriveComponentName(g.rawName);
    const classification = classifyByName(g.rawName, ctx.libraryName);
    const variants = deriveVariants(g.instances, ctx);
    // Skip any component whose variants are all empty (no tree decoration observed).
    // R8: must have at least 'default'.
    if (!variants.length) continue;
    const name = uniqueName(usedNames, baseName);
    usedNames.add(name);
    components.push({
      name,
      nodeId: g.instances[0].instanceNodeId,
      classification,
      variants,
      mainComponentKey: key,
    });
  }
  return components;
}

function deriveComponentName(raw) {
  if (!raw) return 'Component';
  const first = raw.split('/')[0].trim();
  const pascal = first.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join('');
  return pascal || 'Component';
}

function uniqueName(taken, base) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function deriveVariants(instances, ctx) {
  const bySig = new Map();
  for (const inst of instances) {
    const sig = variantSignature(inst.node);
    if (!bySig.has(sig)) bySig.set(sig, { instances: [], node: inst.node });
    bySig.get(sig).instances.push({ screenNodeId: inst.screenNodeId, instanceNodeId: inst.instanceNodeId });
  }
  const variants = [];
  let i = 0;
  for (const { instances: insts, node } of bySig.values()) {
    const name = i === 0 ? 'default' : `variant-${i + 1}`;
    variants.push(buildVariant(name, node, insts, ctx));
    i++;
  }
  return variants;
}

function variantSignature(node) {
  const fills = (node.fills || []).map((f) => f.color ?? f.type).join(',');
  const radius = typeof node.radius === 'object' ? JSON.stringify(node.radius) : node.radius ?? '';
  const ls = node.layoutSizing || {};
  const dims = ls.horizontal === 'FIXED' || ls.vertical === 'FIXED'
    ? `${node.dimensions?.width}x${node.dimensions?.height}`
    : `${ls.horizontal}/${ls.vertical}`;
  const spacing = node.spacing
    ? `${node.spacing.gap ?? 0}|${node.spacing.paddingTop ?? 0}|${node.spacing.paddingRight ?? 0}|${node.spacing.paddingBottom ?? 0}|${node.spacing.paddingLeft ?? 0}`
    : '';
  const variantProps = node.componentRef?.componentProperties
    ? JSON.stringify(Object.fromEntries(Object.entries(node.componentRef.componentProperties).map(([k, v]) => [k, v.value])))
    : '';
  return `${fills}|${radius}|${dims}|${spacing}|${variantProps}`;
}

function buildVariant(name, node, instances, ctx) {
  const ls = node.layoutSizing ?? { horizontal: 'FIXED', vertical: 'FIXED' };
  const fixedH = ls.horizontal === 'FIXED';
  const fixedV = ls.vertical === 'FIXED';
  const dimensions = {
    width: fixedH ? (node.dimensions?.width ?? null) : null,
    height: fixedV ? (node.dimensions?.height ?? null) : null,
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

  walk(node, (child) => {
    if (child.kind === 'text' && child.text && child._textStyleName) {
      if (ctx.typographyKeys.has(child._textStyleName)) {
        const color = child.tokenRefs?.fills?.[0]?.name;
        const entry = { textStyle: child._textStyleName, role: (child.name || 'label').toLowerCase() };
        if (color) entry.colorToken = color;
        typography.push(entry);
      }
    }
    if (child.kind === 'vector' && child.icon) {
      const color = child.tokenRefs?.fills?.[0]?.name;
      const libName = child._iconName || null;
      if (libName) {
        const entry = { iconName: libName, visibleSizePx: child.icon.visibleSizePx || 16 };
        if (color) entry.colorToken = color;
        icons.push(entry);
      }
    }
    if (child.imageFrame) {
      imageFrames.push({
        slot: slugifyName(child.name || 'image'),
        assetName: child._assetName || slugifyName(child.name || 'image'),
        container: { widthPx: child.dimensions?.width ?? 0, heightPx: child.dimensions?.height ?? 0 },
        imageWidthPct: 100,
        imageHeightPct: 100,
        imageLeftPct: 0,
        imageTopPct: 0,
        scaleMode: ['FIT', 'FILL', 'CROP', 'TILE'].includes(child.imageFrame.scaleMode) ? child.imageFrame.scaleMode : 'FILL',
      });
    }
    const fill = child.tokenRefs?.fills?.[0];
    if (fill?.name && child.name && child !== node) colors[slugifyName(child.name)] = fill.name;
  });

  const rootFill = node.tokenRefs?.fills?.[0]?.name;
  if (rootFill) colors.root = rootFill;

  // R6: colors values must be tokens.map keys; drop refs that don't resolve.
  const tokenNameSet = new Set(Object.values(ctx.tokenMap || {}).map((t) => t?.name).filter(Boolean));
  for (const slot of Object.keys(colors)) {
    if (!tokenNameSet.has(colors[slot])) delete colors[slot];
  }

  const variant = {
    name,
    nodeId: instances[0].instanceNodeId,
    instances,
    layoutSizing: ls,
    dimensions,
    spacing,
    typography,
    colors,
    radius,
  };
  if (icons.length) variant.icons = icons;
  if (imageFrames.length) variant.imageFrames = imageFrames;
  return variant;
}

// ---------- write contract ----------
async function writeContract(params) {
  const { pageEntry, pageNodeId, tokenMap, typography, iconsData, enrichedScreens, components, assets, libraryFileKey } = params;

  const dedupedTokens = dedupTokenMapByName(tokenMap);

  // meta.yml
  const meta = {
    figma: {
      fileKey: FILE_KEY,
      pageId: pageNodeId,
      libraryFileKey: libraryFileKey ?? null,
    },
    framework: FRAMEWORK,
    styling: STYLING,
    project: { name: PROJECT_NAME, path: PROJECT_PATH },
    assets,
    strategy: {
      mode: STRATEGY_MODE,
      fixCap: 3,
      autoFixThreshold: 0.9,
      screenOrder: enrichedScreens.map((s) => s.slug),
      pageScope: PAGE_SLUG,
    },
  };
  if (LIBRARY_NAME) {
    const libComps = components
      .filter((c) => c.classification.kind === 'library-wrapped')
      .map((c) => ({
        figmaName: c.name,
        libraryComponent: c.classification.libraryComponent,
        importPath: c.classification.importPath,
        ...(c.classification.wrappedPrimitive ? { wrappedPrimitive: c.classification.wrappedPrimitive } : {}),
      }));
    meta.library = { name: LIBRARY_NAME, components: libComps };
  }
  await writeYaml(join(PAGE_DIR, 'meta.yml'), meta);

  // tokens.yml
  await writeYaml(join(PAGE_DIR, 'tokens.yml'), { map: dedupedTokens });

  // typography.yml
  await writeYaml(join(PAGE_DIR, 'typography.yml'), typography);

  // icons.yml
  const iconsOut = {
    source: iconsData.source,
    strategy: iconsData.strategy,
    icons: iconsData.icons.map(({ name, nodeId, vectorNodeId, componentKey, svgPath }) => ({
      name, nodeId, vectorNodeId,
      ...(componentKey ? { componentKey } : {}),
      ...(svgPath ? { svgPath } : {}),
    })),
  };
  await writeYaml(join(PAGE_DIR, 'icons.yml'), iconsOut);

  // screens/*.yml
  const screensDir = join(PAGE_DIR, 'screens');
  await mkdir(screensDir, { recursive: true });
  const assetNameSet = new Set(assets.map((a) => a.name));
  for (const s of enrichedScreens) {
    const outShape = {
      name: s.slug,
      nodeId: s.screenId,
      route: s.route,
      viewportFit: s.viewportFit,
      dimensions: s.dimensions,
      layoutSizing: s.layoutSizing,
      tree: [cleanTree(s.tree, { tokenNames: new Set(Object.keys(dedupedTokens)), typographyKeys: new Set(Object.keys(typography.styles)), iconNames: new Set(iconsData.icons.map((i) => i.name)), assetNames: assetNameSet })],
      mockData: extractMockData(s.tree),
    };
    await writeYaml(join(screensDir, `${s.slug}.yml`), outShape);
  }

  // components/*.yml
  const componentsDir = join(PAGE_DIR, 'components');
  await mkdir(componentsDir, { recursive: true });
  for (const c of components) {
    await writeYaml(join(componentsDir, `${slugify(c.name)}.yml`), c);
  }
}

function cleanTree(node, ctx) {
  if (!node) return null;
  const {
    componentRef, tokenRefs, fills, strokes, effects, styles, constraints, visible, type,
    _textStyleName, _assetName, _iconName,
    ...keep
  } = node;
  const out = { ...keep };

  for (const k of ['alignItems', 'justifyContent', 'direction']) {
    if (out[k] == null) delete out[k];
  }

  const rootColorToken = tokenRefs?.fills?.[0]?.name;
  if (rootColorToken && ctx.tokenNames.has(rootColorToken)) {
    out.colorToken = rootColorToken;
  }

  if (componentRef?.mainComponentKey) {
    out.mainComponentId = componentRef.componentId;
    out.mainComponentKey = componentRef.mainComponentKey;
  }

  if (node.text && _textStyleName && ctx.typographyKeys.has(_textStyleName)) {
    const txt = { ...node.text, style: _textStyleName };
    const c = tokenRefs?.fills?.[0]?.name;
    if (c && ctx.tokenNames.has(c)) txt.color = c;
    out.text = txt;
  } else if (node.text) {
    // text node without known style key — keep content only.
    out.text = { content: node.text.content, textAlign: node.text.textAlign };
  }

  if (node.kind === 'vector' && node.icon) {
    const iconName = _iconName || slugifyName(node.name || 'icon');
    if (ctx.iconNames.has(iconName)) {
      out.icon = {
        iconName,
        visibleSizePx: node.icon.visibleSizePx || 16,
        colorToken: (tokenRefs?.fills?.[0]?.name && ctx.tokenNames.has(tokenRefs?.fills?.[0]?.name)) ? tokenRefs.fills[0].name : null,
      };
    }
  }

  if (node.imageFrame) {
    const assetName = _assetName || slugifyName(node.name || 'image');
    if (ctx.assetNames.has(assetName)) {
      const SCALE_MAP = { FIT: 'FIT', FILL: 'FILL', CROP: 'CROP', TILE: 'TILE', STRETCH: 'FILL' };
      out.imageFrame = {
        assetName,
        container: { widthPx: node.dimensions?.width ?? 0, heightPx: node.dimensions?.height ?? 0 },
        scaleMode: SCALE_MAP[node.imageFrame.scaleMode] || 'FILL',
        imageLeftPct: 0,
        imageTopPct: 0,
        imageWidthPct: 100,
        imageHeightPct: 100,
      };
    } else {
      delete out.imageFrame;
    }
  }

  if (node.children) out.children = node.children.map((c) => cleanTree(c, ctx));
  return out;
}

function extractMockData(tree) {
  const out = {};
  let idx = 0;
  walk(tree, (n) => {
    if (n.kind === 'text' && n.text?.content) {
      const key = n.name ? slugify(n.name) : `text_${idx}`;
      const finalKey = out[key] !== undefined ? `${key}-${idx}` : key;
      out[finalKey] = n.text.content;
      idx++;
    }
  });
  // Ensure non-empty for R3.
  if (Object.keys(out).length === 0) {
    out._placeholder = 'no text captured';
  }
  return out;
}

// ---------- index patch ----------
async function markAudited(indexPath, slug) {
  const raw = await readFile(indexPath, 'utf8');
  const idx = YAML.load(raw);
  const page = idx.pages.find((p) => p.slug === slug);
  if (!page) fail(`cannot mark audited: page "${slug}" not in index.yml`);
  page.audited = true;
  await writeFile(indexPath, YAML.dump(idx, { lineWidth: 120, noRefs: true }));
  log(`  → index.yml page "${slug}" audited=true`);
}

// ---------- helpers ----------
function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function routeFromSlug(slug) {
  if (slug === 'login') return '/login';
  return `/${slug}`;
}

async function writeYaml(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const yaml = YAML.dump(obj, { lineWidth: 120, noRefs: true });
  await writeFile(path, yaml);
}

async function exists(p) {
  try { await access(p, FS_CONST.F_OK); return true; } catch { return false; }
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

function log(msg) { console.error(`[audit-page] ${msg}`); }
function fail(msg) { console.error(`[audit-page] ${msg}`); process.exit(1); }
