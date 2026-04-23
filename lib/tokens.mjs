// Token map builder + boundVariables resolver.
// Requires Enterprise: GET /v1/files/:key/variables/local returns:
//   { meta: { variables: {id: var}, variableCollections: {id: coll} } }
//
// Variable shape:
//   id ("VariableID:<localId>"), key (content hash), name, variableCollectionId,
//   resolvedType ("COLOR" | "FLOAT" | "STRING" | "BOOLEAN"), remote, valuesByMode { [modeId]: RGBA | number | string | { type: "VARIABLE_ALIAS", id } }
//
// Collection shape:
//   id, name, key, modes: [{ modeId, name }], defaultModeId
//
// Cross-file aliases: a variable imported from a library uses the subscribed form
//   `VariableID:<variableKey>/<localId>`. To resolve, the caller passes responses from
//   multiple files (this file + its subscribed libraries). buildTokenMap unifies them —
//   each variable is indexed under BOTH local id AND subscribed id so lookup works from
//   either side.

export function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function cssVarName(collectionName, variableName) {
  const flat = `${collectionName}/${variableName}`
    .split('/')
    .map((s) => slugify(s))
    .filter(Boolean)
    .join('-');
  return `--${flat}`;
}

function rgbaToHex({ r, g, b, a = 1 }) {
  const to255 = (n) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const hh = (n) => to255(n).toString(16).padStart(2, '0');
  const hex = `#${hh(r)}${hh(g)}${hh(b)}`;
  return a < 1 ? `${hex}${hh(a)}` : hex;
}

// Compute the subscribed form of a variable/collection id.
// Local id is "VariableID:1315:68"; subscribed is "VariableID:<varKey>/1315:68".
function subscribedVarId(v) {
  if (!v.key || !v.id) return null;
  const local = v.id.replace(/^VariableID:/, '');
  return `VariableID:${v.key}/${local}`;
}

function subscribedCollId(c) {
  if (!c.key || !c.id) return null;
  const local = c.id.replace(/^VariableCollectionId:/, '');
  return `VariableCollectionId:${c.key}/${local}`;
}

// Resolve a single value, chasing aliases through the unified variables map.
// Returns { value, aliasTo, reason }.
function resolveValue(value, variables, collections, modeId, visited = new Set()) {
  if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
    if (visited.has(value.id)) return { value: null, aliasTo: value.id, reason: 'cycle' };
    visited.add(value.id);
    const aliased = variables[value.id];
    if (!aliased) return { value: null, aliasTo: value.id, reason: 'cross-file' };
    let aliasVal = aliased.valuesByMode?.[modeId];
    if (aliasVal === undefined) {
      const coll = collections[aliased.variableCollectionId];
      const defId = coll?.defaultModeId;
      aliasVal = aliased.valuesByMode?.[defId] ?? Object.values(aliased.valuesByMode ?? {})[0];
    }
    return resolveValue(aliasVal, variables, collections, modeId, visited);
  }
  return { value, aliasTo: null, reason: null };
}

function toPrimitive(raw, type) {
  if (raw == null) return null;
  if (type === 'COLOR' && typeof raw === 'object') return rgbaToHex(raw);
  return raw;
}

