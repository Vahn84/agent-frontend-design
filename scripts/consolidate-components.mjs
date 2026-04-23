#!/usr/bin/env node
/**
 * consolidate-components.mjs
 *
 * Post-audit pass: deduplicate components across pages by structural fingerprint.
 * Merges clusters with the same shape (dims, spacing, layout, children structure)
 * into a single canonical component — color + icon differences become variants, not
 * separate components. Survivors go to `design-contract/components/` (shared).
 *
 * Also promotes single-vector tight containers to `IconButton` (collapses the
 * Icons1…IconsN explosion that arises when designers use a common name across
 * many distinct Figma components).
 *
 * Emits:
 *   design-contract/components/<CanonicalName>.yml   (variants merged)
 *   design-contract/components/index.yml             (mainComponentKey → canonicalName)
 *   design-contract/components/consolidation-log.yml (audit trail: merges, promotions, untouched)
 *
 * Per-page files in `design-contract/pages/<slug>/components/` are left in place for
 * traceability. `prepare-build.mjs` + build agents prefer the shared registry when
 * present (see R43).
 *
 * Usage:
 *   node scripts/consolidate-components.mjs [--contract design-contract] [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const flags = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
})();

const CONTRACT = flags.contract || join(ROOT, 'design-contract');
const DRY = !!flags['dry-run'];

if (!existsSync(CONTRACT)) fail(`contract dir not found: ${CONTRACT}`);

const PAGES_DIR = join(CONTRACT, 'pages');
const OUT_DIR = join(CONTRACT, 'components');

function fail(msg) { console.error(`[consolidate] ${msg}`); process.exit(1); }
function log(msg) { console.log(`[consolidate] ${msg}`); }

// ---------- load ----------
function loadAllPageComponents() {
  if (!existsSync(PAGES_DIR)) return [];
  const entries = [];
  const pageSlugs = readdirSync(PAGES_DIR).sort();
  for (const pageSlug of pageSlugs) {
    const compDir = join(PAGES_DIR, pageSlug, 'components');
    if (!existsSync(compDir)) continue;
    const files = readdirSync(compDir).sort();
    for (const f of files) {
      if (!f.endsWith('.yml')) continue;
      const path = join(compDir, f);
      try {
        const body = YAML.load(readFileSync(path, 'utf8'));
        if (body && typeof body === 'object') entries.push({ pageSlug, file: f, path, body });
      } catch (err) { log(`  ⚠ skip ${path}: ${err.message}`); }
    }
  }
  return entries;
}

// ---------- fingerprinting ----------
// Ignores colors, glyph names, text content — only shape.
function dimsBucket(d) {
  if (!d || typeof d !== 'object') return 'auto';
  const w = d.width ?? 'auto';
  const h = d.height ?? 'auto';
  return `${w}x${h}`;
}

function spacingSig(sp) {
  if (!sp) return '';
  return `g${sp.gap ?? 0}|t${sp.paddingTop ?? 0}|r${sp.paddingRight ?? 0}|b${sp.paddingBottom ?? 0}|l${sp.paddingLeft ?? 0}`;
}

function variantFingerprint(v) {
  // Order-sensitive signature of direct structure. Variant-level only — deep child trees
  // are captured implicitly via child count + each icon slot.
  const sig = [
    `ls:${v.layoutSizing?.horizontal || '?'}/${v.layoutSizing?.vertical || '?'}`,
    `dims:${dimsBucket(v.dimensions)}`,
    `sp:${spacingSig(v.spacing)}`,
    `r:${typeof v.radius === 'object' ? JSON.stringify(v.radius) : (v.radius ?? 0)}`,
    `ic:${(v.icons || []).length}`,
    `tp:${(v.typography || []).length}`,
  ];
  return sig.join('|');
}

function componentFingerprint(c) {
  // A component's fingerprint = sorted union of its variants' fingerprints.
  // Two components with the same set of variant shapes collapse into one, regardless
  // of color/glyph differences (which become new variant rows).
  const variantSigs = (c.variants || []).map(variantFingerprint).sort();
  // Also include classification kind so a `library-wrapped` Button never merges with a
  // `custom` box of the same dims.
  const kind = c.classification?.kind || 'custom';
  const lib = c.classification?.libraryComponent || '';
  return `k:${kind}|l:${lib}|v:[${variantSigs.join(';')}]`;
}

// ---------- IconButton promotion ----------
// INSTANCE-like (custom) component whose only variant is:
//   - dims ≤ 56×56 (square or circular)
//   - contains exactly one icon slot + no text
//   - has radius (round or square — either is fine)
function isIconButtonShape(c) {
  if (c.classification?.kind !== 'custom') return false;
  const v0 = c.variants?.[0];
  if (!v0) return false;
  const d = v0.dimensions;
  if (!d?.width || !d?.height) return false;
  if (d.width > 56 || d.height > 56) return false;
  if (Math.abs(d.width - d.height) > 2) return false; // require roughly square
  const iconCount = (v0.icons || []).length;
  const typoCount = (v0.typography || []).length;
  if (iconCount !== 1) return false;
  if (typoCount !== 0) return false;
  return true;
}

// ---------- merge ----------
function mergeComponents(group) {
  // Preserve first occurrence as canonical. Collect mainComponentKeys + rawNames.
  const first = group[0];
  const canonical = {
    name: first.body.name,
    classification: first.body.classification,
    variants: [],
    mainComponentKeys: [],
    sources: [],
  };

  // Aggregate variants across all merged components. Re-dedup by variantFingerprint
  // so identical variants (same color) collapse even across pages.
  const seenVariant = new Map();
  let variantIdx = 0;
  for (const g of group) {
    const key = g.body.mainComponentKey;
    if (key && !canonical.mainComponentKeys.includes(key)) canonical.mainComponentKeys.push(key);
    canonical.sources.push({ pageSlug: g.pageSlug, file: g.file, rawName: g.body.name });
    for (const v of g.body.variants || []) {
      const sig = variantFingerprint(v) + '|colors:' + JSON.stringify(v.colors || {}) + '|icons:' + (v.icons || []).map((i) => i.iconName).sort().join(',');
      if (seenVariant.has(sig)) {
        // Append instances to existing variant.
        const existing = seenVariant.get(sig);
        existing.instances = [...(existing.instances || []), ...(v.instances || [])];
      } else {
        const name = variantIdx === 0 ? 'default' : `variant-${variantIdx + 1}`;
        const clone = { ...v, name };
        seenVariant.set(sig, clone);
        canonical.variants.push(clone);
        variantIdx++;
      }
    }
  }
  return canonical;
}

function promoteIconButton(merged) {
  // Rename to IconButton; record original as alias.
  const aliases = merged.sources.map((s) => s.rawName).filter(Boolean);
  return {
    ...merged,
    name: 'IconButton',
    classification: {
      kind: 'library-wrapped',
      libraryComponent: 'Button',
      importPath: 'primereact/button',
      wrappedPrimitive: 'button',
      via: 'promotion',
    },
    promotedFrom: aliases,
  };
}

// ---------- canonical naming ----------
function canonicalName(fingerprint, existingNames, seedName) {
  // Strip trailing digits from source names (e.g. "Icons19" → "Icons"), then
  // dedupe against existingNames.
  const base = (seedName || 'Component').replace(/\d+$/, '') || 'Component';
  if (!existingNames.has(base)) return base;
  let n = 2;
  while (existingNames.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// ---------- main ----------
(function main() {
  const entries = loadAllPageComponents();
  log(`loaded ${entries.length} per-page component file(s) across ${new Set(entries.map(e => e.pageSlug)).size} page(s)`);

  // Group by fingerprint.
  const byFp = new Map();
  for (const e of entries) {
    if (!e.body.variants?.length) continue;
    const fp = componentFingerprint(e.body);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(e);
  }

  log(`${byFp.size} distinct fingerprint(s) found (= canonical component count)`);

  // Merge per fingerprint.
  const firstPass = [];
  for (const [fp, group] of byFp) {
    let m = mergeComponents(group);
    let promoted = false;
    if (isIconButtonShape({ classification: m.classification, variants: m.variants })) {
      m = promoteIconButton(m);
      promoted = true;
    }
    firstPass.push({ fp, merged: m, group, promoted });
  }

  // Second pass: fold all post-promotion IconButton buckets into a single canonical
  // IconButton (regardless of per-item fingerprint — they were different shapes that
  // happen to match the same library role). Skip for non-promoted components.
  const promotedBuckets = firstPass.filter((e) => e.promoted);
  const untouched = firstPass.filter((e) => !e.promoted);

  let iconButton = null;
  const promotions = [];
  for (const b of promotedBuckets) {
    if (!iconButton) {
      iconButton = b.merged;
      iconButton.name = 'IconButton';
    } else {
      // Fold b.merged into iconButton: append variants (renumber), append keys + sources.
      for (const k of b.merged.mainComponentKeys) {
        if (!iconButton.mainComponentKeys.includes(k)) iconButton.mainComponentKeys.push(k);
      }
      iconButton.sources.push(...(b.merged.sources || []));
      iconButton.promotedFrom = [...new Set([...(iconButton.promotedFrom || []), ...(b.merged.promotedFrom || [])])];
      for (const v of b.merged.variants || []) {
        const ibIdx = iconButton.variants.length;
        iconButton.variants.push({ ...v, name: ibIdx === 0 ? 'default' : `variant-${ibIdx + 1}` });
      }
    }
  }
  if (iconButton) promotions.push({ name: 'IconButton', from: iconButton.promotedFrom, variantCount: iconButton.variants.length, keyCount: iconButton.mainComponentKeys.length });

  // Compose final list.
  const existingNames = new Set();
  const keyToName = {};
  const merged = [];
  if (iconButton) {
    existingNames.add('IconButton');
    for (const k of iconButton.mainComponentKeys) keyToName[k] = 'IconButton';
    merged.push({ fp: 'promoted:IconButton', merged: iconButton, group: promotedBuckets.flatMap((b) => b.group) });
  }
  for (const b of untouched) {
    const name = canonicalName(b.fp, existingNames, b.merged.name);
    b.merged.name = name;
    existingNames.add(name);
    for (const k of b.merged.mainComponentKeys) keyToName[k] = name;
    merged.push({ fp: b.fp, merged: b.merged, group: b.group });
  }

  log(`consolidation: ${entries.length} → ${merged.length} component(s) (${entries.length - merged.length} merged away)`);
  if (promotions.length) log(`  IconButton promotions: ${promotions.length}`);

  if (DRY) {
    log('--dry-run — no files written');
    for (const m of merged.slice(0, 10)) {
      console.log(`  ${m.merged.name}: ${m.merged.variants.length} variants, keys=${m.merged.mainComponentKeys.length}, sources=${m.merged.sources.map(s => s.pageSlug + '/' + s.rawName).join(', ')}`);
    }
    return;
  }

  // Write shared registry.
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const m of merged) {
    const outPath = join(OUT_DIR, `${m.merged.name}.yml`);
    writeFileSync(outPath, YAML.dump(m.merged, { noRefs: true, lineWidth: 120 }));
  }

  // Index.
  const index = {
    schema: 'components-index/v1',
    generatedAt: new Date().toISOString(),
    components: merged.map((m) => ({
      name: m.merged.name,
      mainComponentKeys: m.merged.mainComponentKeys,
      classification: m.merged.classification,
      variantCount: m.merged.variants.length,
      sourcePages: [...new Set(m.merged.sources.map((s) => s.pageSlug))],
    })),
    mainComponentKeyToName: keyToName,
  };
  writeFileSync(join(OUT_DIR, 'index.yml'), YAML.dump(index, { noRefs: true, lineWidth: 120 }));

  // Log.
  const consolidationLog = {
    schema: 'consolidation-log/v1',
    generatedAt: new Date().toISOString(),
    inputComponentCount: entries.length,
    outputComponentCount: merged.length,
    promotions,
    merges: merged
      .filter((m) => m.group.length > 1)
      .map((m) => ({
        canonical: m.merged.name,
        count: m.group.length,
        sources: m.group.map((g) => `${g.pageSlug}/${g.body.name}`),
      })),
  };
  writeFileSync(join(OUT_DIR, 'consolidation-log.yml'), YAML.dump(consolidationLog, { noRefs: true, lineWidth: 120 }));

  log(`wrote ${OUT_DIR}/ (${merged.length} components + index.yml + consolidation-log.yml)`);
})();
