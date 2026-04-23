#!/usr/bin/env node
/**
 * validate.mjs
 * Incremental layered validation (R16). Hash-skip cache. Screenshot cache.
 *
 * Usage:
 *   validate.mjs --target src/components/Button/Button.tsx --spec .build-slices/components/Button.json --url http://localhost:5173 [--fast|--full]
 *   validate.mjs --target src/pages/login/Login.tsx --spec .build-slices/screens/login.json --url http://localhost:5173 --full
 *
 * Layers:
 *   L1 structure  — DOM tree vs Figma tree (count + name heuristic)
 *   L2 layout     — bounding boxes ±2px, layoutSizing enforced
 *   L3 color      — resolved CSS var values vs token map
 *   L4 typography — computed font props vs typography.styles
 *   L5 pixel diff — screenshot vs Figma ref (screens only)
 *
 * R20: no hardcoded selectors/class names. Match by name + spatial heuristic.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.validate-cache');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const mode = args.full ? 'full' : 'fast';
// W4: --skip-pixel skips L5 entirely (screenshot + pixelmatch). Fix loop uses this for
// intermediate validates; final validate omits flag to get fidelity score.
const skipPixel = !!args['skip-pixel'];
// L11: opt-in deep structural check (node-level padding/radius/border/bg/color per
// [data-component] root). Off by default — runs only when --deep passed. Intended
// for manual /fix triage, not auto-validate loop (R47).
const deep = !!args.deep;
const target = args.target;
const specPath = args.spec;
const baseUrl = args.url;
if (!target || !specPath || !baseUrl) {
  console.error('usage: --target <path> --spec <slice> --url <base> [--fast|--full]');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const isScreen = !!spec.screen;

const fileHash = createHash('sha256')
  .update(readFileSync(target))
  .update(readFileSync(specPath))
  .digest('hex');
const cacheFile = join(CACHE, `${fileHash}.pass.json`);

if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
mkdirSync(join(CACHE, 'shots'), { recursive: true });

if (existsSync(cacheFile) && mode === 'fast') {
  console.log(JSON.stringify({ target, pass: true, cached: true }));
  process.exit(0);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
// W3: single context sized to design dims when screen. Figma ref PNG is 2x (scale:2),
// so DPR:2 screenshot matches without a second context.
const ctxOpts = { deviceScaleFactor: 2 };
if (isScreen && spec.screen?.dimensions) {
  ctxOpts.viewport = { width: spec.screen.dimensions.width, height: spec.screen.dimensions.height };
}
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();

let route;
if (isScreen) route = spec.screen.route;
else route = `/__component-preview/${spec.component.name}`;
// W2: domcontentloaded + selector wait instead of networkidle. HMR / StrictMode
// keeps network pings alive → networkidle burns 500ms+ per goto.
await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForSelector(isScreen ? '[data-screen]' : '[data-component]', { timeout: 5000 });
} catch {
  // Selector missing → L1 will fail with proper diagnostic. Don't block goto.
}

const result = { target, mode, pass: true, layers: {} };

/* L1 STRUCTURE — match landmark nodes only (data-component / data-screen). */
if (isScreen) {
  const expectedComponents = new Set();
  const walkTree = (nodes) => {
    for (const n of nodes || []) {
      if (n.kind === 'component' && n.componentName) expectedComponents.add(n.componentName);
      if (n.children) walkTree(n.children);
    }
  };
  walkTree(spec.screen.tree);
  const domInfo = await page.evaluate(() => ({
    screenRoot: !!document.querySelector('[data-screen]'),
    components: Array.from(document.querySelectorAll('[data-component]')).map((el) => el.getAttribute('data-component')),
  }));
  const missing = [...expectedComponents].filter((n) => !domInfo.components.includes(n));
  if (!domInfo.screenRoot) { result.layers.L1 = { fail: 'screen root missing data-screen attribute' }; result.pass = false; }
  else if (missing.length) { result.layers.L1 = { fail: `missing components in DOM: ${missing.join(', ')}` }; result.pass = false; }
  else result.layers.L1 = `pass (${domInfo.components.length} component roots)`;
} else {
  const found = await page.evaluate((name) => !!document.querySelector(`[data-component="${name}"]`), spec.component.name);
  if (!found) { result.layers.L1 = { fail: `component root with data-component="${spec.component.name}" not found` }; result.pass = false; }
  else result.layers.L1 = 'pass';
}

