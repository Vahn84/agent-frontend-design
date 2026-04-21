# PrimeReact overrides

Library: `primereact` (v10+).

## Install
```
npm install primereact primeicons
```

Global CSS (`src/main.tsx`):
```ts
import 'primereact/resources/themes/lara-light-blue/theme.css';
import 'primereact/resources/primereact.min.css';
// For icons (only if using PrimeIcons):
import 'primeicons/primeicons.css';
```

To suppress default theme colors and drive everything from project tokens: import only `primereact.min.css` (structural styles) and skip the theme CSS entirely. Then apply all colors + dimensions via `pt`/`className` in each wrapper.

## Mandatory `pt` boilerplate (applies to every wrap)

Most fidelity bugs come from DEFAULT DOM elements inside library components bleeding through `unstyled`. Native inputs, icon slots, hidden labels, and default focus rings render on top of or next to your styled box.

**Always apply these baselines when wrapping:**

### Input-family (Checkbox / RadioButton / InputSwitch / TriStateCheckbox)

Native `<input>` renders with browser default and stacks on top of your styled box → "two squares" effect. Hide it:

```ts
pt.input: {
  style: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    margin: 0,
    width: '100%',
    height: '100%',
    cursor: 'pointer',  // keep clickable!
  }
}
```

Combined with `pt.root: { style: { position: 'relative' } }` to anchor the absolute input.

**Critical**: do NOT set `pointer-events: none`. Input must remain clickable (invisible but intercepts clicks). Setting it kills toggle interaction.

### Button / Chip / Tag (label + optional icon)

Default focus ring is PrimeReact's blue 2–3px outline. Suppress globally OR per-component:
```ts
pt.root: { className: yourClass }
// In yourClass SCSS:
&:focus-visible { outline: 2px solid var(--stroke-stroke-brand); outline-offset: 2px; box-shadow: none; }
```

### Dropdown / MultiSelect / AutoComplete (with caret)

Default caret icon uses PrimeIcons fonts. If you didn't import PrimeIcons, it renders as broken glyph. Either import primeicons OR replace:
```ts
pt.dropdownIcon: ({ children }) => <img src={yourChevronSvg} alt="" />
```

### DataTable (row hover defaults)

Library adds `:hover` background. Override:
```scss
:global(.p-datatable-row):hover,
:global(.p-datatable) :global(tr):hover { background: inherit; }
```
In the wrapped component's SCSS module, use `:global()` to reach PrimeReact's class names.

### Dialog / Sidebar / Overlay

Default mask opacity + z-index may conflict with project theme. Set via `pt.mask`:
```ts
pt.mask: { style: { background: 'rgba(0,0,0,0.4)', zIndex: 1000 } }
```

### Paginator (hidden ellipsis gets default size)

`pt.pageButton` receives context with `.active`. Ellipsis separator is a `<span>` with its own class — override via `pt.ellipsisMark` if present, OR use `template="PrevPageLink PageLinks NextPageLink"` which handles it natively.

---

**Wire-library agent MUST apply these defaults before emitting a wrap.** Skipping the boilerplate = native elements bleed through = L6 structural validation fails.

## Mandatory statefulness per component type

Every wrapped component must be functionally usable — not just visually matching. Minimum statefulness per archetype:

| Component type | Props | State |
|----------------|-------|-------|
| Toggle (Checkbox, Switch, Radio) | `checked?: boolean` + `onChange?: (v: boolean) => void` | Controlled when `checked` passed, uncontrolled `useState` otherwise |
| Input (text, textarea, date) | `value?: string` + `onChange?: (v: string) => void` | Same pattern |
| Select / Dropdown | `value?: T` + `options: T[]` + `onChange?: (v: T) => void` + optional `open` state | Controlled/uncontrolled hybrid |
| Button | `onClick?: () => void` | Stateless (caller owns) |
| Tabs / Accordion | `activeKey?: string` + `onChange?: (k: string) => void` | Controlled/uncontrolled |
| Paginator | `page?: number` + `onPageChange?: (p: number) => void` | Controlled/uncontrolled |

