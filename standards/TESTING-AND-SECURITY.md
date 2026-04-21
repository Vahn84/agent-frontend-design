# Testing & Security Automation

<!-- version: 1.0 -->
<!-- Authoritative reference for any tool or agent that scaffolds, modifies, or reviews React projects in this organization. -->

## Philosophy

- All PR-runnable checks run on PR.
- PR = only enforcement point. Pre-commit = fast feedback. Nightly = advisory.
- Autofix when possible; annotate inline when not; never block humans on auto-resolvable issues.
- Gates fail loud + early. No silent warnings.

---

## 1. PR pipeline — blocking checks

Every PR open and every push. Fail any = block merge.

| Check | Tool | Notes |
|-------|------|-------|
| Lint | ESLint + plugins (`react-hooks`, `jsx-a11y`, `boundaries`, `security`, `no-unsanitized`) | Autofixed where possible (see §4) |
| Format | `ts-standard` | Autofixed |
| Typecheck | `tsc --noEmit` | Strict mode required |
| Unit + component tests | Vitest + `@testing-library/react` + `user-event` | Coverage threshold enforced |
| Accessibility unit tests | `vitest-axe` | Runs axe-core on every component test |
| Visual regression | Chromatic (or Playwright snapshots as free fallback) | Every story, every variant, every PR |
| E2E smoke tests | Playwright | Critical paths only — full suite on merge to main |
| Bundle size budget | `size-limit` | Hard limits per chunk; fail on regression |
| Dependency audit | `npm audit --audit-level=high` | Fails on high + critical |
| Lockfile integrity | `lockfile-lint` | Verifies registry sources, prevents typo-squatting |
| Secret scan | `gitleaks` | Catches anything that slipped pre-commit |
| Commit messages | `commitlint` (`@commitlint/config-conventional`) | Enforced via PR checks for squash-merged PRs |

## 2. PR pipeline — non-blocking checks

Run on every PR; post annotations/suggestions, don't block merge.

| Check | Tool | What it produces |
|-------|------|------------------|
| AI code review | **CodeRabbit** (recommended) | Inline suggestions on changed lines; one-click apply |
| Static analysis | **SonarCloud** or **DeepSource** | Code smells, complexity, duplication; quality gate report |
| Security suggestions | Snyk Code (PR comments) | Inline security findings with autofix where safe |
| SAST | Semgrep | Pattern-based scan with PR annotations |
| License audit | `license-checker` | Flag any new non-allowed license |
| Performance budget | Lighthouse CI | Perf, a11y, best-practices, SEO scores |

## 3. On merge to main — blocks next deploy

Run after merge. Failure blocks next deploy, not merge itself.

- Full Playwright E2E suite (all browsers, all viewports)
- Full Lighthouse CI run with stricter thresholds
- Build artifact published with size report
- SBOM regenerated and uploaded

## 4. Autofix loop

Some checks self-correct. Fix committed back to PR branch automatically — no human needed.

| Tool | Fixes | Mechanism |
|------|-------|-----------|
| **autofix.ci** | Anything with a CLI fix mode (`eslint --fix`, `prettier --write`, etc.) | Runs in CI, pushes commit to PR branch |
| **pre-commit.ci** | All hooks configured in `.pre-commit-config.yaml` | Same mechanism, scoped to pre-commit hooks |
| **Trunk.io** | Hundreds of linters/formatters with managed autofix | Native Bitbucket integration, posts inline review comments |
| **Dependabot / Renovate** | Lockfile updates, security patches | Opens PRs automatically, can auto-merge patch versions |

**Default:** `autofix.ci` for greenfield (free, works on Bitbucket Pipelines, simple config). Upgrade to **Trunk.io** for centralized linter management.

**Forbidden:** manually editing files owned by an autofix tool. If output wrong, fix tool config, not output.

## 5. AI-powered code review

PRs get AI review comments alongside human reviewers. AI = **non-blocking** — suggests, never enforces.

**Recommended:** **CodeRabbit**. First-class Bitbucket support, contextual diff suggestions, one-click safe fixes, learns from team feedback.

**Alternative:** Snyk Code for security-only; SonarCloud for traditional static analysis.

**Rules:**
- AI suggestions = advisory. Humans still approve.
- Read AI fixes before applying. Treat like any code change.
- Same false positive flagged repeatedly → file config change to suppress.

