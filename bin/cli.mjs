#!/usr/bin/env node
// Smoke CLI for the REST + transformer pipeline.
//
// Usage:
//   FIGMA_PAT=... node bin/cli.mjs me
//   FIGMA_PAT=... node bin/cli.mjs node <figma-url> [--lib <fileKey>[,<fileKey>...]] [--discover-lib]
//   FIGMA_PAT=... node bin/cli.mjs raw <figma-url>
//   FIGMA_PAT=... node bin/cli.mjs image <figma-url> [--format=png|svg] [--scale=2] [--out=file]
//   FIGMA_PAT=... node bin/cli.mjs tokens <figma-url> [--lib <fileKey>[,...]] [--discover-lib]
//   FIGMA_PAT=... node bin/cli.mjs components <figma-url>
//   FIGMA_PAT=... node bin/cli.mjs styles <figma-url>
//   FIGMA_PAT=... node bin/cli.mjs discover-libs <figma-url>    → unique library fileKeys used by remote components
//
// Flags:
//   --cache <dir>        enable on-disk cache
//   --lib <key[,key]>    include these library files' variables in the token map (cross-file alias resolution)
//   --discover-lib       auto-discover library fileKeys via remote component hop (may miss var-only libraries)
//   --depth <n>          node tree depth limit

import { writeFile } from 'node:fs/promises';
import { parseFigmaUrl } from '../lib/url.mjs';
import { createClient, FigmaError } from '../lib/figma.mjs';
import { transformNode } from '../lib/transform.mjs';
import { buildTokenMap, collectUnresolvedKeys } from '../lib/tokens.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith('--'));
const flags = parseFlags(args);

const client = createClient({ cacheDir: flags.cache || null });

try {
  switch (cmd) {
    case 'me':
      print(await client.me());
      break;

    case 'raw': {
      const { fileKey, nodeId } = requireUrl(positional[0]);
      const { nodes } = await client.getFileNodes(fileKey, nodeId, { depth: numFlag('depth') });
      print(nodes);
      break;
    }

    case 'node': {
      const { fileKey, nodeId } = requireUrl(positional[0]);
      const [tokenMap, nodesRes] = await Promise.all([
        buildTokenMapWithLibraries(fileKey),
        client.getFileNodes(fileKey, nodeId, { depth: numFlag('depth') }),
      ]);
      const entry = nodesRes.nodes[nodeId];
      if (!entry) throw new Error(`node ${nodeId} not in response`);
      print(transformNode(entry.document, {
        tokenMap,
        components: entry.components,
        componentSets: entry.componentSets,
        styles: entry.styles,
      }));
      break;
    }

    case 'image': {
      const { fileKey, nodeId } = requireUrl(positional[0]);
      const format = flags.format || 'png';
      const scale = Number(flags.scale || 2);
      const { images } = await client.getImages(fileKey, nodeId, { format, scale });
      const url = images[nodeId];
      if (!url) throw new Error(`no image url returned for ${nodeId}`);
      if (flags.out) {
        const buf = await client.downloadUrl(url);
        await writeFile(flags.out, buf);
        console.error(`wrote ${flags.out} (${buf.length} bytes)`);
      } else {
        print({ url });
      }
      break;
    }

    case 'tokens': {
      const { fileKey } = requireUrl(positional[0]);
      const tokenMap = await buildTokenMapWithLibraries(fileKey);
      const unresolved = collectUnresolvedKeys(tokenMap);
      if (unresolved.length) console.error(`[tokens] ${unresolved.length} library var key(s) still unresolved: ${unresolved.join(', ')}`);
      print(tokenMap);
      break;
    }

    case 'components': {
      const { fileKey } = requireUrl(positional[0]);
      print(await client.getFileComponents(fileKey));
      break;
    }

    case 'styles': {
      const { fileKey } = requireUrl(positional[0]);
      print(await client.getFileStyles(fileKey));
      break;
    }

    case 'discover-libs': {
      const { fileKey } = requireUrl(positional[0]);
      const libs = await discoverLibraryFileKeys(fileKey);
      print(libs);
      break;
    }

    default:
      console.error('commands: me | raw <url> | node <url> | image <url> [--format=] [--scale=] [--out=] | tokens <url> | components <url> | styles <url> | discover-libs <url>');
      process.exit(1);
  }
} catch (err) {
  if (err instanceof FigmaError) {
    console.error(`[figma ${err.status ?? ''}] ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(1);
}

function requireUrl(url) {
  if (!url) throw new Error('figma URL required');
  const parsed = parseFigmaUrl(url);
  const nodeCmds = new Set(['raw', 'node', 'image']);
  if (!parsed.nodeId && nodeCmds.has(cmd)) {
    throw new Error(`URL missing node-id: ${url}`);
  }
  return parsed;
}

async function buildTokenMapWithLibraries(fileKey) {
  const main = await safeVariables(client, fileKey);
  if (!main) return {};
  const responses = [main];

  let libKeys = [];
  if (flags.lib) libKeys = String(flags.lib).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags['discover-lib']) {
    const discovered = await discoverLibraryFileKeys(fileKey);
    libKeys = Array.from(new Set([...libKeys, ...discovered]));
    console.error(`[tokens] discovered libs: ${discovered.join(', ') || 'none'}`);
  }

  for (const lib of libKeys) {
    if (lib === fileKey) continue;
    const libResp = await safeVariables(client, lib);
    if (libResp) responses.push(libResp);
    else console.error(`[tokens] skipped lib ${lib} (no variables access)`);
  }

  return buildTokenMap(responses);
}

// Library discovery. `/v1/files/:key/components` only lists components published BY this file,
// not the ones it consumes. To find consumed library files, walk the full file tree to collect
// remote component keys, then hop each via `/v1/components/:key` → returns owning `file_key`.
async function discoverLibraryFileKeys(fileKey) {
  const file = await client.getFile(fileKey, { depth: numFlag('discover-depth') ?? 3 });
  const componentsMap = file?.components ?? {};
  const remoteKeys = [...new Set(Object.values(componentsMap).filter((c) => c.remote && c.key).map((c) => c.key))];

  if (!remoteKeys.length) return [];

  // Hop a sample — one library usually covers many component keys.
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

async function safeVariables(client, fileKey) {
  try {
    return await client.getLocalVariables(fileKey);
  } catch (err) {
    if (err instanceof FigmaError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

function numFlag(name) {
  const v = flags[name];
  return v == null ? undefined : Number(v);
}

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
      if (next && !next.startsWith('--')) {
        out[body] = next;
        i++;
      } else {
        out[body] = true;
      }
    }
  }
  return out;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
