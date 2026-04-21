# React Project — Best Practices

<!-- version: 1.0 -->
<!-- Authoritative reference for any tool or agent that scaffolds or modifies React projects in this organization. Testing and security automation lives in TESTING-AND-SECURITY.md. -->

## Philosophy

- One stack, one structure, one set of conventions across every project. Consistency over preference.
- Conventions are enforced by tooling, not by review.
- The design contract is the source of truth for tokens. The contract drives the code, not the other way around.
- Boundaries are explicit and machine-checked. Cross-feature imports are disallowed.

---

## 1. Stack

| Layer | Choice |
|-------|--------|
| Bundler | Vite |
| Framework | React (function components only) |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS (see §4) |
| Linting | ESLint with `eslint-plugin-boundaries`, `react-hooks`, `jsx-a11y`, security plugins |
| Formatting | `ts-standard` |
| Pre-commit | Husky |
| Commit format | Conventional Commits via Commitlint |
| Routing | React Router |
| API client | Generated from OpenAPI spec via `openapi-generator-cli` (see §7) |
| React Compiler | **Disabled** — perf reasons |

Testing and security tooling: see `TESTING-AND-SECURITY.md`.

---

## 2. Naming conventions

| Case | Used for |
|------|----------|
| `kebab-case` | folder names, file names, CSS class names |
| `PascalCase` | component identifiers, types, interfaces, enums |
| `camelCase` | props, hooks, variables, functions |
| `SCREAMING_SNAKE_CASE` | environment variables, enum values |

Rules:
- File name mirrors the case rule. `desktop-cta.tsx` exports `DesktopCTA`.
- Hooks always start with `use`. `useFetchData`, `useUserProfile`.
- Boolean props start with `is`, `has`, `should`, or `can`.
- Event handler props start with `on`. Implementations start with `handle`.
- Env vars are prefixed with `VITE_` to be exposed to the client (Vite convention).

---

## 3. Project structure (feature-first)

```
src/
├── app/                  # Application shell
│   ├── routes/           # Route definitions
│   ├── app.tsx           # Root component
│   └── app-provider/     # Global providers (Theme, Query, i18n, Router)
├── assets/               # Global assets (images, fonts)
├── components/           # ONLY truly cross-feature shared UI
├── config/               # Global config and env access
├── features/             # Vertical feature slices
│   └── <feature>/
│       ├── api/          # API requests and query hooks
│       ├── assets/       # Feature-specific assets
│       ├── components/   # Feature-scoped components
│       ├── hooks/        # Feature-scoped hooks
│       ├── stores/       # Feature-scoped state
│       ├── types/        # Feature-scoped types
│       └── utils/        # Feature-scoped utilities
├── hooks/                # ONLY cross-feature shared hooks
├── lib/                  # Preconfigured external libraries (axios, query client)
├── stores/               # Global state only
├── styles/               # Sass 7-1 (see §4)
├── test/                 # Shared test utilities and mocks
├── types/                # Cross-feature shared types
└── utils/                # Cross-feature shared utilities
```

Rules:
- A feature **never** imports from another feature.
- Code is promoted to `src/components|hooks|utils|types` only when 2+ features actually need it.
- Each feature exports a single public entry component (e.g. `FeaturePage`); internal components are private.
- Boundaries are enforced by `eslint-plugin-boundaries`. Violations fail the build.

---

## 4. Styling — Tailwind CSS

Tailwind CSS v4 with `@tailwindcss/vite` plugin.

```
src/
├── index.css              # @import "tailwindcss" + @theme block with design tokens
├── app.css                # App-level overrides, webfont imports
└── components/            # No per-component .scss — styles are Tailwind classes in JSX
```

Rules:
- All visual styles use Tailwind utility classes directly in JSX.
- Design tokens mapped via `@theme` in `index.css` as CSS custom properties.
- Use arbitrary values for contract values: `bg-[var(--color-surface-brand)]`, `gap-[32px]`, `rounded-[24px]`.
- `@apply` is allowed only when a utility combination repeats 3+ times across components.
- No separate `.scss` files per component.
- Custom utilities (e.g., webfont icon classes) defined in `index.css`.
- Dark mode via `dark:` variant when contract defines a dark theme.

### 4b. Legacy SCSS (opt-in for Angular-first teams)

When `styling_default: "scss"` in the contract, use the Sass 7-1 architecture:

```
src/styles/
├── abstracts/    # variables, mixins, functions (no CSS output)
├── vendors/      # third-party resets
├── base/         # reset, typography
├── layout/       # grid, header, footer
├── components/   # shared UI components
├── pages/        # page-specific styles
├── themes/       # light, dark
└── utils/        # helpers
```

Rules: single entry point `src/index.scss`, partials start with `_`, per-component `.scss` imports only from `abstracts/`, BEM class names, tokens in `abstracts/_variables.scss`.

---

## 5. Code quality

Quality is enforced at three points: edit time (lint), pre-commit (Husky), and CI (PR pipeline).

