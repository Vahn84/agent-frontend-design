#!/usr/bin/env node
/**
 * check-contract-completeness.mjs (R49, R50)
 *
 * Raw ↔ contract diff. For each node in cached raw Figma responses, enumerate
 * non-default "meaningful" fields. For each, verify the emitted contract has a
 * corresponding derived value. Fields present in raw but missing from contract
 * = silently dropped.
 *
 * Usage:
 *   node scripts/check-contract-completeness.mjs [--contract design-contract/pages/<slug>] [--page <slug>]
 *   (auto-discovers page from --contract path; falls back to all pages.)
 *
 * Exit 0 = no drops. Exit 1 = drops found (reports nodeId + field + rawValue).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
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

const CONTRACT_ROOT = flags.contract
  ? (flags.contract.startsWith('/') ? flags.contract : join(ROOT, flags.contract))
  : join(ROOT, 'design-contract');
const SINGLE_PAGE = flags.page || null;

function fail(msg) { console.error(`[completeness] ${msg}`); process.exit(1); }
function log(msg) { console.log(`[completeness] ${msg}`); }

const RAW_CACHE = join(CONTRACT_ROOT, '.audit-cache', 'raw');
if (!existsSync(RAW_CACHE)) fail(`no raw cache at ${RAW_CACHE} — run A1/A2 first`);

// ---------- load every cached raw response + build nodeId → raw-node index ----------
const rawById = new Map();
for (const f of readdirSync(RAW_CACHE)) {
  if (!f.endsWith('.json') || !f.includes('_nodes_')) continue;
  try {
    const body = JSON.parse(readFileSync(join(RAW_CACHE, f), 'utf8'));
    for (const entry of Object.values(body.nodes || {})) {
      if (!entry?.document) continue;
      walkRaw(entry.document, (n) => { if (n.id) rawById.set(n.id, n); });
    }
  } catch {}
}
log(`raw nodes indexed: ${rawById.size}`);

function walkRaw(n, fn) { fn(n); for (const c of n.children || []) walkRaw(c, fn); }

// ---------- load contract screen trees ----------
const contractById = new Map();
const pagesDir = join(CONTRACT_ROOT, 'pages');
if (!existsSync(pagesDir)) fail(`no contract pages at ${pagesDir}`);

const pageSlugs = SINGLE_PAGE ? [SINGLE_PAGE] : readdirSync(pagesDir).filter((d) => {
  try { return statSync(join(pagesDir, d)).isDirectory(); } catch { return false; }
});

for (const slug of pageSlugs) {
  const screensDir = join(pagesDir, slug, 'screens');
  if (!existsSync(screensDir)) continue;
  for (const f of readdirSync(screensDir).filter((x) => x.endsWith('.yml'))) {
    try {
      const body = YAML.load(readFileSync(join(screensDir, f), 'utf8'));
      for (const root of body.tree || []) walkContract(root);
    } catch {}
  }
  const componentsDir = join(pagesDir, slug, 'components');
  if (existsSync(componentsDir)) {
    for (const f of readdirSync(componentsDir).filter((x) => x.endsWith('.yml'))) {
      try {
        const body = YAML.load(readFileSync(join(componentsDir, f), 'utf8'));
        for (const v of body.variants || []) {
          // variant has nodeId + sometimes nested tree under `tree` / `children`
          if (v.nodeId) contractById.set(v.nodeId, v);
          walkContract(v);
        }
      } catch {}
    }
  }
}
function walkContract(n) {
  if (!n) return;
  if (n.id) contractById.set(n.id, n);
  if (n.nodeId) contractById.set(n.nodeId, n);
  for (const c of n.children || []) walkContract(c);
}
log(`contract nodes indexed: ${contractById.size}`);

// ---------- detector spec ----------
// Each entry: field name, default-check, contract-presence-check.
const DETECTORS = [
  {
    field: 'imageTransform',
    detect: (raw) => {
      const paint = (raw.fills || []).find((f) => f.type === 'IMAGE');
      if (!paint?.imageTransform) return null;
      const [[sx, , tx], [, sy, ty]] = paint.imageTransform;
      const identity = Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6 && Math.abs(tx) < 1e-6 && Math.abs(ty) < 1e-6;
      return identity ? null : paint.imageTransform;
    },
    contractHas: (cn) => {
      // Expect R29 crop pcts with at least one non-default value.
      const f = cn?.imageFrame;
      if (!f) return false;
      return !(f.imageLeftPct === 0 && f.imageTopPct === 0 && f.imageWidthPct === 100 && f.imageHeightPct === 100);
    },
  },
  {
    field: 'opacity',
    detect: (raw) => (typeof raw.opacity === 'number' && raw.opacity < 1) ? raw.opacity : null,
    contractHas: (cn) => cn?.opacity != null && cn.opacity < 1,
  },
  {
    field: 'rotation',
    detect: (raw) => (typeof raw.rotation === 'number' && Math.abs(raw.rotation) > 1e-6) ? raw.rotation : null,
    contractHas: (cn) => cn?.rotation != null && Math.abs(cn.rotation) > 1e-6,
  },
  {
    field: 'blendMode',
    detect: (raw) => {
      const bm = raw.blendMode;
      return (bm && bm !== 'NORMAL' && bm !== 'PASS_THROUGH') ? bm : null;
    },
    contractHas: (cn) => cn?.blendMode && cn.blendMode !== 'NORMAL' && cn.blendMode !== 'PASS_THROUGH',
  },
  {
    field: 'strokeDashes',
    detect: (raw) => Array.isArray(raw.strokeDashes) && raw.strokeDashes.length ? raw.strokeDashes : null,
    contractHas: (cn) => cn?.border?.style === 'dashed',
  },
  {
    field: 'layoutGrids',
    detect: (raw) => Array.isArray(raw.layoutGrids) && raw.layoutGrids.length ? raw.layoutGrids : null,
    contractHas: (cn) => cn?.layoutGrids && cn.layoutGrids.length,
  },
  {
    field: 'textAlignVertical',
    detect: (raw) => {
      if (raw.type !== 'TEXT') return null;
      const v = raw.style?.textAlignVertical;
      return v && v !== 'TOP' ? v : null;
    },
    contractHas: (cn) => cn?.text?.verticalAlign && cn.text.verticalAlign !== 'top',
  },
  {
    field: 'constraints',
    detect: (raw) => {
      const c = raw.constraints;
      if (!c) return null;
      const defaultLike = (c.horizontal === 'MIN' || c.horizontal === 'LEFT') && (c.vertical === 'MIN' || c.vertical === 'TOP');
      return defaultLike ? null : c;
    },
    contractHas: (cn) => cn?.constraints,
  },
];

// ---------- scan ----------
const drops = [];
let checked = 0;
for (const [id, raw] of rawById) {
  const cn = contractById.get(id);
  if (!cn) continue; // node not in contract (component masters, library, etc.) — not our concern
  checked++;
  for (const d of DETECTORS) {
    const rawVal = d.detect(raw);
    if (rawVal == null) continue;
    if (d.contractHas(cn)) continue;
    drops.push({ nodeId: id, nodeName: raw.name, field: d.field, rawValue: summarize(rawVal) });
  }
}
function summarize(v) {
  if (Array.isArray(v)) return JSON.stringify(v).slice(0, 120);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
  return String(v);
}

log(`scanned ${checked} node(s) across ${DETECTORS.length} detector(s)`);

if (drops.length === 0) {
  console.log('\n[completeness] PASS — no silently-dropped fields');
  process.exit(0);
}

const byField = drops.reduce((a, d) => { (a[d.field] ||= []).push(d); return a; }, {});
console.log(`\n[completeness] FAIL — ${drops.length} silently-dropped field(s):`);
for (const field of Object.keys(byField).sort()) {
  const list = byField[field];
  console.log(`\n  ${field} (${list.length}):`);
  for (const d of list.slice(0, 10)) {
    console.log(`    node=${d.nodeId} name="${d.nodeName}" raw=${d.rawValue}`);
  }
  if (list.length > 10) console.log(`    ... +${list.length - 10} more`);
}
process.exit(1);
