#!/usr/bin/env node
/**
 * prepare-build.mjs
 * - --validate-index                        validate design-contract/index.yml (A1 output)
 * - --validate                              validate page contract against schemas
 * - --slice components                      write per-component prompt slices to .build-slices/
 * - --slice components --for-screen <name>  write ONLY components used by the named screen (R37)
 * - --slice screens                         write per-screen prompt slices to .build-slices/
 * - --slice screens --order <n1,n2,...>     write screen slices in listed order (screen-by-screen mode)
 *
 * Paths:
 *   Default contract root: design-contract/
 *   --contract <dir>       override root
 *   --page <slug>          operate on design-contract/pages/<slug>/ (A2 output). Required for
 *                          --validate and --slice unless --contract points at a complete contract.
 *
 * Enforces rules at the data layer so agents never infer:
 *   R3  screens[].mockData non-empty
 *   R6  component.variants[].colors values are keys in tokens.map (no raw hex)
 *   R7  FIXED layoutSizing requires dimensions; FILL/HUG requires no dimensions
 *   R9  library-wrapped classification requires libraryComponent
 *   R12 component.icons[].visibleSizePx required
 *   R34 meta.strategy block optional (legacy defaults to mode='full')
 *   R37 --for-screen emits only components referenced by a single screen's enriched tree
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import YAML from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCHEMAS = join(ROOT, 'schemas');

const argv = process.argv.slice(2);
const cmd = argv[0];

const contractFlagIdx = argv.indexOf('--contract');
const CONTRACT_ROOT = contractFlagIdx >= 0 ? argv[contractFlagIdx + 1] : join(ROOT, 'design-contract');
const pageIdx = argv.indexOf('--page');
const PAGE = pageIdx >= 0 ? argv[pageIdx + 1] : null;
const CONTRACT = PAGE ? join(CONTRACT_ROOT, 'pages', PAGE) : CONTRACT_ROOT;
const slicesFlagIdx = argv.indexOf('--out');
const SLICES = slicesFlagIdx >= 0
  ? argv[slicesFlagIdx + 1]
  : (PAGE ? join(ROOT, '.build-slices', PAGE) : join(ROOT, '.build-slices'));
const forScreenIdx = argv.indexOf('--for-screen');
const FOR_SCREEN = forScreenIdx >= 0 ? argv[forScreenIdx + 1] : null;
const orderIdx = argv.indexOf('--order');
const ORDER = orderIdx >= 0 ? argv[orderIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const loadSchema = (name) => JSON.parse(readFileSync(join(SCHEMAS, name), 'utf8'));
const loadYaml = (p) => YAML.load(readFileSync(p, 'utf8'));
const fail = (msg) => { console.error(`[prepare-build] ${msg}`); process.exit(1); };
const log = (msg) => console.log(`[prepare-build] ${msg}`);

function validateContract() {
  if (!existsSync(CONTRACT)) fail(`contract dir missing: ${CONTRACT}${PAGE ? ` (page "${PAGE}" not yet audited — run A2)` : ''}`);

  const validators = {
    meta: ajv.compile(loadSchema('meta.schema.json')),
    tokens: ajv.compile(loadSchema('tokens.schema.json')),
    typography: ajv.compile(loadSchema('typography.schema.json')),
    icons: ajv.compile(loadSchema('icons.schema.json')),
    component: ajv.compile(loadSchema('component.schema.json')),
    screen: ajv.compile(loadSchema('screen.schema.json')),
  };

  const meta = loadYaml(join(CONTRACT, 'meta.yml'));
  if (!validators.meta(meta)) fail(`meta.yml: ${ajv.errorsText(validators.meta.errors)}`);

  const tokens = loadYaml(join(CONTRACT, 'tokens.yml'));
  if (!validators.tokens(tokens)) fail(`tokens.yml: ${ajv.errorsText(validators.tokens.errors)}`);

  const typography = loadYaml(join(CONTRACT, 'typography.yml'));
  if (!validators.typography(typography)) fail(`typography.yml: ${ajv.errorsText(validators.typography.errors)}`);

  const icons = loadYaml(join(CONTRACT, 'icons.yml'));
  if (!validators.icons(icons)) fail(`icons.yml: ${ajv.errorsText(validators.icons.errors)}`);

  const tokenKeys = new Set(Object.keys(tokens.map));
  const typographyKeys = new Set(Object.keys(typography.styles));
  const iconNames = new Set(icons.icons.map((i) => i.name));
  const assetNames = new Set((meta.assets || []).map((a) => a.name));

  const components = {};
  const componentsDir = join(CONTRACT, 'components');
  if (!existsSync(componentsDir)) fail('design-contract/components/ missing');
  for (const file of readdirSync(componentsDir).filter((f) => f.endsWith('.yml'))) {
    const spec = loadYaml(join(componentsDir, file));
    if (!validators.component(spec)) fail(`components/${file}: ${ajv.errorsText(validators.component.errors)}`);
    components[spec.name] = spec;

    if (spec.classification.kind === 'library-wrapped' && !spec.classification.libraryComponent) {
      fail(`R9 violation components/${file}: library-wrapped needs libraryComponent`);
    }

    for (const v of spec.variants) {
      for (const slot of Object.keys(v.colors || {})) {
        const ref = v.colors[slot];
        if (!tokenKeys.has(ref)) {
          fail(`R6 violation components/${file} variant ${v.name} color ${slot}: "${ref}" not in tokens.map`);
        }
      }
      if (v.layoutSizing.horizontal === 'FIXED' && !v.dimensions?.width) {
        fail(`R7 violation components/${file} variant ${v.name}: horizontal FIXED needs dimensions.width`);
      }
      if (v.layoutSizing.vertical === 'FIXED' && !v.dimensions?.height) {
        fail(`R7 violation components/${file} variant ${v.name}: vertical FIXED needs dimensions.height`);
      }
      if (v.layoutSizing.horizontal !== 'FIXED' && v.dimensions?.width) {
        fail(`R7 violation components/${file} variant ${v.name}: non-FIXED must not set dimensions.width`);
      }
      if (v.layoutSizing.vertical !== 'FIXED' && v.dimensions?.height) {
        fail(`R7 violation components/${file} variant ${v.name}: non-FIXED must not set dimensions.height`);
      }
      for (const t of v.typography || []) {
        if (!typographyKeys.has(t.textStyle)) {
          fail(`components/${file} variant ${v.name} typography: "${t.textStyle}" not in typography.styles`);
        }
      }
      for (const icon of v.icons || []) {
        if (!iconNames.has(icon.iconName)) {
          fail(`components/${file} variant ${v.name}: icon "${icon.iconName}" not in icons.icons`);
        }
        if (!icon.visibleSizePx || icon.visibleSizePx <= 0) {
          fail(`R12 violation components/${file} variant ${v.name} icon ${icon.iconName}: visibleSizePx required`);
        }
      }
      for (const frame of v.imageFrames || []) {
        if (!assetNames.has(frame.assetName)) {
          fail(`R29 violation components/${file} variant ${v.name}: imageFrame slot "${frame.slot}" references unknown asset "${frame.assetName}". Add to meta.assets.`);
        }
        if (frame.imageWidthPct == null && frame.imageHeightPct == null && frame.scaleMode !== 'FILL') {
          fail(`R29 violation components/${file} variant ${v.name}: imageFrame slot "${frame.slot}" missing crop percentages. Either set scaleMode=FILL or provide imageWidthPct/imageHeightPct.`);
        }
      }
    }
  }

  const screensDir = join(CONTRACT, 'screens');
  if (!existsSync(screensDir)) fail('design-contract/screens/ missing');
  for (const file of readdirSync(screensDir).filter((f) => f.endsWith('.yml'))) {
    const spec = loadYaml(join(screensDir, file));
    if (!validators.screen(spec)) fail(`screens/${file}: ${ajv.errorsText(validators.screen.errors)}`);

    if (!spec.mockData || Object.keys(spec.mockData).length === 0) {
      fail(`R3 violation screens/${file}: mockData empty`);
    }
    // Walker handles both legacy kinds (component/container) and screens-first kinds
    // (frame/text/instance/vector/rectangle/ellipse/group).
    // For legacy component refs, ensure the componentName exists.
    // For screens-first instance refs, resolution is by mainComponentKey → components
    // index (built below) and is best-effort — missing mainComponentKey is not fatal
    // here because components/ may legitimately lag the screens/ during audit iteration.
    const componentsByKey = {};
    for (const spec of Object.values(components)) {
      if (spec.mainComponentKey) componentsByKey[spec.mainComponentKey] = spec;
    }
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.kind === 'component' && !components[n.componentName]) {
          fail(`screens/${file}: references unknown component "${n.componentName}"`);
        }
        if (n.children) walk(n.children);
      }
    };
    walk(spec.tree);

    // R1: exhaustive data-driven style coverage.
    // For each field declared in dataDrivenStyles, collect every distinct value from mockData (any depth).
    // Every distinct value must appear in the map, or the audit missed variants.
    const collectValuesForField = (obj, field, acc = new Set()) => {
      if (Array.isArray(obj)) {
        for (const item of obj) collectValuesForField(item, field, acc);
      } else if (obj && typeof obj === 'object') {
        if (Object.prototype.hasOwnProperty.call(obj, field)) {
          const v = obj[field];
          if (v != null && typeof v !== 'object') acc.add(String(v));
        }
        for (const k of Object.keys(obj)) collectValuesForField(obj[k], field, acc);
      }
      return acc;
    };
    for (const field of Object.keys(spec.dataDrivenStyles || {})) {
      const declared = new Set(Object.keys(spec.dataDrivenStyles[field]));
      const seen = collectValuesForField(spec.mockData, field);
      const missing = [...seen].filter((v) => !declared.has(v));
      if (missing.length) {
        fail(`R1 violation screens/${file}: dataDrivenStyles.${field} missing entries for values: ${missing.join(', ')}`);
      }
    }
  }

  log(`contract valid. tokens:${tokenKeys.size} type:${typographyKeys.size} icons:${iconNames.size} components:${Object.keys(components).length}`);
  return { meta, tokens, typography, icons, components };
}

/**
 * Walk a screen enriched tree and collect every referenced component name.
 * Resolution priority: legacy `kind=component` componentName → direct name.
 * Screens-first `kind=instance` mainComponentKey → lookup via components index.
 */