const domTree = await page.evaluate(() => {
  const el = document.querySelector('[data-screen], [data-component]') || document.body.firstElementChild || document.body;
  const r = el.getBoundingClientRect();
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
});

if (result.pass) {
  /* L2 LAYOUT — branches on viewportFit (R31) for screens; FIXED px for components */
  const rootRect = domTree.rect;
  if (isScreen) {
    const fit = spec.screen.viewportFit || 'fill';
    const viewport = page.viewportSize();
    const { width, height } = spec.screen.dimensions;
    if (fit === 'fill') {
      if (Math.abs(rootRect.w - viewport.width) > 2 || Math.abs(rootRect.h - viewport.height) > 2) {
        result.layers.L2 = { fail: `fill mode: root ${rootRect.w}x${rootRect.h} vs viewport ${viewport.width}x${viewport.height}` };
        result.pass = false;
      } else result.layers.L2 = `pass (fill ${viewport.width}x${viewport.height})`;
    } else if (fit === 'fixed-design') {
      if (Math.abs(rootRect.w - width) > 2 || Math.abs(rootRect.h - height) > 2) {
        result.layers.L2 = { fail: `fixed-design: root ${rootRect.w}x${rootRect.h} vs spec ${width}x${height}` };
        result.pass = false;
      } else result.layers.L2 = `pass (fixed-design ${width}x${height})`;
    } else if (fit === 'scale') {
      const scale = Math.min(viewport.width / width, viewport.height / height);
      const expectedW = width * scale, expectedH = height * scale;
      if (Math.abs(rootRect.w - expectedW) > 2 || Math.abs(rootRect.h - expectedH) > 2) {
        result.layers.L2 = { fail: `scale ${scale.toFixed(3)}: root ${rootRect.w}x${rootRect.h} vs expected ${expectedW.toFixed(1)}x${expectedH.toFixed(1)}` };
        result.pass = false;
      } else result.layers.L2 = `pass (scale ${scale.toFixed(3)})`;
    }
  } else {
    const variant0 = spec.component.variants[0];
    if (variant0.layoutSizing.horizontal === 'FIXED' && Math.abs(rootRect.w - variant0.dimensions.width) > 2) {
      result.layers.L2 = { fail: `FIXED width ${rootRect.w} vs ${variant0.dimensions.width}` };
      result.pass = false;
    } else result.layers.L2 = 'pass';
  }
}

if (result.pass) {
  /* L3 COLOR — background-color of component root, resolve CSS vars */
  const compName = spec.component?.name;
  const computed = await page.evaluate((name) => {
    const el = name ? document.querySelector(`[data-component="${name}"]`) : (document.body.firstElementChild || document.body);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color, borderColor: s.borderColor };
  }, compName);
  const rgbToHex = (rgb) => {
    const m = rgb.match(/\d+/g);
    if (!m) return null;
    return '#' + m.slice(0, 3).map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  };
  if (!computed) {
    result.layers.L3 = { fail: `data-component="${compName}" not found` };
    result.pass = false;
  } else {
    const tokens = spec.tokens?.map || {};
    const variantColors = isScreen ? {} : (spec.component.variants[0].colors || {});
    const hasBgSlot = Object.keys(variantColors).some((k) => /^(background|bg)$/i.test(k));
    const expectedColors = Object.entries(variantColors).map(([slot, ref]) => ({ slot, value: tokens[ref]?.value?.toLowerCase() }));
    const fails = [];
    const actualBg = rgbToHex(computed.bg);
    if (hasBgSlot && expectedColors.length > 0 && actualBg && !expectedColors.some((e) => e.value === actualBg)) {
      fails.push({ prop: 'bg', actual: actualBg, expectedAny: expectedColors.map((e) => e.value) });
    }
    if (fails.length) { result.layers.L3 = { fails }; result.pass = false; }
    else result.layers.L3 = 'pass';
  }
}

