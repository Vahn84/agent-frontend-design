#!/usr/bin/env node
/**
 * audit-index.mjs  —  Phase A1 (page inventory)
 *
 * Cheap, non-destructive walk of the Figma file. Writes `design-contract/index.yml`
 * listing every page, every screen (≥1280px top-level frame), absolute X for
 * sort order, and high-level token/style counts. Does NOT export icons, does
 * NOT walk screen trees, does NOT derive components — that happens in A2
 * (`scripts/audit-page.mjs` / AUDIT.md PAGE mode).
 *
 * Usage:
 *   FIGMA_PAT=... node scripts/audit-index.mjs --url <figma-url> [--contract <dir>]
 *   FIGMA_PAT=... node scripts/audit-index.mjs --file-key <key>  [--contract <dir>]
 *
 * Flags:
 *   --url <figma-url>       parse fileKey from URL
 *   --file-key <key>        pass fileKey directly
 *   --contract <dir>        output dir (default: design-contract/)
 *   --force-refresh         ignore REST cache
 *
 * Output: <contract>/index.yml
 */
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';
import { createClient } from '../lib/figma.mjs';
import { parseFigmaUrl } from '../lib/url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(name);

const url = getFlag('--url');
const cliFileKey = getFlag('--file-key');
const contract = getFlag('--contract') || join(ROOT, 'design-contract');
const forceRefresh = hasFlag('--force-refresh');

const pat = process.env.FIGMA_PAT;
if (!pat) { console.error('[audit-index] FIGMA_PAT env var required'); process.exit(1); }

let fileKey = cliFileKey;
if (!fileKey && url) ({ fileKey } = parseFigmaUrl(url));
if (!fileKey) { console.error('[audit-index] need --url or --file-key'); process.exit(1); }

const cacheDir = join(contract, '.audit-cache', 'raw');
if (forceRefresh && existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const client = createClient({ pat, cacheDir });

const slugify = (s) => s.toLowerCase()
  .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
  .replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Name-hierarchy overlay detection (A1).
 *
 * Figma convention in ASPI-style files: "<Base>/<Overlay>" or nested
 * "<Base>/<Overlay>/<State>". Siblings share the same base dimensions.
 *
 * Heuristic:
 * 1. Sort entries by name segment count ASC, then by x.
 * 2. For each entry, walk parent prefix candidates ("a/b/c" → "a/b" → "a").
 *    First candidate whose slug matches an already-seen entry AND whose
 *    dimensions equal the current entry = parent. Record role=overlay +
 *    overlayOf=<parent slug>. Chain implicit via parent's own role.
 * 3. No parent match → role=base.
 *
 * Dimension match tolerance: exact width + height. Overlays that add a
 * modal often render at the same frame size. If width matches but height
 * grows (e.g. Filtri panel pushes content down), still treat as overlay
 * when width matches — height diff is the overlay payload.
 */
function annotateOverlays(entries) {
  const sorted = [...entries].sort((a, b) => {
    const da = (a.name.match(/\//g) || []).length;
    const db = (b.name.match(/\//g) || []).length;
    return da - db || a.x - b.x;
  });
  const bySlug = new Map();
  for (const e of sorted) {
    const segs = e.name.split('/');
    let parent = null;
    for (let cut = segs.length - 1; cut > 0; cut--) {
      const candidate = segs.slice(0, cut).join('/');
      const candSlug = slugify(candidate);
      const hit = bySlug.get(candSlug);
      if (hit && hit.width === e.width) { parent = hit; break; }
    }
    if (parent) {
      e.role = 'overlay';
      e.overlayOf = parent.slug;
      e.overlayDepth = (parent.overlayDepth || 0) + 1;
    } else {
      e.role = 'base';
    }
    bySlug.set(e.slug, e);
  }
}

async function main() {
  console.log(`[audit-index] fileKey=${fileKey}`);
  const t0 = Date.now();

  const file = await client.getFile(fileKey, { depth: 2 });
  console.log(`[audit-index] file="${file.name}" (${Date.now() - t0}ms)`);

  const pages = file.document.children.filter((n) => n.type === 'CANVAS');
  const out = {
    schema: 'index/v1',
    figma: { fileKey, fileName: file.name, lastModified: file.lastModified },
    pages: [],
  };

  for (const p of pages) {
    console.log(`[audit-index] probing page "${p.name}" depth:2...`);
    const resp = await client.getFileNodes(fileKey, [p.id], { depth: 2 });
    const doc = resp.nodes[p.id]?.document;
    const kids = doc?.children || [];
    // R-visibility: skip hidden top-level screens. Designer unhides in Figma to include.
    const frames = kids.filter((k) => (k.type === 'FRAME' || k.type === 'SECTION') && k.visible !== false);
    const screens = frames
      .filter((k) => (k.absoluteBoundingBox?.width || 0) >= 1280)
      .sort((a, b) => a.absoluteBoundingBox.x - b.absoluteBoundingBox.x);
    const entries = screens.map((s) => ({
      name: s.name,
      slug: slugify(s.name),
      nodeId: s.id,
      width: Math.round(s.absoluteBoundingBox.width),
      height: Math.round(s.absoluteBoundingBox.height),
      x: Math.round(s.absoluteBoundingBox.x),
    }));
    annotateOverlays(entries);
    out.pages.push({
      name: p.name,
      slug: slugify(p.name),
      nodeId: p.id,
      screenCount: entries.length,
      baseCount: entries.filter((e) => e.role === 'base').length,
      overlayCount: entries.filter((e) => e.role === 'overlay').length,
      screens: entries,
    });
  }

  console.log(`[audit-index] tokens probe...`);
  try {
    const vars = await client.getLocalVariables(fileKey);
    out.tokens = {
      source: 'variables',
      collections: Object.keys(vars.meta?.variableCollections || {}).length,
      variables: Object.keys(vars.meta?.variables || {}).length,
    };
  } catch (e) {
    console.log(`[audit-index]   variables unavailable (${e.message}) — fallback to styles`);
    out.tokens = { source: 'styles', note: e.message };
  }

  try {
    const styles = await client.getFileStyles(fileKey);
    const s = styles.meta?.styles || [];
    out.styles = s.reduce((a, x) => { a[x.style_type] = (a[x.style_type] || 0) + 1; return a; }, {});
  } catch (e) {
    out.styles = { error: e.message };
  }

  mkdirSync(contract, { recursive: true });
  const outPath = join(contract, 'index.yml');
  writeFileSync(outPath, YAML.dump(out, { lineWidth: 120, noRefs: true }));
  const totalScreens = out.pages.reduce((a, p) => a + p.screenCount, 0);
  console.log(`[audit-index] wrote ${outPath}  pages:${out.pages.length}  screens:${totalScreens}  ${Date.now() - t0}ms`);
}

main().catch((e) => { console.error('[audit-index] FAIL', e.stack || e.message); process.exit(1); });