function collectComponentNamesForScreen(screenSpec, components) {
  const nameByKey = {};
  for (const c of Object.values(components)) {
    if (c.mainComponentKey) nameByKey[c.mainComponentKey] = c.name;
    for (const v of c.variants || []) {
      if (v.mainComponentKey) nameByKey[v.mainComponentKey] = c.name;
    }
  }
  const refs = new Set();
  const walk = (nodes) => {
    if (!nodes) return;
    for (const n of nodes) {
      if (n.kind === 'component' && n.componentName) refs.add(n.componentName);
      if (n.kind === 'instance' && n.mainComponentKey && nameByKey[n.mainComponentKey]) {
        refs.add(nameByKey[n.mainComponentKey]);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(screenSpec.tree);
  // Modals attached to a base screen (AUDIT.md A2 6f) register their components
  // here so --for-screen slicing pulls them in alongside tree-referenced components.
  for (const m of screenSpec.modals || []) {
    if (m.componentName) refs.add(m.componentName);
  }
  return refs;
}

function slice(kind) {
  const { meta, tokens, typography, icons, components } = validateContract();
  mkdirSync(SLICES, { recursive: true });
  const kindDir = join(SLICES, kind);
  // Only wipe the kind dir when emitting a full slice (no per-screen/order filter).
  // For screen-by-screen flow we preserve previously-written slices so dedup
  // can be detected via filesystem presence.
  const isFiltered = (kind === 'components' && FOR_SCREEN) || (kind === 'screens' && ORDER);
  if (!isFiltered && existsSync(kindDir)) rmSync(kindDir, { recursive: true });

  if (kind === 'components') {
    mkdirSync(join(SLICES, 'components'), { recursive: true });
    let targetNames = Object.keys(components);
    if (FOR_SCREEN) {
      // Resolve screen file → collect referenced component names via enriched tree walk.
      const screensDir = join(CONTRACT, 'screens');
      const screenFile = join(screensDir, `${FOR_SCREEN}.yml`);
      if (!existsSync(screenFile)) fail(`--for-screen: screens/${FOR_SCREEN}.yml not found`);
      const screenSpec = loadYaml(screenFile);
      const refs = collectComponentNamesForScreen(screenSpec, components);
      targetNames = [...refs].filter((n) => components[n]);
      const unresolved = [...refs].filter((n) => !components[n]);
      if (unresolved.length) {
        log(`--for-screen ${FOR_SCREEN}: unresolved refs (skipped): ${unresolved.join(', ')}`);
      }
      log(`--for-screen ${FOR_SCREEN}: ${targetNames.length} components referenced`);
    }
    for (const name of targetNames) {
      const spec = components[name];
      const tokenRefs = new Set();
      const typeRefs = new Set();
      const iconRefs = new Set();
      for (const v of spec.variants) {
        for (const ref of Object.values(v.colors || {})) tokenRefs.add(ref);
        for (const t of v.typography || []) typeRefs.add(t.textStyle);
        for (const icon of v.icons || []) iconRefs.add(icon.iconName);
      }
      const sliceData = {
        meta,
        component: spec,
        tokens: { map: Object.fromEntries([...tokenRefs].map((k) => [k, tokens.map[k]])) },
        typography: { styles: Object.fromEntries([...typeRefs].map((k) => [k, typography.styles[k]])) },
        icons: { ...icons, icons: icons.icons.filter((i) => iconRefs.has(i.name)) },
        agent_prompt: componentAgentPrompt(spec, meta),
      };
      writeFileSync(join(SLICES, 'components', `${name}.json`), JSON.stringify(sliceData, null, 2));
    }
    log(`wrote ${targetNames.length} component slices → .build-slices/components/${FOR_SCREEN ? ` (for screen: ${FOR_SCREEN})` : ''}`);
  } else if (kind === 'screens') {
    mkdirSync(join(SLICES, 'screens'), { recursive: true });
    const screensDir = join(CONTRACT, 'screens');
    // Build a mainComponentKey → component name index once.
    const nameByKey = {};
    for (const spec of Object.values(components)) {
      if (spec.mainComponentKey) nameByKey[spec.mainComponentKey] = spec.name;
      // Also index via variants' observed instances if a component records a
      // top-level mainComponentKey per variant. Best-effort.
      for (const v of spec.variants || []) {
        if (v.mainComponentKey) nameByKey[v.mainComponentKey] = spec.name;
      }
    }
    let screenFiles = readdirSync(screensDir).filter((f) => f.endsWith('.yml'));
    if (ORDER) {
      // Filter + order per user-supplied list. Screens not in ORDER are skipped.
      const byName = new Map(screenFiles.map((f) => [basename(f, '.yml'), f]));
      const ordered = [];
      for (const name of ORDER) {
        if (byName.has(name)) ordered.push(byName.get(name));
        else log(`--order: screen "${name}" not found (skipped)`);
      }
      screenFiles = ordered;
    }
    for (const file of screenFiles) {
      const spec = loadYaml(join(screensDir, file));
      const componentRefs = new Set();
      const walk = (nodes) => {
        for (const n of nodes) {
          // Legacy: kind=component → componentName string
          if (n.kind === 'component' && n.componentName) componentRefs.add(n.componentName);
          // Screens-first: kind=instance → resolve via mainComponentKey
          if (n.kind === 'instance' && n.mainComponentKey && nameByKey[n.mainComponentKey]) {
            componentRefs.add(nameByKey[n.mainComponentKey]);
          }
          if (n.children) walk(n.children);
        }
      };
      walk(spec.tree);
      for (const m of spec.modals || []) {
        if (m.componentName) componentRefs.add(m.componentName);
      }
      const sliceData = {
        meta,
        screen: spec,
        componentImports: [...componentRefs].map((n) => ({
          name: n,
          importPath: `src/components/${n}/${n}`,
          classification: components[n].classification,
        })),
        agent_prompt: screenAgentPrompt(spec, meta, [...componentRefs], components),
      };
      writeFileSync(join(SLICES, 'screens', `${basename(file, '.yml')}.json`), JSON.stringify(sliceData, null, 2));
    }
    log(`wrote screens → .build-slices/screens/`);
  } else {
    fail(`unknown slice kind "${kind}"`);
  }
}

function componentAgentPrompt(spec, meta) {
  const lib = spec.classification.kind === 'library-wrapped' ? ` WRAPPING ${spec.classification.libraryComponent} from ${spec.classification.importPath}` : '';
  const assets = (meta.assets || []).map((a) => `  - ${a.kind} "${a.name}": ${a.path}`).join('\n') || '  (none)';
  const mainFile = meta.framework === 'react'
    ? `${spec.name}.tsx + ${spec.name}.module.scss`
    : `${spec.name}.component.ts + ${spec.name}.component.scss`;
  return [
    `Build component "${spec.name}"${lib}.`,
    `Framework: ${meta.framework}. Styling: ${meta.styling}.`,
    `Target dir: src/components/${spec.name}/`,
    ``,
    `Project assets available (import from correct relative path):`,
    assets,
    ``,
    `Rules (enforced by validate scripts):`,
    `- R7 every CSS property correct on first pass from spec — no approximation`,
    `- R8 render each variant using its OWN referenceCode + colors — no diff math`,
    `- R9 library-wrapped: import wrapper, no custom build`,
    `- R12 icons: font-size = visibleSizePx*2, line-height: 1 (webfont only)`,
    `- R13 never proxy missing icon — fail loudly`,
    `- R15 every color = var(--cssVar) — NO raw hex (rgba() for alpha gradients allowed)`,
    `- R19 FIXED→exact px, FILL→width:100% or flex:1, HUG→no fixed dim`,
    ``,
    `Code conventions (hard):`,
    `- NAMED EXPORTS ONLY. \`export function ${spec.name}(...)\` — no default exports anywhere.`,
    `- index.ts re-exports: \`export { ${spec.name} } from './${spec.name}';\` (no default re-export)`,
    `- Root element MUST set \`data-component="${spec.name}"\` for L1 validation.`,
    `- NO stories file. NO storybook imports.`,
    `- IMAGE FRAMES (R29): for every imageFrames[] entry, render as <img> inside a fixed container. Container: width/height from container.widthPx/heightPx; position: relative; overflow: hidden. Image: position: absolute; width: <imageWidthPct>%; height: <imageHeightPct>%; left: <imageLeftPct>%; top: <imageTopPct>%; max-width: none. Do NOT collapse to object-fit: contain — percentages define the crop.`,
    ``,
    `Output files (only these — nothing else):`,
    `- ${mainFile}`,
    `- index.ts`,
    ``,
    `Self-check before returning: every variant.colors slot resolves to a CSS var; every variant.icons[].visibleSizePx applied; every FIXED dimension set; no raw hex; root has data-component attribute; index.ts uses named re-export.`,
    ``,
    `Spec:`,
    JSON.stringify(spec, null, 2),
  ].join('\n');
}

function screenAgentPrompt(spec, meta, componentRefs, components) {
  const libComps = componentRefs
    .filter((n) => components[n].classification.kind === 'library-wrapped')
    .map((n) => `${n} (MUST use — wrapper for ${components[n].classification.libraryComponent})`);
  const assets = (meta.assets || []).map((a) => `  - ${a.kind} "${a.name}": ${a.path}`).join('\n') || '  (none)';
  const pageName = spec.name;
  const pageComponent = pageName.charAt(0).toUpperCase() + pageName.slice(1);
  const mainFile = meta.framework === 'react'
    ? `${pageComponent}.tsx + ${pageComponent}.module.scss`
    : `${pageComponent}.component.ts + ${pageComponent}.component.scss`;
  return [
    `Build screen "${pageName}" at route ${spec.route}.`,
    `Framework: ${meta.framework}. Styling: ${meta.styling}.`,
    `Target dir: src/pages/${pageName}/`,
    ``,
    `Project assets:`,
    assets,
    ``,
    `Components (already built, named exports):`,
    componentRefs.map((n) => `  - import { ${n} } from '../../components/${n}';`).join('\n'),
    ``,
    (spec.modals && spec.modals.length)
      ? `Modals (overlay components — render conditionally via local state keyed by modal name):\n${spec.modals.map((m) => `  - ${m.componentName}${m.variantName ? ` variant="${m.variantName}"` : ''} — sourceOverlay=${m.sourceOverlaySlug}${m.openTrigger ? ` openTrigger="${m.openTrigger}"` : ''}`).join('\n')}\n  → Use React state \`const [activeModal, setActiveModal] = useState<string | null>(null)\` and render \`{activeModal === '<name>' && <Component ... onClose={() => setActiveModal(null)} />}\`. Open triggers dispatch setActiveModal from the appropriate element. Default all modals closed.`
      : '',
    ``,
    `Rules:`,
    `- R3 mockData VERBATIM — write to ${pageComponent}.mock.ts, use as-is. Empty mockData → STOP + report error`,
    `- R14 use library wrappers when available. No raw HTML equivalents`,
    `- R15 no raw hex in output`,
    `- R19 inner FIXED components use Figma intrinsic px (unchanged)`,
    `- R31 viewportFit="${spec.viewportFit || 'fill'}": ${(spec.viewportFit || 'fill') === 'fill' ? 'root .root { width: 100vw; height: 100vh; display: flex } — Figma root dims are design reference only. Cover/sidebar with vertical FILL → height:100%. FIXED horizontal primaries (e.g. 856px cover) → width:Npx + flex-shrink:0.' : (spec.viewportFit === 'fixed-design' ? `root locked to spec.dimensions (${spec.dimensions.width}×${spec.dimensions.height}px). Every nested dim is raw px.` : `transform-scaled design: stage wrapper with aspect-ratio ${spec.dimensions.width}/${spec.dimensions.height}, root width/height from spec, transform: scale(calc(100vw / ${spec.dimensions.width}px)), transform-origin: top left.`)}`,
    ``,
    libComps.length ? `Library-wrapped components (must import + use):\n${libComps.map((s) => `- ${s}`).join('\n')}` : '',
    ``,
    `Code conventions (hard):`,
    `- NAMED EXPORT ONLY: \`export function ${pageComponent}()\`. No default export.`,
    `- Root element sets \`data-screen="${pageName}"\` for L1 validation.`,
    `- Do NOT touch src/main.tsx or any other route file — routes are scaffolded.`,
    ``,
    `Walk screen.tree (enriched, R1/R32). Dispatch per kind:`,
    `  - frame/group/rectangle/ellipse → <div> with captured layoutSizing/dimensions/spacing/direction/alignItems/justifyContent/colorToken/radius/border. Recurse children.`,
    `  - text → <h1|h2|p|span class={style}>{content}</…> with color: var(--<colorToken>), text-align from text.textAlign. Bind from mock when content matches a mockData key.`,
    `  - instance → <ComponentName variant={variantName} /> (resolve ComponentName from mainComponentKey via componentImports). Apply node dimensions/layoutSizing as overrides only when they differ from variant defaults (R32).`,
    `  - vector with icon → icon component sized visibleSizePx, colored colorToken (R12/R13).`,
    `  - any node with imageFrame → R29 percentage crop: container position:relative overflow:hidden at container.widthPx/heightPx; <img> absolute width/height/left/top from percentages. Never object-fit:contain.`,
    `Legacy: kind=component is equivalent to instance, kind=container equivalent to frame.`,
    `For data-bound components with dataDrivenStyles, map the data value → variantName.`,
    ``,
    `Output files (only these):`,
    `- ${mainFile}`,
    `- ${pageComponent}.mock.ts`,
    ``,
    `Spec:`,
    JSON.stringify(spec, null, 2),
  ].join('\n');
}

function validateIndex() {
  const indexPath = join(CONTRACT_ROOT, 'index.yml');
  if (!existsSync(indexPath)) fail(`index.yml missing at ${indexPath}`);
  const validator = ajv.compile(loadSchema('index.schema.json'));
  const idx = loadYaml(indexPath);
  if (!validator(idx)) fail(`index.yml: ${ajv.errorsText(validator.errors)}`);
  const totalScreens = idx.pages.reduce((a, p) => a + p.screenCount, 0);
  const audited = idx.pages.filter((p) => p.audited).map((p) => p.slug);
  log(`index valid. pages:${idx.pages.length} screens:${totalScreens} audited:[${audited.join(',') || 'none'}]`);
}

if (cmd === '--validate-index') validateIndex();
else if (cmd === '--validate') validateContract();
else if (cmd === '--slice') slice(argv[1]);
else fail('usage: prepare-build.mjs --validate-index | --validate [--page <slug>] | --slice components [--page <slug>] [--for-screen <name>] | --slice screens [--page <slug>] [--order <n1,n2,...>]');
