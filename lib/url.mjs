// Parse Figma URLs → { fileKey, nodeId, kind, branchKey }
// Supported shapes:
//   figma.com/design/:key/:name?node-id=X-Y        → kind=design
//   figma.com/design/:key/branch/:branchKey/:name  → branchKey overrides fileKey
//   figma.com/file/:key/...                        → legacy alias of design
//   figma.com/board/:key/:name                     → kind=figjam
//   figma.com/make/:key/:name                      → kind=make

const FIGMA_HOST = /(?:^|\.)figma\.com$/;

export function parseFigmaUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (!FIGMA_HOST.test(u.hostname)) {
    throw new Error(`not a figma.com URL: ${raw}`);
  }

  const parts = u.pathname.split('/').filter(Boolean);
  const [kindRaw, key, ...rest] = parts;

  const kindMap = { design: 'design', file: 'design', board: 'figjam', make: 'make' };
  const kind = kindMap[kindRaw];
  if (!kind || !key) throw new Error(`unrecognized figma path: ${u.pathname}`);

  let fileKey = key;
  let branchKey = null;
  if (rest[0] === 'branch' && rest[1]) {
    branchKey = rest[1];
    fileKey = branchKey;
  }

  const nodeIdParam = u.searchParams.get('node-id');
  const nodeId = nodeIdParam ? nodeIdParam.replace(/-/g, ':') : null;

  return { fileKey, nodeId, kind, branchKey };
}