if (result.pass) {
  /* L4 TYPOGRAPHY */
  const firstText = await page.evaluate(() => {
    const all = Array.from(document.body.querySelectorAll('*')).find((el) => el.textContent?.trim() && el.children.length === 0);
    if (!all) return null;
    const s = getComputedStyle(all);
    return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing };
  });
  const typoExpected = isScreen ? null : spec.component.variants[0].typography?.[0];
  if (typoExpected && firstText) {
    const style = spec.typography?.styles?.[typoExpected.textStyle];
    if (style) {
      const actualSize = parseFloat(firstText.fontSize);
      const expectedSize = parseFloat(style.fontSize);
      const sizeDelta = Math.abs(actualSize - expectedSize);
      const actualWeight = parseInt(firstText.fontWeight, 10);
      const fails = [];
      if (sizeDelta > 1) fails.push({ prop: 'fontSize', actual: firstText.fontSize, expected: style.fontSize });
      if (actualWeight !== style.fontWeight) fails.push({ prop: 'fontWeight', actual: actualWeight, expected: style.fontWeight });
      if (fails.length) { result.layers.L4 = { fails }; result.pass = false; }
      else result.layers.L4 = 'pass';
    } else result.layers.L4 = 'pass';
  } else result.layers.L4 = 'pass';
}

/* L6 STRUCTURAL INTEGRITY — targeted at library-wrapper leak bugs.
   Checks: native form elements (<input>, <textarea>, <select>, <button>'s inner defaults) inside
   [data-component] wrappers should be visually hidden — otherwise browser defaults render on top
   of the styled wrapper (the "double checkbox" class of bug).
   Library-agnostic. Catches leaks from PrimeReact/MUI/Chakra/etc. */
if (result.pass) {
  const structuralFails = await page.evaluate(() => {
    const fails = [];
    const isVisuallyHidden = (el) => {
      const s = getComputedStyle(el);
      if (s.opacity === '0') return true;
      if (s.visibility === 'hidden' || s.display === 'none') return true;
      if (parseFloat(s.width) === 0 || parseFloat(s.height) === 0) return true;
      return false;
    };
    const comps = document.querySelectorAll('[data-component]');
    for (const comp of comps) {
      const name = comp.getAttribute('data-component');
      // Find native form elements prone to double-render when library-wrapped (checkbox/radio).
      // Text-like inputs are expected visible — skip.
      const nativeInputs = comp.querySelectorAll('input[type="checkbox"], input[type="radio"]');
      for (const inp of nativeInputs) {
        // Skip if inside a nested [data-component]
        let parent = inp.parentElement;
        let insideNested = false;
        while (parent && parent !== comp) {
          if (parent.hasAttribute('data-component')) { insideNested = true; break; }
          parent = parent.parentElement;
        }
        if (insideNested) continue;
        if (!isVisuallyHidden(inp)) {
          fails.push({ component: name, tag: inp.tagName.toLowerCase(), type: inp.getAttribute('type') || '' });
        }
      }
    }
    return fails;
  });
  if (structuralFails.length) {
    result.layers.L6 = { fails: structuralFails.map((f) => ({ prop: `${f.component} visible native <${f.tag}${f.type ? ' type="' + f.type + '"' : ''}>`, actual: 'visible', expected: 'hidden (opacity:0 or display:none)' })) };
    // Advisory — does not gate the run. Logged to FIXLOG so user sees it.
  } else {
    result.layers.L6 = 'pass';
  }
}

/* L8 SIBLING CONSISTENCY — for each component NAME with multiple instances in the DOM, flag
   outliers whose bounding-box dims differ significantly from the median. Catches single variants
   whose container got sized wrong (e.g. one StatusChip variant rendered at 24x24 while others 16x16). */
if (result.pass) {
  const siblingFails = await page.evaluate(() => {
    const fails = [];
    const byName = new Map();
    for (const el of document.querySelectorAll('[data-component]')) {
      const name = el.getAttribute('data-component');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(el);
    }
    for (const [name, instances] of byName) {
      if (instances.length < 3) continue;
      // Compare FIRST-child-span/span dimensions (icon containers typical position)
      const heights = instances.map((el) => {
        const firstSpan = el.querySelector(':scope > span');
        return firstSpan ? firstSpan.getBoundingClientRect().height : null;
      }).filter((h) => h != null && h > 0);
      if (heights.length < 3) continue;
      const sorted = [...heights].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const outliers = heights.filter((h) => Math.abs(h - median) / median > 0.3);
      if (outliers.length && outliers.length < heights.length) {
        fails.push({ component: name, median: Math.round(median), outliers: outliers.map((h) => Math.round(h)) });
      }
    }
    return fails;
  });
  if (siblingFails.length) {
    result.layers.L8 = { fails: siblingFails.map((f) => ({ prop: `${f.component} first-child height`, actual: `outliers [${f.outliers.join(',')}]`, expected: `near median ${f.median}px` })) };
  } else {
    result.layers.L8 = 'pass';
  }
}

