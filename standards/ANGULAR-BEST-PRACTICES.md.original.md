# Angular Project — Best Practices

<!-- version: 1.0 -->
<!-- Authoritative reference for any tool or agent that scaffolds or modifies Angular projects in this organization. Testing and security automation lives in TESTING-AND-SECURITY.md. Source: https://angular.dev/ai/develop-with-ai -->

## Philosophy

- One stack, one structure, one set of conventions across every project. Consistency over preference.
- Conventions are enforced by tooling, not by review.
- Standalone, signal-driven, OnPush by default. No NgModules.
- The design contract (when present) is the source of truth for tokens. The contract drives the code, not the other way around.
- Boundaries are explicit and machine-checked. Cross-feature imports are disallowed.

---

## 1. Stack

| Layer | Choice |
|-------|--------|
| Framework | Angular v20+ |
| Language | TypeScript (strict mode) |
| Bundler | Angular CLI default (esbuild) |
| Components | Standalone components only — never `NgModule` |
| Change detection | `OnPush` always |
| State | Signals + `computed()` for local; signal-based stores for shared |
| Templates | Inline for small components; relative path for external |
| Styling | Sass / SCSS (7-1 architecture, see §4) |
| Linting | ESLint with `@angular-eslint`, `boundaries`, security plugins |
| Formatting | Prettier or `ts-standard` (project-wide consistent choice) |
| Pre-commit | Husky |
| Commit format | Conventional Commits via Commitlint |
| Routing | Angular Router with lazy-loaded routes |
| HTTP | `HttpClient` via `inject()`; never constructor injection |
| Forms | Reactive forms only — never template-driven |
| Images | `NgOptimizedImage` for all static images |

Testing and security tooling: see `TESTING-AND-SECURITY.md`.

---

## 2. Naming conventions

| Case | Used for |
|------|----------|
| `kebab-case` | folder names, file names, CSS class names, route paths |
| `PascalCase` | component classes, directive classes, services, types, interfaces, enums |
| `camelCase` | properties, methods, signals, variables, function names |
| `SCREAMING_SNAKE_CASE` | environment constants, enum values |