Required configuration:
- ESLint with `eslint-plugin-boundaries` configured to match the actual `src/` layout
- `ts-standard` for formatting
- Husky `pre-commit` hook: lint + format + typecheck on staged files
- Husky `commit-msg` hook: Commitlint with `@commitlint/config-conventional`
- TypeScript `strict: true` (no exceptions)

Rules:
- `git commit --no-verify` is forbidden.
- `eslint-disable-next-line` requires a justification comment on the same line.
- Boundaries violations fail the build. Do not silence them; fix the import.
- ESLint config and pre-commit hooks are owned by the tooling, not by individual contributors. Local overrides are not allowed.

Conventional Commits — required types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `style`. Format: `type(scope): subject`.

Full testing and security configuration lives in `TESTING-AND-SECURITY.md`.

---

## 6. Routing

- React Router v6+
- Single root shell route at `/` containing the `App` component, with feature pages as nested children
- The home page is declared as `index: true`
- `/403` and `/404` are explicit routes
- A wildcard `*` route catches everything else and routes to the 404 page
- Every feature page is **lazy-loaded** via dynamic import — no eager imports of feature code in the router
- The router file contains zero side effects (no fetches, no global state mutations)
- The router imports only the public entry component of each feature; private components remain inaccessible

---

## 7. API integration — OpenAPI Generator

- OpenAPI specification stored at `assets/openapi/openapi.yaml`
- Client generated into `src/generated/api/` using the `typescript-fetch` preset
- Generation runs in `prebuild` so the build always uses fresh types
- Vite alias `@generated` points to `src/generated`
- Boundaries config explicitly allows imports from `src/generated/`
- Generated files are **never** edited by hand
- Auth, base path, and headers are configured via the generated `Configuration` class — no custom wrappers
- Backend changes propagate as TypeScript compile errors during regeneration, providing immediate feedback

Optional: pair with TanStack Query (`@tanstack/react-query`) for caching, retries, and request deduplication. Wrap generated client methods inside `queryFn`.

---

## 8. Components

Rules:
- Function components only. Class components are forbidden.
- Named exports only. No default exports.
- Props interface defined in the same file as the component.
- One component per file.
- File name and component name match (kebab-case file → PascalCase component).
- No inline styles. Always use SCSS.
- No business logic in components — extract to hooks or utilities.
- No data fetching in components — use hooks (e.g. `useFetchUsers`, or React Query).
- Forward refs explicitly when needed; do not use `React.FC`.

### 8.1 Mock data — separate files per component

Components and pages that render sample data (tables, lists, cards, forms) MUST NOT hardcode data inline. Instead:

- Each component or page that needs sample data gets a `<name>.mock.ts` file in the same directory
- Mock files export typed arrays/objects matching the component's prop interfaces
- Page components import from the mock file: `import { sampleRows } from './elenco-pratiche-page.mock'`
- Mock files are clearly named and easy to find when swapping for real API data

**Structure:**
```
src/features/pratiche/components/
  elenco-pratiche-page.tsx           ← imports from mock
  elenco-pratiche-page.scss
  elenco-pratiche-page.mock.ts       ← sample PraticaRow[], persona data
```

**Rules:**
- One mock file per component/page that needs data
- Mock data uses exact values from Figma (persona names, dates, status labels, amounts) — not generic "Lorem ipsum"
- Types are shared: the mock file imports the component's prop types
- When the API client is generated, mock files are replaced by query hooks — the component import changes from `./page.mock` to `../api/useGetPratiche`
- Mock files are NOT deleted when API data is available — they remain as test fixtures

**Why:** Hardcoded data scattered across .tsx files makes it impossible to find and replace when connecting to real APIs. Centralized mock files provide a clear migration path.

---

## 9. State management

| Scope | Choice |
|-------|--------|
| Local component state | `useState` / `useReducer` |
| Cross-component within a feature | Feature-scoped store in `src/features/<feature>/stores/` |
| Truly global (auth, theme, user, locale) | Global store in `src/stores/` |
| Server state (API responses) | TanStack Query (paired with the generated API client) |

Rules:
- Default to local state. Promote to feature store only when 2+ components in the same feature need it.
- Promote to global store only when 2+ features need it.
- Never use a global store as a dumping ground.
- Server state and client state are different. Use TanStack Query for the former.

---

## 10. Design tokens (contract-driven)

Tokens are generated from the design contract, not hand-written.

**Tailwind (default for React):**
- Tokens go into the `@theme { }` block in `src/index.css`
- CSS custom properties: `--color-surface-primary`, `--color-text-brand`, `--spacing-md`, `--radius-lg`
- Usage in JSX: `bg-[var(--color-surface-brand)]`, `gap-[var(--spacing-md)]`
- The `index.css` file is checked in with a header comment indicating it is generated

**SCSS (Angular):**
- `src/styles/abstracts/_variables.scss` with SCSS variables + `:root {}` CSS custom properties
- Naming: `$color-gray-0`, `$spacing-md`, `$radius-lg`, `$font-size-6`
- Semantic tokens reference primitives: `$surface-primary: $color-gray-0`