/* L9 UNDEFINED CSS VARIABLES — scan source files for var(--x) without fallback; verify each var
   is defined in a :root block somewhere. Catches agent-invented var names (silent failure
   when undefined var resolves to initial value). */
function _findProjectRootForL9(path) {
  let dir = dirname(path);
  while (dir !== '/' && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'src'))) return dir;
    dir = dirname(dir);
  }
  return dirname(path);
}
if (result.pass) {
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  const { join: pjoin } = await import('node:path');
  const l9ProjectRoot = _findProjectRootForL9(target);
  const srcRoot = pjoin(l9ProjectRoot, 'src');
  // W1: cache L9 result keyed by recursive mtime fingerprint of src/. Skip re-walk if unchanged.
  const l9CacheFile = join(CACHE, `l9-${createHash('sha256').update(srcRoot).digest('hex').slice(0, 12)}.json`);
  const fingerprint = (() => {
    let agg = '';
    const acc = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === 'build') continue;
        const p = pjoin(dir, entry);
        let s; try { s = statSync(p); } catch { continue; }
        if (s.isDirectory()) acc(p);
        else if (/\.(scss|css|tsx?)$/.test(entry)) agg += `${p}:${s.mtimeMs}:${s.size};`;
      }
    };
    acc(srcRoot);
    return createHash('sha256').update(agg).digest('hex');
  })();
  let cachedL9 = null;
  if (existsSync(l9CacheFile)) {
    try {
      const parsed = JSON.parse(readFileSync(l9CacheFile, 'utf8'));
      if (parsed.fingerprint === fingerprint) cachedL9 = parsed;
    } catch {}
  }
  const usedVars = new Set(cachedL9?.usedVars || []);
  const definedVars = new Set(cachedL9?.definedVars || []);
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === 'build') continue;
      const p = pjoin(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(scss|css|tsx?)$/.test(entry)) {
        const body = readFileSync(p, 'utf8');
        for (const m of body.matchAll(/var\((--[a-z0-9-_]+)(?:,([^)]+))?\)/gi)) {
          if (!m[2]) usedVars.add(m[1]);
        }
        for (const m of body.matchAll(/(--[a-z0-9-_]+)\s*:/gi)) {
          definedVars.add(m[1]);
        }
      }
    }
  };
  if (!cachedL9) {
    walk(srcRoot);
    writeFileSync(l9CacheFile, JSON.stringify({ fingerprint, usedVars: [...usedVars], definedVars: [...definedVars] }));
  }
  const undef = [...usedVars].filter((v) => !definedVars.has(v));
  if (undef.length) {
    result.layers.L9 = { fails: undef.map((v) => ({ prop: 'undefined CSS var', actual: v, expected: 'defined in :root' })) };
  } else {
    result.layers.L9 = 'pass';
  }
}

/* L11 NODE-LEVEL STRUCTURAL (opt-in via --deep, R47) — walks every [data-component] in the DOM
   and compares computed CSS (padding/gap/radius/border/bg/color) to its variant spec. Skipped
   unless --deep. Intended for manual /fix triage, not the auto-validate loop. */