**Pattern** (works for any toggle-like wrapper):

```tsx
import { useState } from 'react';

export function MyToggle({ checked, onChange, variant = 'off' }: Props) {
  const initial = checked ?? variant === 'on';
  const [internal, setInternal] = useState(initial);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;

  const handleChange = (next: boolean) => {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  return <LibraryComponent checked={value} onChange={(e) => handleChange(!!e.checked)} unstyled pt={{...}} />;
}
```

Rules:
- If caller supplies `checked`/`value`, component is CONTROLLED — state lives with parent.
- If caller omits, component is UNCONTROLLED — internal state via `useState` initialized from `variant` prop (or defaults).
- `onChange` always fires so caller can observe transitions.
- Variant prop → purely visual fallback (e.g. initial value) when uncontrolled.

Wire-library agent MUST emit this pattern for any interactive component. Static-variant-only wrappers (no `onChange`) = fail because user can't interact.

## Override mechanism
Two primary routes:

1. **`pt` (PassThrough) prop** — target internal DOM slots:
   ```tsx
   <Button
     pt={{
       root: { className: styles.root, style: { ... } },
       label: { className: styles.label },
       icon: { className: styles.icon }
     }}
   />
   ```
   Use for granular structural restyling.

2. **CSS custom properties** — PrimeReact internals reference `--primary-color`, `--surface-*`, etc. Redefine in project tokens.css so the whole library uses project colors.

Prefer `pt` for high-fidelity components (DataTable, Paginator, Dialog); prefer global CSS vars for simple components (Button, InputText, Checkbox).

## Component catalog (common mappings)

| Figma role | PrimeReact | Module import | Override difficulty |
|------------|-----------|---------------|---------------------|
| Button / CTA | `Button` | `primereact/button` | Low |
| Text input | `InputText` | `primereact/inputtext` | Low |
| Textarea | `InputTextarea` | `primereact/inputtextarea` | Low |
| Checkbox | `Checkbox` | `primereact/checkbox` | Low |
| Radio | `RadioButton` | `primereact/radiobutton` | Low |
| Toggle / switch | `InputSwitch` | `primereact/inputswitch` | Medium |
| Slider | `Slider` | `primereact/slider` | Medium |
| Dropdown | `Dropdown` | `primereact/dropdown` | Medium |
| Multi-select | `MultiSelect` | `primereact/multiselect` | Medium |
| Date picker | `Calendar` | `primereact/calendar` | Medium |
| Data table | `DataTable` + `Column` | `primereact/datatable` | High |
| Paginator | `Paginator` | `primereact/paginator` | High |
| Dialog / modal | `Dialog` | `primereact/dialog` | Medium |
| Toast | `Toast` | `primereact/toast` | Low |
| Tooltip | `Tooltip` | `primereact/tooltip` | Low |
| Tab view | `TabView` + `TabPanel` | `primereact/tabview` | Medium |
| Accordion | `Accordion` + `AccordionTab` | `primereact/accordion` | Medium |
| Avatar | `Avatar` | `primereact/avatar` | Low |

## Override snippets

### Button (from our DesktopCta)
```tsx
import { Button } from 'primereact/button';
import styles from './DesktopCta.module.scss';

export function DesktopCta({ label, variant = 'primary', onClick }: Props) {
  return (
    <Button
      label={label}
      onClick={onClick}
      unstyled
      pt={{
        root: { className: [styles.root, styles[variant]].filter(Boolean).join(' ') },
        label: { className: `buttons-bold ${styles.label}` }
      }}
    />
  );
}
```
- `unstyled` strips default PrimeReact styling — lets your SCSS drive everything.
- SCSS applies Figma-exact width/height/border/background/etc (same as before wrapping).