Zero invented values. Every value from contract only. Regenerate from new contract version in the same PR.

### 10.1 Layout sizing — contract-driven, responsive by default

Layout sizing is captured in the contract (`layout_sizing: { horizontal, vertical }`) and the build agent reads it instead of guessing. See **`RULES.md` [R9]** for the complete translation table, default assumptions, forbidden patterns, examples, and the fallback procedure when `layout_sizing` is missing from a contract entry.

---

## 11. Complex component libraries

For widgets where building from scratch would take weeks and never match a battle-tested library — calendar pickers, data tables, autocomplete, multi-select, drag-drop trees, rich text editors, charts, virtual scroll lists, color pickers, etc. — use **one** library per project, declared at scaffold time.

**Recommended default:** PrimeReact (matches PrimeNG for cross-framework projects, comprehensive coverage, CSS variable theming).

**Alternatives:** Radix UI / shadcn/ui (headless, maximum design fidelity), Headless UI (Tailwind-friendly), Mantine, MUI, Chakra. Pick based on the project's design fidelity requirements and theming needs.

**Rules:**
- One library per project. **Never mix.**
- The library is used for complex widgets only. Simple widgets (button, input, label, checkbox, card, badge, alert, modal frame, tab, breadcrumb, accordion, simple dropdown) are built from scratch as project components.
- Library imports are restricted to `src/lib/<library>/`. Feature code imports the wrappers from `src/components/`, never from the library package directly.
- Every library component used by the app gets a thin **wrapper** in `src/components/<component>/` that exposes the project's own prop API. This decouples feature code from the library and makes future swaps possible without touching every page.
- Wrappers hide library-specific props (`pt`, `panelClassName`, `appendTo`, etc.) behind project-specific options.
- Library theming is applied via CSS variables overrides in `src/styles/themes/_<library>-theme.scss`, mapping the library's theme tokens to the project's design tokens (so `--primary-color` from the library resolves to `$color-brand-blue` from the contract).
- The library's default CSS reset and base styles are imported once in `src/styles/vendors/`.
- Library version is pinned in `package.json` with `~` (allow patch updates only). Major upgrades require an explicit migration ticket.
- Boundaries config has an explicit allow rule for `src/lib/<library>/` to prevent accidental imports.

**Forbidden:**
- Mixing two component libraries.
- Importing library components directly from feature code (always go through the wrapper).
- Using a library component without a wrapper.
- Modifying the library's source files.
- Using the library for simple widgets that are part of the project's own design system.

---

## 12. Icons

If the design system has custom icons:
- SVGs live in `src/icons/`, exported from Figma via the design-agent workflow
- Stroke-based SVGs are pre-processed to filled paths using `oslllo-svg-fixer` so they render in webfonts
- A webfont is generated into `src/font/` using `fantasticon` with the prefix and name defined in the design contract (`icons.css_prefix`, `icons.font_name`)
- Components reference icons via `<i className="{prefix}-{name}" />` — never as inline SVG or third-party icon library
- Phosphor, Lucide, Heroicons, and other icon libraries are forbidden in projects with a custom icon set

### 12.1 Webfont icon sizing

See **`RULES.md` [R6]**. `font-size` equals the desired visible size directly (no multiplier). Use `overflow: hidden` on containers smaller than `font-size`. Use `translateY` for optical alignment.

### 12.2 Icon library mode

When `icon_strategy.mode` is `"library"` in the contract:
- Install the chosen library: `phosphor-react`, `lucide-react`, or `@heroicons/react`
- Import icons as React components: `import { Clock } from 'phosphor-react'`
- No webfont generation, no `src/icons/`, no fantasticon
- Map Figma icon names to library equivalents during audit (stored in `icon_mapping`)
- Phosphor, Lucide, Heroicons are the recommended options

---

## 13. Accessibility

- All interactive elements use semantic HTML (`<button>`, `<a>`, `<input>`, etc.)
- All form controls have associated `<label>` elements
- All images have meaningful `alt` text or `alt=""` if decorative
- Keyboard navigation works for every interactive component (tab order, focus visible, escape to close, arrow keys where appropriate)
- Color contrast meets WCAG AA minimum (enforced by lint where possible, by axe in tests)
- ARIA attributes are used only when semantic HTML cannot express the role
- `eslint-plugin-jsx-a11y` is required and runs on every PR

Full a11y testing setup in `TESTING-AND-SECURITY.md`.

---

## 14. Forbidden

- Class components
- Default exports for components
- Inline styles in JSX
- Cross-feature imports
- Manual edits to generated code (`src/generated/`, `src/styles/abstracts/_variables.scss`, `src/font/`)
- Manual edits to files owned by autofix tools
- `git commit --no-verify`
- Skipping TypeScript strict mode
- Adding a global store entry without a documented reason
- Hardcoded colors, spacing, radius, or font sizes in component styles (always reference tokens)
- `React.FC` (use explicit prop interfaces)
- `any` type (use `unknown` or proper types)
