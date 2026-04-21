# Scaffold Agent

**Model:** Sonnet. **Input:** `meta.yml` + `tokens.yml` + `typography.yml` + `icons.yml`. **Output:** empty project at `meta.project.path` ready for component builds.

## Steps

### 1. Create project
```
npm create vite@latest <name> -- --template react-ts  (framework=react)
npx @angular/cli new <name> --style=scss --routing=true  (framework=angular)
```

### 2. Install deps
- React: `tailwindcss`, `@types/node`, framework-specific library if declared in `meta.library.name`
- Angular: selected library (e.g. PrimeNG)

### 3. Token file
Generate `src/styles/tokens.css` from `tokens.yml`:
```css
:root {
  --color-surface-brand: #003087;
  --color-text-primary: #1a1a1a;
  ...
}
[data-theme="dark"] { /* from tokens.map[].modes */ }
```

### 4. Typography file
Generate `src/styles/typography.css` classes from `typography.yml` — one utility class per style key.

### 5. Icons
- Copy SVG exports from audit → `src/assets/icons/svg/`
- Run `node scripts/normalize-icons.mjs --dir src/assets/icons/svg` → strips hardcoded fills → currentColor
- Run `node scripts/normalize-icons.mjs --dir src/assets/icons/svg --check` → FAIL if any hex remains (R23)
- If `icons.strategy=webfont`: run `fantasticon` with prefix + name from `meta.webfont`. Generate `src/styles/icons.scss` with `font-size = visible*2` helper mixin (R12).
- If `icons.strategy=svg`: keep files as-is, import per component.
- After dev server boots, run `node scripts/verify-glyphs.mjs --contract design-contract --url <dev-url>` → FAIL if any glyph mismatches Figma reference (catches wrong viewBox / wrong exports).

### 6. Base styles
`src/styles/base.css`: box-sizing reset, font-family from first typography style, body background from `--color-surface-background`.

### 7. Router scaffold + page stubs
For each screen in `screens/*.yml`:
- Write `src/pages/<name>/<Name>.tsx` as a stub: `export function <Name>() { return <div data-screen="<name>">stub</div>; }`
- Write `src/pages/<name>/<Name>.mock.ts` with the screen's `mockData` already populated (build-screen agent will consume).
- Register route in `src/main.tsx` (React) or `app.routes.ts` (Angular).

Stubs let dev server boot BEFORE build-screen agents run. Build-screen agents then overwrite the stub with the full page.

### 8. Library wrapper stubs (R9, R14)
For each `meta.library.components[]` declared library-wrapped:
- Create `src/components/<name>/<name>.tsx` that re-exports the library component with project styling hook.
- Do NOT build custom versions.

### 9. Dev server check
Start dev server. Verify it boots + serves `/`. R23 — if fails, diagnose + retry.

## Output check
- `src/styles/tokens.css` has one line per `tokens.map` entry
- `src/styles/typography.css` has one class per style
- Webfont loads (inspect devtools)
- Dev server serves all stub routes