### InputSwitch (from our OnOff)
```tsx
import { InputSwitch } from 'primereact/inputswitch';
import styles from './OnOff.module.scss';

export function OnOff({ variant, onChange }: Props) {
  return (
    <InputSwitch
      checked={variant === 'on'}
      onChange={(e) => onChange?.(e.value ? 'on' : 'off')}
      pt={{
        root: { className: styles.root },
        slider: { className: styles.slider }
      }}
    />
  );
}
```
```scss
.root { width: 48px; height: 24px; }
.slider {
  background: var(--surface-surface-secondary);
  border-radius: 44px;
  &::before { /* thumb */
    background: var(--surface-surface-primary);
    border-radius: 44px;
  }
}
.root[aria-checked="true"] .slider { background: var(--surface-surface-brand); }
```

### Checkbox
```tsx
import { Checkbox as PrimeCheckbox } from 'primereact/checkbox';

export function Checkbox({ variant, size = 20 }: Props) {
  const checked = variant.startsWith('checked');
  return (
    <PrimeCheckbox
      checked={checked}
      pt={{
        root: { className: styles.root, style: { width: size, height: size } },
        box: { className: [styles.box, styles[variantCamel]].filter(Boolean).join(' ') }
      }}
    />
  );
}
```
Apply border + bg + border-radius: 4px to the `box` slot to match Figma exactly.

### DataTable (for tables like ElencoPratiche)
```tsx
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';

export function AspiDataTable({ rows, columns }: Props) {
  return (
    <DataTable
      value={rows}
      pt={{
        thead: { className: styles.thead },       // brand-blue header pill
        tbody: { className: styles.tbody },
        row: { className: styles.row },
        bodyCell: { className: styles.cell }
      }}
    >
      {columns.map((c) => (
        <Column
          key={c.field}
          field={c.field}
          header={c.label}
          headerClassName={styles.headerCell}
          body={c.renderCell}   // for custom status chip cells, owner avatars, toggles
        />
      ))}
    </DataTable>
  );
}
```
- `body={c.renderCell}` lets you slot StatusChip, OnOff, Avatar into each cell.
- `thead` className drives the brand-blue pill background + rounded-200 border.
- Disable default hover colors in SCSS by overriding `:global(.p-datatable-row):hover { background: inherit; }`.

### Paginator
```tsx
import { Paginator as PrimePaginator } from 'primereact/paginator';

export function Paginator({ first, rows, totalRecords, onPageChange }: Props) {
  return (
    <PrimePaginator
      first={first}
      rows={rows}
      totalRecords={totalRecords}
      onPageChange={onPageChange}
      template="PrevPageLink PageLinks NextPageLink"
      pt={{
        root: { className: styles.root },
        pageButton: ({ context }: any) => ({
          className: context?.active ? styles.pageActive : styles.page
        }),
        prevPageButton: { className: styles.chevronButton },
        nextPageButton: { className: styles.chevronButton }
      }}
    />
  );
}
```
- `template` string controls which parts render. Drop parts you don't need.
- `pageButton` accepts a function that receives `context.active` — conditional class for active pill.
- Dots (ellipsis) rendered automatically when `pageLinkSize` is smaller than total.

## Fidelity traps

1. **Default theme leakage**: if you import theme.css, every library component inherits those colors. Either skip theme.css OR override every relevant CSS var in tokens.css.
2. **PrimeIcons**: don't import if your design uses custom icons. Adds 100KB + clutters the namespace.
3. **Default focus rings**: PrimeReact adds 2-3px blue outline on focus-visible. Override:
   ```scss
   :global(.p-button:focus-visible),
   :global(.p-inputswitch:focus-visible) {
     outline: 2px solid var(--stroke-stroke-brand);
     outline-offset: 2px;
     box-shadow: none;
   }
   ```
4. **DataTable cell padding** defaults to 1rem. Match Figma's 16px/24px with pt cell className.
5. **InputSwitch thumb size**: default is 16×16 with 4px offset. Figma may want different dims. Use inset-based thumb positioning in SCSS (not the library's default translate).
6. **Dialog mask opacity + z-index**: check `pt.mask` if you want a custom overlay.

## Validation hook
After wiring, `validate.mjs --full` should report the same or better fidelity. If fidelity drops > 2% → investigate: likely default theme bleeding through or a pt slot missed. Add the corresponding class override.
