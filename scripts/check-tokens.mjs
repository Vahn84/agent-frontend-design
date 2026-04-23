#!/usr/bin/env node
/**
 * check-tokens.mjs
 *
 * Cross-verifies Figma design tokens vs project CSS.
 *
 * Checks (R6/R15/R46):
 *   1. Every Figma token's `cssVar` is defined in project tokens.css with matching value.
 *   2. No raw hex in component/screen source files (only in tokens.css).
 *   3. Every `var(--x)` referenced in src/ is either:
 *      - A Figma-derived token (cssVar field in tokens.yml)
 *      - Whitelisted project-internal pattern (--tw-*, --crop-*, --pr-* for PrimeReact override, --radix-*)
 *   4. No orphan token definitions (flag only — warning, not failure).
 *
 * Usage:
 *   node scripts/check-tokens.mjs --contract design-contract/pages/<slug> --src <project>/src
 *   node scripts/check-tokens.mjs --contract design-contract --src <project>/src   (multi-page: merges every page's tokens.yml)
 *
 * Exit 0 = pass, 1 = fail. Warnings never fail.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const CONTRACT = flags.contract;
const SRC = flags.src;
const QUIET = !!flags.quiet;
if (!CONTRACT || !SRC) {
  console.error('usage: --contract <design-contract | design-contract/pages/<slug>> --src <project>/src');
  process.exit(1);
}

// Whitelisted internal var prefixes. These can appear in src/ without being in Figma tokens.
const INTERNAL_VAR_PATTERNS = [
  /^--tw-/,           // Tailwind
  /^--pr-/,           // PrimeReact passthrough
  /^--p-/,            // PrimeReact native
  /^--radix-/,        // Radix UI
  /^--crop-/,         // R29 dynamic image crop carriers
  /^--slot-/,         // Component slot carriers
  /^--component-/,    // Component-local internal
];

function isWhitelisted(varName) {
  return INTERNAL_VAR_PATTERNS.some((re) => re.test(varName));
}

// ---------- load tokens.yml (single page or multi-page) ----------
function loadTokens() {
  const map = new Map(); // cssVar → { name, value, pageSlug }
  const byName = new Map(); // original Figma name → cssVar

  const absorbFile = (path, pageSlug) => {
    if (!existsSync(path)) return;
    const body = YAML.load(readFileSync(path, 'utf8'));
    for (const [name, tok] of Object.entries(body?.map || {})) {
      if (!tok?.cssVar) continue;
      // Later pages override earlier — document consistency warnings happen below.
      map.set(tok.cssVar, { name, value: tok.value, type: tok.type, pageSlug });
      byName.set(name, tok.cssVar);
    }
  };

  // If CONTRACT ends in /pages/<slug>, single-page mode.
  if (existsSync(join(CONTRACT, 'tokens.yml'))) {
    absorbFile(join(CONTRACT, 'tokens.yml'), CONTRACT.split('/').pop());
  } else if (existsSync(join(CONTRACT, 'pages'))) {
    for (const slug of readdirSync(join(CONTRACT, 'pages')).sort()) {
      absorbFile(join(CONTRACT, 'pages', slug, 'tokens.yml'), slug);
    }
  } else {
    console.error(`[check-tokens] no tokens.yml under ${CONTRACT} — not a valid contract path`);
    process.exit(1);
  }
  return { map, byName };
}

// ---------- parse project tokens.css ----------
function loadProjectTokens(srcRoot) {
  const out = new Map(); // cssVar → value
  const candidates = [
    join(srcRoot, 'styles/tokens.css'),
    join(srcRoot, 'styles/tokens.scss'),
    join(srcRoot, 'tokens.css'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const body = readFileSync(p, 'utf8');
    for (const m of body.matchAll(/(--[a-z0-9_-]+)\s*:\s*([^;]+?)\s*;/gi)) {
      out.set(m[1].toLowerCase(), m[2].trim());
    }
    return { path: p, tokens: out };
  }
  return { path: null, tokens: out };
}

// ---------- walk src ----------
function* walkSrc(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === 'build') continue;
    const p = join(root, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walkSrc(p);
    else if (/\.(scss|css|tsx?|jsx?)$/.test(entry)) yield p;
  }
}

// ---------- normalize color for compare ----------
function normalizeColor(v) {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  // Strip fallback portion.
  if (s.startsWith('var(')) return null;
  // 4-char shorthand → 6-char. #abc → #aabbcc.
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  // 9-char #rrggbbaa with aa=ff → drop alpha for comparison.
  if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) s = s.slice(0, 7);
  // rgb() / rgba() → hex.
  const m = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
  if (m) {
    const to = (n) => parseInt(n, 10).toString(16).padStart(2, '0');
    s = '#' + to(m[1]) + to(m[2]) + to(m[3]);
  }
  return s;
}

// ---------- run ----------
const failures = [];
const warnings = [];

const { map: figmaTokens, byName: figmaByName } = loadTokens();
const { path: projectCssPath, tokens: projectTokens } = loadProjectTokens(SRC);

if (!projectCssPath) {
  failures.push({ kind: 'missing-tokens-css', msg: `no tokens.css found under ${SRC}` });
}

// Check 1 — every Figma token present + value matches.
for (const [cssVar, ft] of figmaTokens) {
  const normalizedVar = cssVar.toLowerCase();
  if (!projectTokens.has(normalizedVar)) {
    failures.push({ kind: 'missing-var', cssVar, figmaName: ft.name, page: ft.pageSlug, expectedValue: ft.value });
    continue;
  }
  const projectValue = projectTokens.get(normalizedVar);
  if (ft.type === 'color') {
    const a = normalizeColor(projectValue);
    const b = normalizeColor(ft.value);
    if (a && b && a !== b) {
      failures.push({ kind: 'value-mismatch', cssVar, figmaName: ft.name, figmaValue: b, projectValue: a });
    }
  } else {
    // Non-color (spacing, radius, number). Figma stores bare numbers; CSS needs unit.
    // Compare as numeric values, ignoring `px` / whitespace.
    const projectNum = parseFloat(projectValue);
    const figmaNum = parseFloat(ft.value);
    if (!Number.isNaN(projectNum) && !Number.isNaN(figmaNum)) {
      if (Math.abs(projectNum - figmaNum) > 0.001) {
        failures.push({ kind: 'value-mismatch', cssVar, figmaName: ft.name, figmaValue: ft.value, projectValue });
      }
    } else if (projectValue.trim() !== String(ft.value).trim()) {
      warnings.push({ kind: 'value-mismatch-nonColor', cssVar, figmaName: ft.name, figmaValue: ft.value, projectValue });
    }
  }
}

// Check 2/3/4 — walk source.
const figmaVarSet = new Set([...figmaTokens.keys()].map((v) => v.toLowerCase()));
const referencedVars = new Set();
const hexPattern = /#[0-9a-fA-F]{6,8}\b/g;
const varPattern = /var\((--[a-zA-Z0-9_-]+)(?:,[^)]+)?\)/g;

for (const file of walkSrc(SRC)) {
  // Skip tokens.css — that's the source of truth layer.
  if (file === projectCssPath) continue;
  const rel = file.replace(SRC + '/', '');
  const body = readFileSync(file, 'utf8');

  // Raw hex in source (R15 / R6). Allow inside comments + inside var() fallback (warning only).
  for (const m of body.matchAll(hexPattern)) {
    const idx = m.index;
    const lineStart = body.lastIndexOf('\n', idx) + 1;
    const lineEndIdx = body.indexOf('\n', idx);
    const line = body.slice(lineStart, lineEndIdx === -1 ? body.length : lineEndIdx);
    const trimmed = line.trim();
    // Skip comment-only lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // Detect if hex sits inside a var(--x, <hex>) fallback. Search left for `var(` without a closing `)` before the hex.
    const upTo = body.slice(Math.max(0, idx - 200), idx);
    const lastVarOpen = upTo.lastIndexOf('var(');
    const afterVarOpen = lastVarOpen >= 0 ? upTo.slice(lastVarOpen) : '';
    const inVarFallback = lastVarOpen >= 0 && !afterVarOpen.includes(')');
    if (inVarFallback) {
      warnings.push({ kind: 'hex-in-var-fallback', file: rel, line: trimmed.slice(0, 120), hex: m[0] });
      continue;
    }
    failures.push({ kind: 'raw-hex', file: rel, line: trimmed.slice(0, 120), hex: m[0] });
  }

  // var(--x) references
  for (const m of body.matchAll(varPattern)) {
    const name = m[1].toLowerCase();
    referencedVars.add(name);
    if (figmaVarSet.has(name)) continue;
    if (isWhitelisted(name)) continue;
    // Also allow if defined in tokens.css (project-local ok)
    if (projectTokens.has(name)) continue;
    failures.push({ kind: 'unknown-var', file: rel, var: name });
  }
}

// Warning: orphan token definitions (defined in project tokens.css but never referenced + not in Figma).
for (const v of projectTokens.keys()) {
  if (!figmaVarSet.has(v) && !referencedVars.has(v) && !isWhitelisted(v)) {
    warnings.push({ kind: 'orphan-token', cssVar: v });
  }
}

// ---------- report ----------
const failuresByKind = failures.reduce((a, f) => { (a[f.kind] ||= []).push(f); return a; }, {});
const warningsByKind = warnings.reduce((a, w) => { (a[w.kind] ||= []).push(w); return a; }, {});

if (!QUIET) {
  console.log(`[check-tokens] contract=${CONTRACT}`);
  console.log(`[check-tokens] src=${SRC}`);
  console.log(`[check-tokens] figma tokens: ${figmaTokens.size}  project tokens.css: ${projectTokens.size} (${projectCssPath || 'MISSING'})`);
}

let rc = 0;
for (const kind of Object.keys(failuresByKind).sort()) {
  const list = failuresByKind[kind];
  console.log(`\n[FAIL] ${kind} (${list.length}):`);
  for (const f of list.slice(0, 20)) {
    console.log('  ' + JSON.stringify(f));
  }
  if (list.length > 20) console.log(`  ... +${list.length - 20} more`);
  rc = 1;
}
for (const kind of Object.keys(warningsByKind).sort()) {
  const list = warningsByKind[kind];
  console.log(`\n[WARN] ${kind} (${list.length}):`);
  for (const w of list.slice(0, 10)) {
    console.log('  ' + JSON.stringify(w));
  }
  if (list.length > 10) console.log(`  ... +${list.length - 10} more`);
}

if (rc === 0) console.log('\n[check-tokens] PASS');
else console.log('\n[check-tokens] FAIL');

process.exit(rc);