## 6. Pre-commit (local, before push)

Runs on dev machine via Husky. Fast subset of PR pipeline on staged files only:

- Lint + format + typecheck on staged files only
- Secret scan (gitleaks)
- Commit message validation (commitlint)

Pre-commit duplicates PR pipeline by design: catch simple cases instantly.

**Forbidden:** `git commit --no-verify`. PR pipeline fails anyway, just slower.

## 7. Nightly / weekly — advisory only

Scheduled; opens issues or PRs, blocks nothing.

| Schedule | Job | Output |
|----------|-----|--------|
| Nightly | OSV-Scanner full scan | Issue with vulnerability list |
| Nightly | Semgrep full SAST scan | Issue with findings |
| Nightly | Snyk full scan | PR if autofix possible, else issue |
| Weekly | License audit | Issue if new license appears |
| Weekly | SBOM regeneration (`cyclonedx-npm` or `syft`) | Artifact uploaded for compliance |
| Weekly | Dependency update batch | PRs grouped by Renovate / Dependabot |

## 8. Test stack reference

| Layer | Tool | Notes |
|-------|------|-------|
| Unit / component | **Vitest** | Fast, ESM-native, Jest-compatible API |
| Component queries | **@testing-library/react** | User-centric queries only |
| Interactions | **@testing-library/user-event** | More realistic than `fireEvent` |
| API mocking | **MSW** | Same mocks for unit tests AND dev server |
| Accessibility (unit) | **vitest-axe** | Fail tests on a11y violations |
| Accessibility (E2E) | **@axe-core/playwright** | Run axe in real browser |
| Accessibility (lint) | **eslint-plugin-jsx-a11y** | Catch obvious issues at edit time |
| End-to-end | **Playwright** | Use Cypress only when existing project requires it |
| Visual regression | **Chromatic + Storybook** | Mandatory for design system projects |
| Performance | **Lighthouse CI** + **`web-vitals`** + **`size-limit`** | PR budget + RUM + bundle size |

**Skip:** Jest, Enzyme, Sinon, Selenium, BackstopJS, Loki.

## 9. Test pyramid (design-system-driven app)

```
       E2E (Playwright)         ~10%   critical user flows only
      ───────────────────
     Visual regression          ~30%   every component, every variant
      (Chromatic + Storybook)
   ───────────────────────
   Component / integration       ~30%  Vitest + RTL + axe + MSW
  ─────────────────────────
  Unit                           ~30%  pure functions, hooks, utils
```

Weight visual regression heavier than typical app. For design system, "looks correct" is the contract.

## 10. Quality gates

Enforced by PR pipeline. Lowering requires team consensus + justification in PR description.

| Metric | Threshold | Enforced by |
|--------|-----------|-------------|
| Line coverage | ≥ 80% on `src/features/**` and `src/components/**` | Vitest config |
| Branch coverage | ≥ 70% on the same paths | Vitest config |
| Main bundle size | Defined per project | `size-limit` |
| Lighthouse perf | ≥ 90 | Lighthouse CI |
| Lighthouse a11y | ≥ 95 | Lighthouse CI |
| Lighthouse best practices | ≥ 95 | Lighthouse CI |
| Sonar quality gate | "Passed" — no new bugs, code smells, or vulnerabilities above thresholds | SonarCloud |
| Visual regression | 0 unapproved baselines | Chromatic |

## 11. Required ESLint plugins

Every project enables at minimum:

- `eslint-plugin-react`
- `eslint-plugin-react-hooks`
- `eslint-plugin-jsx-a11y`
- `eslint-plugin-boundaries`
- `eslint-plugin-security`
- `eslint-plugin-no-unsanitized`
- `eslint-plugin-import` (for cycle detection)
- `eslint-plugin-unicorn` (selectively — modern best practices)

## 12. Forbidden

- `git commit --no-verify`
- `npm install --ignore-scripts` outside explicitly sandboxed contexts
- `npm install --audit=false`
- `eslint-disable-next-line` on rules from `eslint-plugin-security`, `no-unsanitized`, or `jsx-a11y` without dated TODO + exception ticket
- Disabling Chromatic baselines without explicit design approval
- Committing `.env` files with real credentials
- Manually editing files owned by an autofix tool
- Skipping secret scanner
- Suppressing Sonar quality-gate failures without team consensus