if (result.pass && deep && isScreen) {
  const YAMLmod = await import('js-yaml');
  const sharedComponentsDir = join(ROOT, 'design-contract', 'components');
  const componentSpecs = {}; // name → variant[0]
  if (existsSync(sharedComponentsDir)) {
    for (const f of readdirSync(sharedComponentsDir).filter((x) => x.endsWith('.yml') && !['index.yml', 'consolidation-log.yml'].includes(x))) {
      try {
        const body = YAMLmod.default.load(readFileSync(join(sharedComponentsDir, f), 'utf8'));
        if (body?.name && body.variants?.[0]) componentSpecs[body.name] = body.variants[0];
      } catch {}
    }
  }
  // Token → hex (from tokens slice embedded in screen spec).
  const tokenMap = spec.tokens?.map || {};
  const tokenHex = (ref) => {
    const t = tokenMap[ref];
    if (!t?.value) return null;
    return normalizeHex(t.value);
  };
  function normalizeHex(v) {
    if (!v) return null;
    let s = String(v).trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map(c=>c+c).join('');
    if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) s = s.slice(0, 7);
    const m = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
    if (m) { const to = n => parseInt(n,10).toString(16).padStart(2,'0'); s = '#'+to(m[1])+to(m[2])+to(m[3]); }
    return s;
  }

  const detailFails = await page.evaluate((specs) => {
    const fails = [];
    const toPx = (s) => parseFloat(s) || 0;
    const rgbToHex = (rgb) => {
      const m = rgb.match(/\d+/g);
      if (!m) return null;
      return '#' + m.slice(0,3).map(n => parseInt(n,10).toString(16).padStart(2,'0')).join('');
    };
    for (const el of document.querySelectorAll('[data-component]')) {
      const name = el.getAttribute('data-component');
      const variant = specs[name];
      if (!variant) continue;
      const cs = getComputedStyle(el);
      const push = (prop, actual, expected, detail) => fails.push({ component: name, prop, actual, expected, detail });

      // Padding
      if (variant.spacing) {
        const sp = variant.spacing;
        const map = [
          ['paddingTop', sp.paddingTop],
          ['paddingRight', sp.paddingRight],
          ['paddingBottom', sp.paddingBottom],
          ['paddingLeft', sp.paddingLeft],
        ];
        for (const [k, exp] of map) {
          if (exp == null) continue;
          const actual = toPx(cs[k]);
          if (Math.abs(actual - exp) > 1) push(k, `${actual}px`, `${exp}px`);
        }
        if (typeof sp.gap === 'number' && cs.display.includes('flex')) {
          const actualGap = toPx(cs.gap);
          if (Math.abs(actualGap - sp.gap) > 1) push('gap', `${actualGap}px`, `${sp.gap}px`);
        }
      }
      // Radius
      if (variant.radius != null) {
        const exp = typeof variant.radius === 'number' ? variant.radius : null;
        if (exp != null) {
          const actual = toPx(cs.borderRadius);
          if (Math.abs(actual - exp) > 1) push('borderRadius', `${actual}px`, `${exp}px`);
        }
      }
      // Border
      if (variant.border && variant.border.width != null) {
        const exp = variant.border.width;
        const actual = toPx(cs.borderTopWidth);
        if (Math.abs(actual - exp) > 1) push('borderWidth', `${actual}px`, `${exp}px`);
      }
      // Colors — compare computed bg to expected token hex (root slot aliases).
      const colors = variant.colors || {};
      const bgRef = colors.bg || colors.background || colors.root;
      if (bgRef && specs._tokenMap?.[bgRef]) {
        const actualBg = rgbToHex(cs.backgroundColor);
        const expHex = specs._tokenMap[bgRef];
        if (actualBg && expHex && actualBg.toLowerCase() !== expHex.toLowerCase()) {
          push('backgroundColor', actualBg, expHex, `token=${bgRef}`);
        }
      }
      const textRef = colors.text || colors.foreground;
      if (textRef && specs._tokenMap?.[textRef]) {
        const actualColor = rgbToHex(cs.color);
        const expHex = specs._tokenMap[textRef];
        if (actualColor && expHex && actualColor.toLowerCase() !== expHex.toLowerCase()) {
          push('color', actualColor, expHex, `token=${textRef}`);
        }
      }
      // FIXED dims
      if (variant.layoutSizing?.horizontal === 'FIXED' && variant.dimensions?.width) {
        const r = el.getBoundingClientRect();
        if (Math.abs(r.width - variant.dimensions.width) > 1) push('width', `${Math.round(r.width)}px`, `${variant.dimensions.width}px`);
      }
      if (variant.layoutSizing?.vertical === 'FIXED' && variant.dimensions?.height) {
        const r = el.getBoundingClientRect();
        if (Math.abs(r.height - variant.dimensions.height) > 1) push('height', `${Math.round(r.height)}px`, `${variant.dimensions.height}px`);
      }
    }
    return fails;
  }, { ...componentSpecs, _tokenMap: Object.fromEntries(Object.entries(tokenMap).map(([k,v]) => [k, normalizeHex(v.value)])) });

  if (detailFails.length) {
    result.layers.L11 = { fails: detailFails };
    result.pass = false;
  } else {
    result.layers.L11 = 'pass';
  }
}

