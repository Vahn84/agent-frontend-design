// Node transformer. Raw Figma REST node → enriched spec.
// Replaces MCP `get_design_context`: deterministic, no LLM.
//
// Input: a Figma node object (from GET /v1/files/:key/nodes).
// Output: enriched tree matching ai-frontend-agent AUDIT.md shape —
//   id, name, kind, layoutSizing, dimensions, spacing, direction, alignItems,
//   justifyContent, fills, strokes, radius, effects, text, icon, imageFrame, children,
//   tokenRefs (from boundVariables), componentRef (for instances).

import { resolveBoundVariables, resolveBoundVariableByHex } from './tokens.mjs';

const FIGMA_TO_KIND = {
  FRAME: 'frame',
  GROUP: 'group',
  INSTANCE: 'instance',
  COMPONENT: 'component',
  COMPONENT_SET: 'componentSet',
  TEXT: 'text',
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  VECTOR: 'vector',
  STAR: 'vector',
  POLYGON: 'vector',
  BOOLEAN_OPERATION: 'vector',
  SECTION: 'section',
};

export function transformNode(node, ctx = {}) {
  if (!node) return null;
  // R-visibility: skip invisible nodes outright. Cascades — children not walked, nothing emitted.
  // Caller filters nulls out of children arrays.
  if (node.visible === false) return null;

  const tokenMap = ctx.tokenMap || {};
  const parentMode = ctx.parentMode ?? null;

  const kind = FIGMA_TO_KIND[node.type] ?? 'unknown';
  const dimensions = node.absoluteBoundingBox
    ? { width: round(node.absoluteBoundingBox.width), height: round(node.absoluteBoundingBox.height), x: round(node.absoluteBoundingBox.x), y: round(node.absoluteBoundingBox.y) }
    : null;

  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    kind,
  };

  if (dimensions) out.dimensions = dimensions;

  // Auto-layout / layout sizing.
  const layoutMode = node.layoutMode; // 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  if (layoutMode && layoutMode !== 'NONE') {
    out.direction = layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    out.spacing = {
      gap: pickNum(node.itemSpacing, 0),
      paddingTop: pickNum(node.paddingTop, 0),
      paddingRight: pickNum(node.paddingRight, 0),
      paddingBottom: pickNum(node.paddingBottom, 0),
      paddingLeft: pickNum(node.paddingLeft, 0),
    };
    out.alignItems = axisAlign(node.counterAxisAlignItems);
    out.justifyContent = axisAlign(node.primaryAxisAlignItems);
  }

  out.layoutSizing = deriveLayoutSizing(node);

  // Fills, strokes, effects. Paints with visible:false dropped (match effects filter).
  if (node.fills?.length) {
    const vis = node.fills.filter((p) => p.visible !== false);
    if (vis.length) out.fills = vis.map(normalizePaint);
  }
  if (node.strokes?.length) {
    const vis = node.strokes.filter((p) => p.visible !== false);
    if (vis.length) {
      out.strokes = vis.map(normalizePaint);
      out.border = {
        width: pickNum(node.strokeWeight, 0),
        align: node.strokeAlign,
        style: node.strokeDashes?.length ? 'dashed' : 'solid',
      };
    }
  }
  if (node.effects?.length) {
    const visible = node.effects.filter((e) => e.visible !== false);
    if (visible.length) out.effects = visible.map(normalizeEffect);
  }

  // Corner radius.
  if (Array.isArray(node.rectangleCornerRadii)) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    out.radius = tl === tr && tr === br && br === bl ? tl : { tl, tr, br, bl };
  } else if (typeof node.cornerRadius === 'number') {
    out.radius = node.cornerRadius;
  }

  // Text content + style.
  if (node.type === 'TEXT') {
    out.text = {
      content: node.characters,
      style: extractTextStyle(node.style),
      textAlign: (node.style?.textAlignHorizontal || 'LEFT').toLowerCase(),
      verticalAlign: (node.style?.textAlignVertical || 'TOP').toLowerCase(),
    };
  }

  // Instance reference for later component-cluster derivation.
  // Figma REST exposes component metadata via the per-file `components` dictionary,
  // not on the instance node itself (ctx.components[componentId].key).
  if (node.type === 'INSTANCE') {
    const compMeta = ctx.components?.[node.componentId];
    const setMeta = compMeta?.componentSetId ? ctx.componentSets?.[compMeta.componentSetId] : null;
    out.componentRef = {
      componentId: node.componentId,
      componentKey: compMeta?.key ?? null,
      mainComponentKey: compMeta?.key ?? null,
      componentName: compMeta?.name ?? null,
      remote: compMeta?.remote ?? false,
      componentSetId: compMeta?.componentSetId ?? null,
      componentSetKey: setMeta?.key ?? null,
      componentSetName: setMeta?.name ?? null,
      overrides: node.overrides ?? null,
      componentProperties: node.componentProperties ?? null,
    };
  }

  // Image fills — preserve crop percentages (R29).
  const imagePaint = out.fills?.find((f) => f.type === 'IMAGE');
  if (imagePaint) {
    out.imageFrame = {
      imageRef: imagePaint.imageRef,
      scaleMode: imagePaint.scaleMode,
      imageTransform: imagePaint.imageTransform ?? null,
      rotation: imagePaint.rotation ?? 0,
    };
  }

  // Vector / icon markers — detect small square shapes on leaf vectors.
  if (['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'].includes(node.type)) {
    out.icon = {
      visibleSizePx: dimensions ? Math.max(dimensions.width, dimensions.height) : null,
    };
  }

  // boundVariables → token refs.
  if (node.boundVariables) {
    out.tokenRefs = resolveBoundVariables(node.boundVariables, tokenMap);
    // R48 hex-fallback: when fills/strokes alias points to an unfetched library,
    // reverse-lookup by the node's raw paint color against known tokens.
    const fallbackForPaints = (arr, nodeArr) => {
      if (!Array.isArray(arr)) return arr;
      return arr.map((ref, i) => {
        if (ref && ref.name) return ref; // already resolved
        const paint = nodeArr?.[i];
        const raw = paint?.color;
        if (!raw) return ref;
        const hex = '#' +
          [raw.r, raw.g, raw.b].map((n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')).join('');
        const fb = resolveBoundVariableByHex(tokenMap, hex);
        return fb || ref;
      });
    };
    if (out.tokenRefs.fills) out.tokenRefs.fills = fallbackForPaints(out.tokenRefs.fills, node.fills);
    if (out.tokenRefs.strokes) out.tokenRefs.strokes = fallbackForPaints(out.tokenRefs.strokes, node.strokes);
  }

  // Style refs (published library styles — no Enterprise required).
  // Resolve through ctx.styles dictionary if available.
  if (node.styles) {
    out.styles = {};
    for (const [field, styleId] of Object.entries(node.styles)) {
      const meta = ctx.styles?.[styleId];
      out.styles[field] = meta ? { id: styleId, key: meta.key, name: meta.name, styleType: meta.styleType, remote: meta.remote } : { id: styleId };
    }
  }

  // Constraints (for fixed-design layouts).
  if (node.constraints) out.constraints = node.constraints;

  // Recurse children.
  if (Array.isArray(node.children) && node.children.length) {
    out.children = node.children
      .map((child) => transformNode(child, { ...ctx, parentMode: layoutMode }))
      .filter(Boolean);
  }

  return out;
}

function axisAlign(val) {
  if (!val) return null;
  switch (val) {
    case 'MIN': return 'start';
    case 'CENTER': return 'center';
    case 'MAX': return 'end';
    case 'SPACE_BETWEEN': return 'space-between';
    case 'BASELINE': return 'baseline';
    default: return val.toLowerCase();
  }
}

function deriveLayoutSizing(node) {
  // Modern Figma files: layoutSizingHorizontal/Vertical are explicit.
  if (node.layoutSizingHorizontal || node.layoutSizingVertical) {
    return {
      horizontal: node.layoutSizingHorizontal || 'FIXED',
      vertical: node.layoutSizingVertical || 'FIXED',
    };
  }
  // Fallback: derive from legacy primary/counterAxisSizingMode + layoutGrow/Align.
  const isHorizontal = node.layoutMode === 'HORIZONTAL';
  const primary = node.primaryAxisSizingMode; // AUTO (HUG) | FIXED
  const counter = node.counterAxisSizingMode; // AUTO (HUG) | FIXED
  const h = isHorizontal ? primary : counter;
  const v = isHorizontal ? counter : primary;
  return {
    horizontal: mapLegacySizing(h, node.layoutGrow, 'horizontal'),
    vertical: mapLegacySizing(v, node.layoutAlign, 'vertical'),
  };
}

function mapLegacySizing(sizing, growOrAlign, axis) {
  if (axis === 'horizontal' && growOrAlign === 1) return 'FILL';
  if (axis === 'vertical' && growOrAlign === 'STRETCH') return 'FILL';
  if (sizing === 'AUTO') return 'HUG';
  return 'FIXED';
}

function normalizePaint(paint) {
  const base = { type: paint.type, visible: paint.visible !== false, opacity: paint.opacity ?? 1, blendMode: paint.blendMode };
  if (paint.type === 'SOLID') {
    return { ...base, color: rgbaToHex(paint.color, paint.opacity) };
  }
  if (paint.type === 'IMAGE') {
    return {
      ...base,
      imageRef: paint.imageRef,
      scaleMode: paint.scaleMode,
      imageTransform: paint.imageTransform,
      scalingFactor: paint.scalingFactor,
      rotation: paint.rotation,
    };
  }
  if (paint.type?.startsWith('GRADIENT')) {
    return {
      ...base,
      gradientHandlePositions: paint.gradientHandlePositions,
      gradientStops: paint.gradientStops?.map((s) => ({ position: s.position, color: rgbaToHex(s.color) })),
    };
  }
  return base;
}

function normalizeEffect(e) {
  return {
    type: e.type,
    color: e.color ? rgbaToHex(e.color) : null,
    offset: e.offset ?? null,
    radius: e.radius ?? null,
    spread: e.spread ?? null,
    blendMode: e.blendMode ?? null,
  };
}

function extractTextStyle(style) {
  if (!style) return null;
  return {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontSize: style.fontSize,
    lineHeight: style.lineHeightPx ?? (style.lineHeightPercent ? `${style.lineHeightPercent}%` : null),
    letterSpacing: style.letterSpacing ?? null,
    textCase: style.textCase ?? null,
    textDecoration: style.textDecoration ?? null,
    italic: !!style.italic,
  };
}

function rgbaToHex(c, opacity = 1) {
  if (!c) return null;
  const a = c.a != null ? c.a * opacity : opacity;
  const to = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return a < 1 ? `${hex}${to(a)}` : hex;
}

function pickNum(v, fallback) {
  return typeof v === 'number' ? v : fallback;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
