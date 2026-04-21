#!/usr/bin/env node
/**
 * verify-glyphs.mjs
 * Build side-by-side grid: Figma reference icon vs codebase-rendered icon.
 * For webfont: render <i class="prefix-<name>"> in Playwright and snapshot.
 * For svg: render <img src="/assets/icons/<name>.svg"> and snapshot.
 * Compare pixel-by-pixel against Figma export. Fail on mismatch > threshold.
 *
 * Usage:
 *   verify-glyphs.mjs --contract design-contract --url http://localhost:5173 --out .validate-cache/glyphs.html
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import YAML from 'js-yaml';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const contractDir = args.contract || 'design-contract';
const url = args.url || 'http://localhost:5173';
const out = args.out || '.validate-cache/glyphs.html';
const figmaShotsDir = args['figma-shots'] || join('.validate-cache', 'shots', 'icons');

const icons = YAML.load(readFileSync(join(contractDir, 'icons.yml'), 'utf8'));
const prefix = icons.webfont?.prefix || '';

if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });

const { chromium } = await import('playwright');
const { PNG } = await import('pngjs');
const pixelmatch = (await import('pixelmatch')).default;

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url);

const results = [];

for (const icon of icons.icons) {
  const figmaPath = join(figmaShotsDir, `${icon.name}.png`);
  if (!existsSync(figmaPath)) {
    results.push({ name: icon.name, status: 'no-reference' });
    continue;
  }

  const renderHtml = icons.strategy === 'webfont'
    ? `<i class="${prefix}-${icon.name}" style="font-size:${(icon.defaultVisibleSizePx || 16) * 2}px;line-height:1;color:#111;display:block;"></i>`
    : `<img src="/assets/icons/${icon.name}.svg" style="width:${icon.defaultVisibleSizePx || 16}px;height:${icon.defaultVisibleSizePx || 16}px;display:block;"/>`;

  await page.setContent(`<html><head><link rel="stylesheet" href="${url}/src/styles/icons.css"></head><body style="margin:0;padding:8px;background:#fff;">${renderHtml}</body></html>`);
  await page.waitForLoadState('networkidle');
  const el = await page.locator('i, img').first();
  const shot = await el.screenshot();

  const figma = PNG.sync.read(readFileSync(figmaPath));
  const rendered = PNG.sync.read(shot);
  if (figma.width !== rendered.width || figma.height !== rendered.height) {
    results.push({ name: icon.name, status: 'size-mismatch', rendered: `${rendered.width}x${rendered.height}`, figma: `${figma.width}x${figma.height}` });
    continue;
  }
  const diff = new PNG({ width: figma.width, height: figma.height });
  const n = pixelmatch(figma.data, rendered.data, diff.data, figma.width, figma.height, { threshold: 0.05 });
  const pct = n / (figma.width * figma.height);
  results.push({ name: icon.name, status: pct > 0.05 ? 'fail' : 'pass', mismatch: (pct * 100).toFixed(2) + '%' });
}

await browser.close();

const html = `<!doctype html><html><body style="font-family:sans-serif">
<h1>Glyph verification</h1>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>Icon</th><th>Status</th><th>Mismatch</th></tr>
${results.map((r) => `<tr style="color:${r.status === 'pass' ? 'green' : r.status === 'no-reference' ? 'gray' : 'red'}"><td>${r.name}</td><td>${r.status}</td><td>${r.mismatch || r.rendered || ''}</td></tr>`).join('')}
</table>
</body></html>`;
writeFileSync(out, html);

const fails = results.filter((r) => r.status !== 'pass' && r.status !== 'no-reference').length;
console.log(`[verify-glyphs] ${results.length} icons checked. fail:${fails} noref:${results.filter((r) => r.status === 'no-reference').length}. report: ${out}`);
process.exit(fails > 0 ? 1 : 0);