/* L13 IMAGE-ASPECT SANITY (R52, opt-in via --deep) — for every rendered <img>, compare native
   asset aspect ratio vs rendered bbox aspect ratio. Diff >2% AND no R29 crop pct present on
   positioning → fail "silent stretch". Catches aspect-distortion regardless of upstream audit. */
if (result.pass && deep && isScreen) {
  const aspectFails = await page.evaluate(async () => {
    const fails = [];
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      // Wait for natural dims.
      if (!img.complete || img.naturalWidth === 0) {
        try {
          await new Promise((resolve, reject) => {
            if (img.complete && img.naturalWidth > 0) return resolve();
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', reject, { once: true });
            setTimeout(resolve, 1500); // budget
          });
        } catch {}
      }
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const nativeAspect = nw / nh;
      const renderedAspect = r.width / r.height;
      const diffPct = Math.abs(nativeAspect - renderedAspect) / nativeAspect;
      if (diffPct <= 0.02) continue;
      // R29 crop escape: if the img uses percentage width+height + left/top (negative or
      // non-zero) suggesting an intentional crop, or object-fit contain/cover, skip.
      const cs = getComputedStyle(img);
      const of = cs.objectFit;
      if (of === 'contain' || of === 'cover' || of === 'none') continue;
      // Treat >100% width/height (arbitrary Tailwind crop) as intentional.
      const styleW = img.style.width || '';
      const styleH = img.style.height || '';
      const cls = img.className || '';
      // R29 legit crop requires NON-trivial pcts: width/height >100%, OR negative left/top.
      // Identity pct `[0%] [0%]` = no crop → does NOT exempt silent stretch.
      const nontrivialCrop =
        /\[1\d{2,}(\.\d+)?%\]|\[[2-9]\d{2,}(\.\d+)?%\]|\b[wh]-\[1\d{2,}(\.\d+)?%\]/.test(cls) ||
        /\bleft-\[-\d/.test(cls) || /\btop-\[-\d/.test(cls);
      if (nontrivialCrop) continue;
      fails.push({
        src: (img.src.split('/').pop() || '').slice(0, 60),
        native: `${nw}x${nh} (${nativeAspect.toFixed(3)})`,
        rendered: `${Math.round(r.width)}x${Math.round(r.height)} (${renderedAspect.toFixed(3)})`,
        diffPct: `${(diffPct * 100).toFixed(1)}%`,
        objectFit: of,
      });
    }
    return fails;
  });
  if (aspectFails.length) {
    result.layers.L13 = { fails: aspectFails.map((f) => ({ prop: `img silent-stretch ${f.src}`, actual: f.rendered, expected: `aspect-preserving (native ${f.native})`, detail: `diff=${f.diffPct} object-fit=${f.objectFit}` })) };
    result.pass = false;
  } else {
    result.layers.L13 = 'pass';
  }
}

/* L10 TOKEN FIDELITY — cross-verify Figma tokens.yml vs project tokens.css + all var() references.
   Delegates to scripts/check-tokens.mjs. Inherits its pass/warn/fail output. R46. */
if (result.pass) {
  const { spawnSync } = await import('node:child_process');
  const contractGuess = isScreen ? spec.screen?._contractRoot : spec.component?._contractRoot;
  const pageSlug = isScreen ? spec.screen?._pageSlug : spec.component?._pageSlug;
  // Best-effort: slices may embed the source contract path, else fall back to scanning all pages.
  let contractArg = contractGuess || join(ROOT, 'design-contract');
  if (pageSlug && existsSync(join(contractArg, 'pages', pageSlug))) {
    contractArg = join(contractArg, 'pages', pageSlug);
  }
  const srcRootGuess = _findProjectRootForL9(target);
  const srcPath = join(srcRootGuess, 'src');
  if (existsSync(srcPath)) {
    const res = spawnSync('node', [join(ROOT, 'scripts/check-tokens.mjs'), '--contract', contractArg, '--src', srcPath, '--quiet'], { encoding: 'utf8' });
    if (res.status === 0) {
      result.layers.L10 = 'pass';
    } else {
      const failLines = (res.stdout || '').split('\n').filter((l) => l.startsWith('  {')).slice(0, 10);
      result.layers.L10 = { fails: failLines.map((l) => {
        try { return JSON.parse(l.trim()); } catch { return { raw: l.trim() }; }
      }) };
      result.pass = false;
    }
  } else {
    result.layers.L10 = 'skip (no src dir)';
  }
}

/* L7 ICON-RATIO SANITY — inside icon-container components (IconButton et al), flag children
   that exceed 60% of container size. Catches caller-set size bump without matching iconSize prop. */
if (result.pass) {
  const ratioFails = await page.evaluate(() => {
    const fails = [];
    const iconHosts = document.querySelectorAll('[data-component="IconButton"]');
    for (const host of iconHosts) {
      const hr = host.getBoundingClientRect();
      if (hr.width === 0) continue;
      const firstImg = host.querySelector('img, svg');
      if (!firstImg) continue;
      const ir = firstImg.getBoundingClientRect();
      const ratio = ir.width / hr.width;
      if (ratio > 0.6) {
        fails.push({ host: hr.width, icon: ir.width, ratio: ratio.toFixed(2) });
      }
    }
    return fails;
  });
  if (ratioFails.length) {
    result.layers.L7 = { fails: ratioFails.map((f) => ({ prop: 'IconButton child size', actual: `${f.icon}/${f.host}px (ratio ${f.ratio})`, expected: '≤60% of container' })) };
  } else {
    result.layers.L7 = 'pass';
  }
}

/* L5 PIXEL DIFF — screens only. Skipped when --skip-pixel (W4: fix-loop intermediate validates).
   Rendered at design dimensions so fidelity is viewport-independent. */
result.fidelity = null;
if (isScreen && skipPixel) {
  result.layers.L5 = 'skip (--skip-pixel)';
  result.fidelity = 'skipped';
}
if (isScreen && !skipPixel) {
  const { PNG } = await import('pngjs');
  const pixelmatch = (await import('pixelmatch')).default;
  const { width, height } = spec.screen.dimensions;
  const figmaRefPath = join(CACHE, 'shots', `figma-${spec.screen.name}.png`);
  if (!existsSync(figmaRefPath)) {
    result.layers.L5 = { skip: 'no figma reference cached — run screenshot.mjs first' };
    result.fidelity = 'n/a (no reference)';
  } else {
    // W3: reuse existing page (already sized to design dims, DPR:2). Figma ref is 2x scale,
    // so DPR:2 screenshot matches pixel-for-pixel without a second browser context.
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
    const img1 = PNG.sync.read(shot);
    const img2 = PNG.sync.read(readFileSync(figmaRefPath));
    if (img1.width !== img2.width || img1.height !== img2.height) {
      result.layers.L5 = { fail: `size ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}` };
      result.fidelity = 'size mismatch';
      if (mode === 'full') result.pass = false;
    } else {
      const diff = new PNG({ width: img1.width, height: img1.height });
      const n = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, { threshold: 0.1 });
      const pct = n / (img1.width * img1.height);
      const pctStr = (pct * 100).toFixed(2) + '%';
      result.fidelity = (100 - pct * 100).toFixed(2) + '%';
      if (mode === 'full') {
        if (pct > 0.02) { result.layers.L5 = { fail: `${pctStr} mismatch` }; result.pass = false; }
        else result.layers.L5 = `pass (${pctStr} mismatch)`;
      } else {
        result.layers.L5 = `info (${pctStr} mismatch — --fast mode doesn't gate on L5)`;
      }
    }
  }
}