Rules:
- File name mirrors the case rule. `user-profile.component.ts` defines `UserProfile` (Angular v20+ allows dropping the `Component` suffix in the class name; the file suffix remains).
- File suffixes are explicit and stable: `.component.ts`, `.directive.ts`, `.service.ts`, `.guard.ts`, `.pipe.ts`, `.resolver.ts`, `.routes.ts`.
- Signal variables are named like properties (`count`, `isLoading`), not `count$` (that's RxJS observable convention).
- Boolean signals start with `is`, `has`, `should`, or `can`.
- Output names start with the verb the parent reacts to (`save`, `delete`, `submit`) — never prefixed with `on`.

---

## 3. Project structure (feature-first)

```
src/
├── app/                       # Application shell
│   ├── app.ts                 # Root standalone component
│   ├── app.config.ts          # Application config (providers, router, http)
│   ├── app.routes.ts          # Top-level route definitions
│   └── app.html, app.scss     # Root template and styles
├── features/                  # Vertical feature slices
│   └── <feature>/
│       ├── api/               # HTTP services and signal-based queries
│       ├── components/        # Feature-scoped components
│       ├── directives/        # Feature-scoped directives
│       ├── guards/            # Feature-scoped route guards
│       ├── pipes/             # Feature-scoped pipes
│       ├── services/          # Feature-scoped services
│       ├── stores/            # Feature-scoped signal stores
│       ├── types/             # Feature-scoped types
│       ├── utils/             # Feature-scoped utilities
│       └── <feature>.routes.ts # Feature route definitions
├── core/                      # ONLY truly cross-feature shared services and providers
├── shared/                    # ONLY truly cross-feature shared components, pipes, directives
├── styles/                    # Sass 7-1 (see §4)
├── assets/                    # Global assets (images, fonts)
├── environments/              # Environment configs
└── test/                      # Shared test utilities and mocks
```

Rules:
- A feature **never** imports from another feature.
- Code is promoted to `shared/` or `core/` only when 2+ features actually need it.
- Each feature exports a single public entry component (e.g. `UsersPage`); internal components are private.
- Route definitions are colocated with the feature in `<feature>/<feature>.routes.ts`, not in `app.routes.ts`.
- Boundaries are enforced by `eslint-plugin-boundaries`. Violations fail the build.

---

## 4. Styling — Sass 7-1 architecture

```
src/styles/
├── abstracts/    # variables, mixins, functions, placeholders (no CSS output)
├── vendors/      # third-party resets / normalize
├── base/         # reset, typography, base element rules
├── layout/       # grid, header, footer, container
├── components/   # shared UI components
├── pages/        # page-specific styles
├── themes/       # light, dark variants
└── utils/        # helpers, spacing, visibility
```

Rules:
- Single entry point `src/styles.scss` imports layers in this exact order: `abstracts → vendors → base → layout → components → pages → themes → utils`.
- All partials start with `_` and are imported only via the entry point or higher-level files.
- Per-component `.scss` files import **only** from `abstracts/`. Never from another component or another layer.
- Component styles are scoped by Angular's view encapsulation by default. Do not disable view encapsulation.
- New design tokens (colors, spacing, radius, typography) go in `abstracts/_variables.scss` only.
- Class names in templates are `kebab-case`. BEM (`__element`, `--modifier`) is allowed inside components.
- **Never** use `[ngClass]` or `[ngStyle]`. Use `[class.<name>]="condition"` and `[style.<prop>]="value"` bindings.

---

## 5. Components

### Component definition

- **Standalone always.** Never use `NgModule`. (Standalone is the default in Angular v20+; do not set `standalone: true` explicitly.)
- **OnPush always.** Set `changeDetection: ChangeDetectionStrategy.OnPush` in every `@Component` decorator.
- Inline templates for small components (under ~30 lines of HTML). External templates/styles use relative paths.
- One component per file. File and class names match.
- Named exports only. No default exports.

### Inputs and outputs

- Use **`input()`** and **`output()`** functions, never `@Input` and `@Output` decorators.
- `input.required<T>()` for required inputs.
- `model()` for two-way bindings.

### Host bindings

- **Never** use `@HostBinding` or `@HostListener`.
- Use the `host` object inside `@Component` or `@Directive`:

```typescript
@Component({
  selector: 'app-button',
  host: {
    '[class.disabled]': 'isDisabled()',
    '(click)': 'handleClick()',
  },
  // ...
})
```

(Example structure only — actual code lives in the project, not this doc.)

### Templates

- **Use native control flow:** `@if`, `@for`, `@switch`. **Never** use `*ngIf`, `*ngFor`, `*ngSwitch`.
- Use the `async` pipe for observables in templates.
- Use `track` expressions in `@for` blocks (they are required).
- Use `NgOptimizedImage` for all static images. It is incompatible with inline base64 — use file paths.
- No business logic in templates. Extract to component class methods or `computed()` signals.
- No global object access in templates (`new Date()`, `Math.random()`, etc.) — pre-compute in the class.

---

## 6. State management

### Signals

- Local component state: `signal<T>()` for writable state, `computed<T>()` for derived state.
- **Never** use `signal.mutate()`. Use `signal.update(fn)` or `signal.set(value)`.
- Keep state transformations pure and predictable — no side effects inside `computed()` or `update()`.
- Prefer signals over RxJS for component state. Use RxJS only when you need streams (debouncing, combining HTTP calls, etc.).

### Shared state

| Scope | Choice |
|-------|--------|
| Local component state | `signal()` / `computed()` |
| Cross-component within a feature | Feature-scoped service in `src/features/<feature>/services/` exposing signals |
| Truly global (auth, theme, user, locale) | Global service in `src/core/` exposing signals |
| Server state (HTTP responses) | Service that wraps `HttpClient` and exposes signals; pair with `resource()` API where appropriate |

Rules:
- Default to local state. Promote to a feature service only when 2+ components in the same feature need it.
- Promote to `core/` only when 2+ features need it.
- Never use a global service as a dumping ground.
- A service has a single responsibility.

---

## 7. Dependency injection

- **Always use `inject()`** instead of constructor injection.
- `providedIn: 'root'` for singletons that should be available app-wide.
- `providedIn: 'platform'` only for cross-app singletons (rare).
- Feature-scoped services are provided in the feature's route configuration via `providers` so they tree-shake correctly.
- Never use `@Injectable()` without `providedIn`.

---

## 8. Routing

- Use Angular Router with **lazy-loaded routes** for every feature: `loadChildren: () => import('...')` or `loadComponent`.
- Top-level routes live in `src/app/app.routes.ts` and only reference feature route files via lazy loading.
- Feature route files (`src/features/<feature>/<feature>.routes.ts`) own the feature's internal routing.
- Define route guards as functional guards (the function-based API), not class-based.
- Always declare a `**` wildcard route that maps to a `NotFound` component.
- Always declare an explicit `403` (Forbidden) route.
- Use `withComponentInputBinding()` so route params bind directly to component inputs.

---

## 9. Forms

- **Reactive forms only.** Never use template-driven forms (`ngModel`).
- Build forms with `FormBuilder` injected via `inject(FormBuilder)`.
- Use typed forms (`FormGroup<T>`, `FormControl<T>`) — never untyped.
- Validation runs in the form definition, not in the component logic.
- Custom validators are pure functions in `src/features/<feature>/utils/` or `src/shared/`.

---

## 10. HTTP and API integration

- Use `HttpClient` injected via `inject(HttpClient)`.
- HTTP services live in `src/features/<feature>/api/` or `src/core/api/` for shared.
- Wrap HTTP responses in services that expose signals or observables — components never call `HttpClient` directly.
- Use `resource()` API for declarative data fetching tied to signals.
- For OpenAPI-driven projects: generated client lives at `src/generated/api/`, regenerated via `npm run api:generate` in `prebuild`. Never edit generated files by hand.
- Boundaries config explicitly allows imports from `src/generated/`.

---

## 11. Performance

- `OnPush` change detection on every component (already covered in §5).
- `@for` blocks always include a `track` expression.
- Lazy load every feature.
- Use `defer` blocks for content below the fold.
- `NgOptimizedImage` for all static images.
- Avoid `*ngFor` over large lists without virtual scrolling — use `@angular/cdk/scrolling` `cdk-virtual-scroll-viewport`.
- Avoid heavy computation in templates — pre-compute in `computed()` signals.

---

## 12. TypeScript

- **`strict: true`** in `tsconfig.json` (no exceptions).
- Prefer type inference where the type is obvious.
- **Never** use `any`. Use `unknown` for genuinely uncertain values, then narrow.
- Type every public API explicitly (component inputs/outputs, service methods, signals).
- Prefer `interface` for object shapes; `type` for unions and intersections.

---

## 13. Code quality

Quality is enforced at three points: edit time (lint), pre-commit (Husky), and CI (PR pipeline).

Required configuration:
- ESLint with `@angular-eslint`, `@angular-eslint/template`, `eslint-plugin-boundaries`, security plugins
- Formatter (`ts-standard` or Prettier — pick one per project)
- Husky `pre-commit` hook: lint + format + typecheck on staged files
- Husky `commit-msg` hook: Commitlint with `@commitlint/config-conventional`
- TypeScript `strict: true`

Rules:
- `git commit --no-verify` is forbidden.
- `eslint-disable-next-line` requires a justification comment on the same line.
- Boundaries violations fail the build. Do not silence them; fix the import.
- ESLint config and pre-commit hooks are owned by tooling, not by individual contributors. Local overrides are not allowed.

Conventional Commits — required types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `style`. Format: `type(scope): subject`.

Full testing and security configuration lives in `TESTING-AND-SECURITY.md`.

---

## 14. Design tokens (contract-driven)

When the project consumes a design contract (`design-contract/` directory), tokens are generated, not hand-written.

Generation rules:
- `src/styles/abstracts/_variables.scss` is generated from `tokens.colors`, `tokens.spacing`, `tokens.radius`, `tokens.typography` in the contract
- The same values are mirrored as CSS custom properties in `:root` for runtime theming
- Naming follows the contract structure: `$color-gray-0`, `$spacing-md`, `$radius-lg`, `$font-size-6`
- Semantic tokens reference primitives, in both SCSS and CSS custom properties
- The generated file is checked into the repo with a header comment indicating it is generated; manual edits are forbidden
- Regenerating from a new contract version produces a deterministic file (no diff churn)

For projects scaffolded with `/create-app` (no contract), `_variables.scss` ships with placeholder tokens that the team replaces over time.

---

## 15. Complex component libraries

For widgets where building from scratch would take weeks and never match a battle-tested library — calendar pickers, data tables, autocomplete, multi-select, drag-drop trees, rich text editors, charts, virtual scroll lists, color pickers, etc. — use **one** library per project, declared at scaffold time.

**Recommended default:** PrimeNG (matches PrimeReact for cross-framework projects, comprehensive coverage, CSS variable theming, idiomatic Angular APIs).

**Alternatives:** Angular Material (MD3-styled, native Angular fit), NG-ZORRO (Ant Design), Angular CDK + custom (headless primitives, maximum design fidelity). Pick based on the project's design fidelity requirements.

**Rules:**
- One library per project. **Never mix.**
- The library is used for complex widgets only. Simple widgets (button, input, label, checkbox, card, badge, alert, modal frame, tab, breadcrumb, accordion, simple dropdown) are built from scratch as project components.
- Library imports are restricted to `src/lib/<library>/`. Feature code imports the wrappers from `src/shared/components/`, never from the library package directly.
- Every library component used by the app gets a thin **wrapper** standalone component in `src/shared/components/<component>/` that exposes the project's own input/output API. This decouples feature code from the library and makes future swaps possible without touching every page.
- Wrappers hide library-specific options (`pTemplate`, `pt`, `appendTo`, etc.) behind project-specific inputs.
- Library theming is applied via CSS variables overrides in `src/styles/themes/_<library>-theme.scss`, mapping the library's theme tokens to the project's design tokens.
- The library's default CSS reset and base styles are imported once in `src/styles/vendors/`.
- Library version is pinned in `package.json` with `~` (allow patch updates only). Major upgrades require an explicit migration ticket.
- If the library ships its own NgModules (PrimeNG components are standalone in v17+ — use the standalone API), import them only inside the wrapper, never in feature components.
- Boundaries config has an explicit allow rule for `src/lib/<library>/` to prevent accidental imports.

**Forbidden:**
- Mixing two component libraries.
- Importing library components directly from feature code (always go through the wrapper).
- Using a library component without a wrapper.
- Modifying the library's source files.
- Using the library for simple widgets that are part of the project's own design system.

---

## 16. Icons

If the project uses a custom icon set (typically loaded from a design system):
- SVGs live in `src/assets/icons/`
- Stroke-based SVGs are pre-processed to filled paths using `oslllo-svg-fixer` so they render in webfonts
- A webfont is generated using `fantasticon` with the prefix and name defined in the design contract (when available)
- Components reference icons via `<i class="{prefix}-{name}"></i>` — never as inline SVG or third-party icon library
- Phosphor, Lucide, Heroicons, Font Awesome, and other generic icon libraries are forbidden in projects with a custom icon set
- For projects without a custom set: choose one library and stick with it; do not mix

---

## 17. Accessibility

- Must pass all axe-core checks (enforced by tests — see `TESTING-AND-SECURITY.md`).
- Must meet WCAG AA minimum standards including focus management, color contrast, and ARIA attributes.
- All interactive elements use semantic HTML (`<button>`, `<a>`, `<input>`, etc.).
- All form controls have associated `<label>` elements (or `aria-label`).
- All images have meaningful `alt` text or `alt=""` if decorative.
- Keyboard navigation works for every interactive component.
- Color contrast meets WCAG AA minimum.
- ARIA attributes are used only when semantic HTML cannot express the role.
- `@angular-eslint/template/no-positive-tabindex`, `@angular-eslint/template/click-events-have-key-events`, and related rules are enabled.

---

## 18. Forbidden

- `NgModule` (use standalone components)
- `*ngIf`, `*ngFor`, `*ngSwitch` (use `@if`, `@for`, `@switch`)
- `[ngClass]`, `[ngStyle]` (use `[class.*]`, `[style.*]` bindings)
- `@HostBinding`, `@HostListener` decorators (use `host` object)
- `@Input`, `@Output` decorators (use `input()`, `output()` functions)
- Constructor injection (use `inject()`)
- `signal.mutate()` (use `update()` or `set()`)
- Template-driven forms (`ngModel`) — use reactive forms
- `any` type (use `unknown` or proper types)
- Default exports for components or services
- Cross-feature imports
- Manual edits to generated code (`src/generated/`, `src/styles/abstracts/_variables.scss`, `src/assets/font/`)
- Manual edits to files owned by autofix tools
- `git commit --no-verify`
- Skipping TypeScript strict mode
- Disabling Angular view encapsulation
- Inline base64 images with `NgOptimizedImage`
- Heavy computation or `new Date()` in templates
- Mixing icon libraries
- Using a third-party icon library when the project has its own
- Hardcoded colors, spacing, radius, or font sizes in component SCSS (always reference tokens)
- Skipping `track` in `@for` blocks
