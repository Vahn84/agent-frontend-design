// Figma REST client. Node 18+ native fetch.
// Auth: X-Figma-Token header. Set FIGMA_PAT env or pass { pat } to createClient.
// Handles 429 Retry-After + 5xx exponential backoff. Optional on-disk cache.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const BASE = 'https://api.figma.com';
const DEFAULT_RETRIES = 4;
const DEFAULT_BACKOFF_MS = 500;

export class FigmaError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = 'FigmaError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export function createClient({ pat = process.env.FIGMA_PAT, cacheDir = null, fetchImpl = globalThis.fetch, retries = DEFAULT_RETRIES } = {}) {
  if (!pat) throw new FigmaError('FIGMA_PAT missing');

  const headers = { 'X-Figma-Token': pat };

  async function cacheRead(key) {
    if (!cacheDir) return null;
    const path = join(cacheDir, `${key}.json`);
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  async function cacheWrite(key, value) {
    if (!cacheDir) return;
    const path = join(cacheDir, `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }

  function cacheKey(endpoint, params) {
    const h = createHash('sha256').update(endpoint).update(JSON.stringify(params || {})).digest('hex').slice(0, 24);
    return `${endpoint.replace(/[^a-z0-9]+/gi, '_')}_${h}`;
  }

  async function request(endpoint, { method = 'GET', params, cache = false, parseJson = true } = {}) {
    const url = new URL(BASE + endpoint);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
    }

    const key = cache ? cacheKey(endpoint, params) : null;
    if (key) {
      const hit = await cacheRead(key);
      if (hit) return hit;
    }

    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      try {
        const res = await fetchImpl(url.toString(), { method, headers });
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after') || 1);
          await sleep(ra * 1000);
          attempt++;
          continue;
        }
        if (res.status >= 500 && res.status < 600) {
          await sleep(DEFAULT_BACKOFF_MS * 2 ** attempt);
          attempt++;
          continue;
        }
        if (!res.ok) {
          const body = await safeJson(res);
          throw new FigmaError(`${method} ${endpoint} → ${res.status}`, { status: res.status, body, endpoint });
        }
        const out = parseJson ? await res.json() : await res.arrayBuffer();
        if (key) await cacheWrite(key, out);
        return out;
      } catch (err) {
        lastErr = err;
        if (err instanceof FigmaError) throw err;
        await sleep(DEFAULT_BACKOFF_MS * 2 ** attempt);
        attempt++;
      }
    }
    throw lastErr ?? new FigmaError(`${method} ${endpoint} failed after ${retries} retries`, { endpoint });
  }

  return {
    me: () => request('/v1/me'),

    // Full file. Heavy — prefer getFileNodes.
    getFile: (fileKey, { depth, geometry, branchData, pluginData, version } = {}) =>
      request(`/v1/files/${fileKey}`, { params: { depth, geometry, branch_data: branchData, plugin_data: pluginData, version }, cache: true }),

    // Subtree under specific node IDs. Use this for screens — smaller payload.
    getFileNodes: (fileKey, ids, { depth, geometry, version } = {}) =>
      request(`/v1/files/${fileKey}/nodes`, { params: { ids, depth, geometry, version }, cache: true }),

    // Render nodes → images. format: png | jpg | svg | pdf. scale 1–4 (png/jpg).
    getImages: (fileKey, ids, { format = 'png', scale = 2, svgIncludeId = false, svgSimplifyStroke = true, useAbsoluteBounds = false, version } = {}) =>
      request(`/v1/images/${fileKey}`, {
        params: {
          ids,
          format,
          scale,
          svg_include_id: svgIncludeId,
          svg_simplify_stroke: svgSimplifyStroke,
          use_absolute_bounds: useAbsoluteBounds,
          version,
        },
      }),

    // Resolve image refs → CDN URLs (for image fills).
    getImageFills: (fileKey) => request(`/v1/files/${fileKey}/images`),

    getFileComponents: (fileKey) => request(`/v1/files/${fileKey}/components`, { cache: true }),
    getFileComponentSets: (fileKey) => request(`/v1/files/${fileKey}/component_sets`, { cache: true }),
    getFileStyles: (fileKey) => request(`/v1/files/${fileKey}/styles`, { cache: true }),

    // Resolve library from any component key (single library touch — R33).
    getComponent: (componentKey) => request(`/v1/components/${componentKey}`, { cache: true }),
    getComponentSet: (componentSetKey) => request(`/v1/component_sets/${componentSetKey}`, { cache: true }),
    getStyle: (styleKey) => request(`/v1/styles/${styleKey}`, { cache: true }),

    // Enterprise only. Full variable + collection map for token resolution.
    getLocalVariables: (fileKey) => request(`/v1/files/${fileKey}/variables/local`, { cache: true }),
    getPublishedVariables: (fileKey) => request(`/v1/files/${fileKey}/variables/published`, { cache: true }),

    // Raw binary fetch for rendered image URLs or exported SVGs.
    downloadUrl: async (url) => {
      const res = await fetchImpl(url);
      if (!res.ok) throw new FigmaError(`download ${url} → ${res.status}`, { status: res.status });
      return Buffer.from(await res.arrayBuffer());
    },

    request,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