await browser.close();

if (result.pass) writeFileSync(cacheFile, JSON.stringify(result, null, 2));

/* FIXLOG — write/update <project>/FIXLOG.md with diff vs previous run */
function collectIssues(res) {
  const issues = [];
  for (const [layer, v] of Object.entries(res.layers || {})) {
    if (typeof v === 'string') {
      if (v.startsWith('pass') || v.startsWith('skip') || v.startsWith('info')) continue;
      issues.push({ id: `${layer}:${v}`, layer, msg: v });
    } else if (v && v.fail) {
      issues.push({ id: `${layer}:${v.fail}`, layer, msg: v.fail });
    } else if (v && v.fails) {
      for (const f of v.fails) {
        const key = `${f.prop}:${f.actual}vs${f.expected || JSON.stringify(f.expectedAny)}`;
        issues.push({ id: `${layer}:${key}`, layer, msg: `${f.prop} actual=${f.actual} expected=${f.expected || JSON.stringify(f.expectedAny)}` });
      }
    }
  }
  if (typeof res.fidelity === 'string' && res.fidelity.endsWith('%')) {
    const pct = parseFloat(res.fidelity);
    if (pct < 98) issues.push({ id: `fidelity:<98`, layer: 'fidelity', msg: `${res.fidelity} (below 98% target)` });
  }
  return issues;
}

