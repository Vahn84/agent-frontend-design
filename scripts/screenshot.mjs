#!/usr/bin/env node
/**
 * screenshot.mjs
 * Cache Figma reference screenshots for L5 pixel diff.
 *
 * Usage:
 *   screenshot.mjs --file-key <key> --node <id> --out .validate-cache/shots/figma-<name>.png --pat <FIGMA_PAT> --scale 2
 *
 * Calls Figma REST /v1/images to get a PNG URL, downloads it.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const { 'file-key': fileKey, node, out, pat, scale = '2' } = args;
if (!fileKey || !node || !out || !pat) {
  console.error('usage: --file-key <key> --node <id> --out <path> --pat <FIGMA_PAT> [--scale 2]');
  process.exit(1);
}

const url = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(node)}&format=png&scale=${scale}`;
const res = await fetch(url, { headers: { 'X-Figma-Token': pat } });
if (!res.ok) { console.error(`figma api ${res.status}`); process.exit(1); }
const data = await res.json();
if (data.err) { console.error(`figma err: ${data.err}`); process.exit(1); }
const imgUrl = data.images[node];
if (!imgUrl) { console.error(`no image url for node ${node}`); process.exit(1); }

const imgRes = await fetch(imgUrl);
if (!imgRes.ok) { console.error(`image download ${imgRes.status}`); process.exit(1); }
const buf = Buffer.from(await imgRes.arrayBuffer());

if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