// Accepts a single response OR an array of responses (this-file + subscribed libraries).
// Returns a tokenMap indexed under BOTH each variable's local id AND its subscribed id,
// so downstream `resolveBoundVariables` can look up either form.
export function buildTokenMap(responses) {
  const list = Array.isArray(responses) ? responses : [responses];

  // Stage 1: collect unique variables + collections. Canonicalize to the local id
  // (first occurrence wins) so each variable produces one token entry.
  const uniqueVars = new Map(); // canonicalId → variable
  const uniqueColls = new Map();
  const varAliases = {}; // anyId → canonicalId
  const collAliases = {};

  for (const r of list) {
    for (const v of Object.values(r?.meta?.variables ?? {})) {
      const canon = v.id;
      if (!uniqueVars.has(canon)) uniqueVars.set(canon, v);
      varAliases[canon] = canon;
      const sub = subscribedVarId(v);
      if (sub) varAliases[sub] = canon;
    }
    for (const c of Object.values(r?.meta?.variableCollections ?? {})) {
      const canon = c.id;
      if (!uniqueColls.has(canon)) uniqueColls.set(canon, c);
      collAliases[canon] = canon;
      const sub = subscribedCollId(c);
      if (sub) collAliases[sub] = canon;
    }
  }

  // Stage 2: lookup maps accessible by any-form id.
  const variablesAny = {};
  for (const [alias, canon] of Object.entries(varAliases)) variablesAny[alias] = uniqueVars.get(canon);
  const collectionsAny = {};
  for (const [alias, canon] of Object.entries(collAliases)) collectionsAny[alias] = uniqueColls.get(canon);

  // Stage 3: build a token entry per unique variable.
  const byCanon = {};
  for (const [canon, v] of uniqueVars) {
    const coll = collectionsAny[v.variableCollectionId];
    const collName = coll?.name ?? 'vars';
    const cssVar = cssVarName(collName, v.name);

    const modes = {};
    let aliasTo = null;
    if (coll) {
      for (const { modeId, name: modeName } of coll.modes ?? []) {
        const resolved = resolveValue(v.valuesByMode?.[modeId], variablesAny, collectionsAny, modeId);
        modes[modeName] = toPrimitive(resolved.value, v.resolvedType);
        if (resolved.aliasTo && !aliasTo) aliasTo = resolved.aliasTo;
      }
    }
    const defaultModeId = coll?.defaultModeId;
    const defaultResolved = resolveValue(v.valuesByMode?.[defaultModeId], variablesAny, collectionsAny, defaultModeId);
    if (defaultResolved.aliasTo && !aliasTo) aliasTo = defaultResolved.aliasTo;

    byCanon[canon] = {
      id: canon,
      key: v.key,
      subscribedId: subscribedVarId(v),
      name: v.name,
      collection: collName,
      type: v.resolvedType,
      remote: v.remote ?? false,
      cssVar,
      value: toPrimitive(defaultResolved.value, v.resolvedType),
      modes,
      aliasTo,
    };
  }

  // Stage 4: expose under every alias form so callers can look up via subscribed id.
  const out = {};
  for (const [alias, canon] of Object.entries(varAliases)) {
    if (byCanon[canon]) out[alias] = byCanon[canon];
  }
  return out;
}

// R48: reverse-lookup token by hex value. Fallback when an alias key points to a
// library file whose variables weren't fetched (e.g. deeply chained library chain).
// Matches against the token map — returns the token name of the first color token
// whose value equals the input hex.
function hexTokenIndex(tokenMap) {
  const out = new Map();
  for (const tok of Object.values(tokenMap || {})) {
    if (tok?.type !== 'COLOR' || !tok.value || typeof tok.value !== 'string') continue;
    const norm = normalizeHex(tok.value);
    if (!norm) continue;
    if (!out.has(norm)) out.set(norm, tok);
  }
  return out;
}

function normalizeHex(v) {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) s = s.slice(0, 7);
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function resolveBoundVariableByHex(tokenMap, hex) {
  if (!hex || !tokenMap) return null;
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const idx = hexTokenIndex(tokenMap);
  const tok = idx.get(norm);
  return tok ? { tokenId: tok.id, cssVar: tok.cssVar, name: tok.name, value: tok.value, via: 'hex-fallback' } : null;
}

// Given a node.boundVariables object, produce a map keyed by field.
export function resolveBoundVariables(boundVariables, tokenMap) {
  if (!boundVariables) return {};
  const out = {};
  for (const [field, val] of Object.entries(boundVariables)) {
    if (Array.isArray(val)) {
      out[field] = val.map((entry) => resolveAlias(entry, tokenMap));
    } else if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      out[field] = resolveAlias(val, tokenMap);
    } else if (val && typeof val === 'object') {
      out[field] = {};
      for (const [sub, subVal] of Object.entries(val)) {
        out[field][sub] = resolveAlias(subVal, tokenMap);
      }
    }
  }
  return out;
}

function resolveAlias(alias, tokenMap) {
  if (!alias || alias.type !== 'VARIABLE_ALIAS') return null;
  const token = tokenMap[alias.id];
  if (!token) return { tokenId: alias.id, cssVar: null, name: null, value: null, unresolved: 'cross-file' };
  return {
    tokenId: alias.id,
    cssVar: token.cssVar,
    name: token.name,
    value: token.value,
    aliasTo: token.aliasTo ?? null,
    unresolved: token.value == null && token.aliasTo ? 'cross-file' : null,
  };
}

// Helpers exported for diagnostics / CLI.
export function parseAliasId(aliasId) {
  if (!aliasId) return null;
  const body = aliasId.replace(/^VariableID:/, '');
  const slash = body.indexOf('/');
  if (slash < 0) return { key: null, localId: body };
  return { key: body.slice(0, slash), localId: body.slice(slash + 1) };
}

// Collect the set of unique library variable keys referenced by unresolved aliases.
// Useful for diagnosing which library files still need to be fetched.
export function collectUnresolvedKeys(tokenMap) {
  const keys = new Set();
  for (const t of Object.values(tokenMap)) {
    if (t.aliasTo) {
      const parts = parseAliasId(t.aliasTo);
      if (parts?.key) keys.add(parts.key);
    }
  }
  return [...keys];
}