function parseLastEntry(md) {
  const match = md.match(/## [\d-]+ [\d:]+ — .+?\n[\s\S]*?(?=\n## |$)/);
  if (!match) return { open: new Set() };
  const section = match[0];
  const openMatch = section.match(/### Still open\n([\s\S]*?)(?=\n### |\n---|$)/);
  const newMatch = section.match(/### New\n([\s\S]*?)(?=\n### |\n---|$)/);
  const ids = new Set();
  for (const m of [openMatch, newMatch]) {
    if (!m) continue;
    for (const line of m[1].split('\n')) {
      const idMatch = line.match(/<!--id:(.+?)-->/);
      if (idMatch) ids.add(idMatch[1]);
    }
  }
  return { open: ids };
}

function findProjectRoot(path) {
  let dir = dirname(path);
  while (dir !== '/' && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'src'))) return dir;
    dir = dirname(dir);
  }
  return dirname(path);
}

const projectRoot = findProjectRoot(target);
const fixlogPath = join(projectRoot, 'FIXLOG.md');
const prev = existsSync(fixlogPath) ? readFileSync(fixlogPath, 'utf8') : '';
const { open: prevOpen } = parseLastEntry(prev);

const currentIssues = collectIssues(result);
const currentIds = new Set(currentIssues.map((i) => i.id));
const fixedIds = [...prevOpen].filter((id) => !currentIds.has(id));
const newIssues = currentIssues.filter((i) => !prevOpen.has(i.id));
const stillOpen = currentIssues.filter((i) => prevOpen.has(i.id));

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const fmt = (arr, label) => arr.length
  ? arr.map((i) => typeof i === 'string' ? `- ${i}` : `- **${i.layer}**: ${i.msg} <!--id:${i.id}-->`).join('\n')
  : `_(${label === 'Fixed' ? 'nothing fixed' : 'none'})_`;

const entry = [
  `## ${now} — ${isScreen ? spec.screen.route : spec.component?.name} — fidelity ${result.fidelity || 'n/a'} — ${result.pass ? 'PASS' : 'FAIL'}`,
  ``,
  `### Fixed from previous run`,
  fixedIds.length ? fixedIds.map((id) => `- ~~${id}~~`).join('\n') : `_(nothing fixed)_`,
  ``,
  `### Still open`,
  fmt(stillOpen, 'Still open'),
  ``,
  `### New`,
  fmt(newIssues, 'New'),
  ``,
  `---`,
  ``,
].join('\n');

const header = prev.startsWith('# FIXLOG') ? '' : '# FIXLOG\n\nAuto-generated by `validate.mjs`. Newest run on top. Each entry diffs against the one above.\n\n---\n\n';
const prevBody = prev.replace(/^# FIXLOG[\s\S]*?---\n\n/, '');
writeFileSync(fixlogPath, header + entry + prevBody);

console.log(JSON.stringify(result, null, 2));
console.log(`\n[FIXLOG] updated ${fixlogPath}  fixed:${fixedIds.length}  still-open:${stillOpen.length}  new:${newIssues.length}`);
process.exit(result.pass ? 0 : 1);
