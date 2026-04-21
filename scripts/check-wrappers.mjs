#!/usr/bin/env node
/**
 * check-wrappers.mjs
 * R14 enforcement: pages must USE library wrappers, not raw HTML equivalents.
 *
 * Reads design-contract/meta.yml library.components[].wrappedPrimitive.
 * For each declared primitive, greps built page/component files for raw tags.
 * FAIL on any match.
 *
 * Usage:
 *   check-wrappers.mjs --contract design-contract --src path/to/app/src
 *
 * Excludes the wrapper file itself (identified by importPath basename).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import YAML from 'js-yaml';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const contractDir = args.contract || 'design-contract';
const srcDir = args.src;
if (!srcDir) { console.error('--src required'); process.exit(1); }

const meta = YAML.load(readFileSync(join(contractDir, 'meta.yml'), 'utf8'));
const wrappers = (meta.library?.components || []).filter((c) => c.wrappedPrimitive);
if (!wrappers.length) {
  console.log('[check-wrappers] no wrappers declared — skip');
  process.exit(0);
}

const PRIMITIVE_TAGS = {
  table: [/<table[\s>]/i],
  checkbox: [/<input\s+[^>]*type=["']checkbox["']/i],
  radio: [/<input\s+[^>]*type=["']radio["']/i],
  switch: [/<input\s+[^>]*type=["']checkbox["'][^>]*role=["']switch["']/i, /<input\s+[^>]*type=["']range["'][^>]*data-switch/i],
  input: [/<input\s+[^>]*type=["'](text|email|password|number|tel|url|search)["']/i],
  textarea: [/<textarea[\s>]/i],
  select: [/<select[\s>]/i],
  slider: [/<input\s+[^>]*type=["']range["']/i],
  datepicker: [/<input\s+[^>]*type=["']date["']/i],
};

const excludeFiles = new Set(wrappers.map((w) => w.importPath && basename(w.importPath).replace(/\.(tsx|ts|jsx|js)$/, '')).filter(Boolean));

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(tsx|jsx|ts|html)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = walk(srcDir);
const violations = [];

for (const file of files) {
  const stem = basename(file).replace(/\.(tsx|ts|jsx|js|html)$/, '');
  if (excludeFiles.has(stem)) continue;
  const body = readFileSync(file, 'utf8');
  for (const w of wrappers) {
    const patterns = PRIMITIVE_TAGS[w.wrappedPrimitive] || [];
    for (const re of patterns) {
      if (re.test(body)) {
        violations.push({ file: relative(process.cwd(), file), primitive: w.wrappedPrimitive, wrapper: w.libraryComponent });
      }
    }
  }
}

if (violations.length) {
  console.error(`[check-wrappers] R14 violations: ${violations.length}`);
  violations.forEach((v) => console.error(`  ${v.file}: raw <${v.primitive}> — must use ${v.wrapper}`));
  process.exit(1);
}
console.log(`[check-wrappers] ✓ ${files.length} files clean`);
