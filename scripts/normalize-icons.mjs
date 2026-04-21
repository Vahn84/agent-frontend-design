#!/usr/bin/env node
/**
 * normalize-icons.mjs
 * Post-process exported SVG icons so they inherit the CSS color context.
 *
 * Actions per SVG:
 *   - Remove fill="none" on root <svg>
 *   - Replace any fill="#..." with fill="currentColor" on path/rect/circle/etc
 *   - Remove inline style="fill:..." that hardcodes color
 *   - Preserve fill="none" on elements that should NOT be filled (only remove fill on root)
 *   - Preserve viewBox
 *
 * Usage:
 *   normalize-icons.mjs --dir src/assets/icons/svg
 *   normalize-icons.mjs --dir src/assets/icons/svg --check  (fails if any icon still has hardcoded fills)
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const dir = args.dir;
const check = !!args.check;
if (!dir) { console.error('--dir required'); process.exit(1); }

const svgs = readdirSync(dir).filter((f) => f.endsWith('.svg'));
let changed = 0;
let violations = [];

for (const file of svgs) {
  const p = join(dir, file);
  const src = readFileSync(p, 'utf8');
  let out = src;

  out = out.replace(/(<svg[^>]*?)\sfill="none"/i, '$1');

  out = out.replace(/fill="(#[0-9A-Fa-f]{3,8})"/g, 'fill="currentColor"');
  out = out.replace(/stroke="(#[0-9A-Fa-f]{3,8})"/g, 'stroke="currentColor"');
  out = out.replace(/style="([^"]*?)(?:fill|stroke):\s*#[0-9A-Fa-f]{3,8}\s*;?\s*([^"]*)"/g, (_, pre, post) => {
    const cleaned = (pre + post).replace(/\s*;\s*;/g, ';').trim();
    return cleaned ? `style="${cleaned}"` : '';
  });

  if (check) {
    if (/(?:fill|stroke)="#[0-9A-Fa-f]{3,8}"/.test(src) || /(?:fill|stroke):\s*#[0-9A-Fa-f]{3,8}/.test(src)) {
      violations.push(file);
    }
  } else if (out !== src) {
    writeFileSync(p, out);
    changed++;
  }
}

if (check) {
  if (violations.length) {
    console.error(`[normalize-icons] ${violations.length} icons have hardcoded fills:`);
    violations.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`[normalize-icons] ${svgs.length} icons clean`);
} else {
  console.log(`[normalize-icons] normalized ${changed}/${svgs.length} svgs`);
}
