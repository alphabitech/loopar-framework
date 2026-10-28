# `src/document` — the client document system

Everything that turns a `Document` coming from the server into a screen.
Read it top-down, the way it mounts:

```
Workspace
  └─ <Entry kind>                 Entry.jsx — the door the server chose (Document.entry)
       └─ DocumentProvider        base/ — base: Document, controller, view options
            └─ Middleware         form/provider · list/provider · none — the kind's logic (useForm / useList)
                 └─ view          apps/**/client/<entity>-<kind>.jsx, optional; otherwise DefaultView
                      └─ Layout   form/layout · list/layout · page/layout — the chrome the view paints
```

## Folders

| Folder | What lives there | Public import |
|---|---|---|
| `Entry.jsx` | The chain above + the entry registry (`entries`: chunks, middleware, layout and what differs per kind). Each kind's UI is a lazy chunk resolved by `loadEntry(kind)` before the first render (awaited in `AppSourceLoader`, server and client), so `<Entry>` stays synchronous for SSR | — (used by `loader.jsx`) |
| `base/` | Base layer: `DocumentProvider`, `useDocument`, view options, `Layout` (generic), `DefaultView`, extension hooks | `@loopar/document` |
| `form/` | Form kind: `FormProvider`, `useForm`, `useFormEvents`, `FormLayout`, `ReportLayout`, `BareLayout` | `@loopar/form` |
| `list/` | List kind: `ListProvider`, `useList`, `ListLayout` | `@loopar/list` |
| `page/` | Page kind: `PageLayout`, `WebLayout` (no logic layer) | `@loopar/page` |
| `print/` | Print kind: `PrintLayout`, `PrintHeader`, `PrintStructure`, `formatPrintValue` (automatic print format + paper sheet) | `@loopar/print` |
| `controller/` | `DocumentController`, `FormController` (plain classes), field store, view-options vocabulary, `useController` | internal |
| `chrome/` | Desk UI pieces used by layouts: `DeskUI`, `AppBar` (one row: ← · Entity (big) record (small) · save state · `Toolbar`; phones: record in bold under a small entity), `Toolbar` (record ⇄ print toggle icon right before the primary button, same spot on both pages; framework buttons — Go to, view toggle — on wide screens, in "⋯" on phones; the view's `actions` always in "⋯", in order; Save/New the only filled button) | internal |

Kinds (`Document.entry`): `form` `view` `report` `installer` `auth` `print` → form middleware ·
`list` → list middleware · `page` `desk-page` `dashboard` `web` `controller` → base only.
The server picks the kind in the controller (`entry = "list"`); the view file
suffix (`-form`, `-list`, `-view`...) is only a file name.

## Writing a view

A view is a function with no props. It takes what it needs from its kind and
paints its layout with options:

```jsx
import { useDocument } from "@loopar/document";
import { useForm, useFormEvents, FormLayout } from "@loopar/form";

export const config = { hasHistory: false };            // static flags of the entry

export default function AppForm() {
  const { Document } = useDocument();
  const { getValue, setValue } = useForm();

  useFormEvents({ afterSave: (r) => loopar.notify(`Saved ${r.name}`) });

  return (
    <FormLayout
      slots={{ totals: () => <LiveTotals /> }}            // components rendered inside the structure
      actions={{ bump: <BumpVersionButton /> }}         // AppBar buttons
      sidebar={<Notes />}
    >
      {/* extra content below the structure */}
    </FormLayout>
  );
}
```

Only flags? `export const config = {...}; export { DefaultView as default } from "@loopar/document";`
No file at all? The entry renders `DefaultView` = its layout with defaults.

| I want to… | Where |
|---|---|
| Fixed flags (`canUpdate`, `hasSidebar`, `hasHistory`, `notRequireChanges`, `mapDocument`) | `export const config` |
| Order of AppBar buttons | the view's `actions` live in the "⋯" menu, in the order they're passed; give them an icon and a text label (menu rows) |
| Content in the structure (`slot`), AppBar buttons, sidebar, list columns/cards | layout props: `slots`, `actions`, `sidebar`, `columns`, `gridTemplate`, `primaryAction` |
| React to save / a field change / a JSON button (`data.action`) | `useFormEvents`, `useFieldEvent`, `useHandlers` |
| Read / write values, submit | `useForm()` → `getValue`, `setValue`, `setError`, `save`, `send` |
| Document, `inModal`, the controller itself | `useDocument()` |

Rules: framework API comes through hooks; your own data and callbacks go
through props of your own components. Views never receive props.

## Hooks reference

All hooks accept inline objects/functions (they keep a ref and subscribe by key), so
they can be called unconditionally at the top of a view.

### `@loopar/document` — every entry

| Hook | Returns / does |
|---|---|
| `useDocument()` | `{ ctrl, Document, name, entity, entityMenu, layout, inModal, onClose, onSaved, sidebarOpen, handleSetSidebarOpen }` |
| `useViewOptions()` | Merged view options (see vocabulary below) |
| `useActions({ name: <Node> })` | AppBar buttons while mounted |
| `useHandlers({ name: (ctrl) => … })` | Targets for JSON buttons (`data.action`) |
| `useDocumentConfig({ hasSidebar: false, … })` | Runtime patch of view flags |
| `useFieldEvent(field, event, (e, ctrl) => …)` | Subscribes to a rendered field (`change`, `changed`…) |
| `useFieldMeta(ctrl.fields, name)` | Live meta of one field (visibility, df) |

### `@loopar/form` — form, view, report, installer, auth

`useForm()` → `{ getValue, setValue, setError, getFormValues, getField, save, send,
validate, hasChanges, checkChanges, onFormEvent, ctrl, form }` (`form` = react-hook-form).

`useFormEvents({ … })` — the form lifecycle. Every `send()` (a `save()` or a custom
action from a handler) runs, in order:

```
validate()      built-in field validation (dataInterface per field)
                → `validate` listeners add errors      → dialog + field errors, stops
checkChanges()  unless notRequireChanges                → "No changes to save", stops
beforeSend      (values, ctrl, { action })  return false → stops
beforeSave      same, only from save()
── request ──
success:  form reset → options.success → afterSend → afterSave
error:    options.error → sendError → saveError → loopar.throw if nobody handled it
```

| Event | Signature | Return |
|---|---|---|
| `validate` | `(values, ctrl)` | `"msg"` · `{ field, message }` · array of them · nothing = ok |
| `beforeSend` / `beforeSave` | `(values, ctrl, { action })` | `false` cancels |
| `afterSend` / `afterSave` | `(response, ctrl, { action })` | — |
| `sendError` / `saveError` | `(error, ctrl, { action })` | — |

`values` is `ctrl.getFormValues()`, so a `config.overrides.getFormValues` shapes them too.
There is no `onSave`: the save itself is `save()` from `useForm()`; wrap it with
`before*/after*`, or replace it with `config.overrides.save` when it must change.

```jsx
useFormEvents({
  validate: ({ start, end }) => start > end && { field: "end", message: "End before start" },
  beforeSave: (values) => values.total > 0 || (loopar.notify("Empty order", "warning"), false),
  afterSave: (r) => navigate(`/desk/order/${r.name}/update`),
});
```

### `@loopar/list` — list

`useList()` → table API (`rows`, `selectedRows`, `search`, `setPage`, `deleteRow`, `viewType`,
`setViewType`…) + `ctrl`. Layout: `<ListLayout columns gridTemplate />`.

### Extending the controller

`config.overrides` assigns methods on the controller instance once (the functional
`extends`): `getFormValues(toSave)`, `save(options)`, `initScroll()`… `this` is the
controller. Prefer events; override only when the built-in behaviour must be replaced.

## Options vocabulary (`controller/view-options.js`)

**View options** (React state, read by chrome/layouts): `slots` `actions` `rowActions` `handlers`
`columns` `gridTemplate` `sidebar` `sidebarHeader` `primaryAction` `canUpdate` `readOnly`
`hasSidebar` `hasHeader` `hasBreadcrumb` `hasHistory` `hasSearchForm` `hasSelectAll`
`hasSelectRow` `disabledSearchFields` `onlyList` `onlyGrid`.
`has*` flags are opt-out: everything is on unless a `config` or a layout prop says `false`.
`canUpdate` is opt-in: only the `form` entry grants it.
`rowActions(row)` → `{ key: node }`: extra entries on top of each list row's "⋯" menu (above Edit/View · Print · Delete).
`readOnly`: fields show their value instead of their control (label + value in an inert box,
formatted like on paper via `@loopar/print`; checkboxes stay, inert). The server turns it on for
records opened with `view` (`Document.readOnly`, set by `BaseController.actionView`); a view's
`config`/props can force it either way. A GET to `update` without the update permission but with
`view` lands on the read-only view (AuthController). On it, "Edit" replaces Save when the user may edit.
Precedence: layout defaults (`defineLayout(name, Body, defaults)`) < entry defaults < view `config`
< hooks (`useActions`, `useHandlers`, `useDocumentConfig`) < layout props.

**Controller options** (applied once on mount): `controller` `notRequireChanges`
`restoreScroll` `overrides` (raw methods, e.g. `getFormValues`) `mapDocument`.

## Field store (`controller/field-store.js`)

`ctrl.fields` keeps the rendered fields: refs (no re-render) and runtime meta
(`setFieldDf`, `on`) as immutable snapshots with subscribers. `Meta.jsx` reads a
field's meta with `useFieldMeta(fields, name)`, so changing one field's
visibility re-renders that field only.

## Printing

Every record can be printed from `/desk/<Entity>/print?name=X` (`BaseController.actionPrint`).
`print` is its own permission (derived from the action like any other), and a
grant with scope `own` only prints the user's records. The AppBar shows **Print**
on a saved record when the user holds it.

The sheet shows, in order of preference:

1. **A Print Format** (`?format=<name>`, else the entity's default) — designed in the
   **Print Format Builder**, saved as app files under `modules/<module>/print-formats/<name>/`
   (type "Print Format", no table). `?format=standard` skips it.
2. **`client/<entity>-print.jsx`** if the app ships one — a regular view that paints `<PrintLayout>`.
3. **The automatic format**: letterhead + `<PrintHeader/>` + `<PrintStructure/>`, built from the
   doc_structure (rows keep their columns, tabs/sections/cards become titled sections,
   form_tables become tables using the child's `in_list_view` columns, empty fields and
   sections are omitted, `hidden`/`print_hide` fields never print). Entity selects print the
   linked record's title (`title_fields`), sent by the action as `linkTitles`.

```jsx
import { PrintLayout, PrintHeader, PrintStructure, LetterheadBlock } from "@loopar/print";

export default function QuotePrint() {
  return (
    <PrintLayout>
      <LetterheadBlock />
      <PrintHeader title="Quotation" />
      <PrintStructure />
      <p className="mt-6 text-sm">Valid for 30 days.</p>
    </PrintLayout>
  );
}
```

**Designing a format** — the Print Format Builder's designer offers the *Print* elements
(only there): `letterhead`, `doc_header`, `doc_field`, `doc_table`, `doc_body` (the automatic
body) and `page_break`, next to layout/content/media. They read the record through
`usePrintRecord()`; in the designer they show placeholders. **Load entity** (button in the builder's form, next to the entity; disabled until one is picked)
drops the entity's own form layout into the designer as print elements — fields → `doc_field`,
form_tables → `doc_table`, cards/tabs → `doc_section`, rows/cols kept — replacing or appending,
as an undoable edit (`Emitter.emit("designer:load", { field, elements, mode })`). Start from the
real view and remove what paper doesn't need. "Go to <Format>" opens
`/desk/<Format>/view?name=<record>` (latest record when omitted): the format on real data.

**Letterhead** — a core entity with the company data (one marked default). A format may pick
one; otherwise the default is used. Code views read it with `useLetterhead()` or
`<LetterheadBlock/>` / `<LetterheadFooter/>` (outside the print entry they fetch the default).

`PrintLayout` owns the paper: sheet width and `@page` follow the paper/orientation of the
format, or the user's pick in the toolbar; inside the sheet the theme tokens are re-pointed to a
light palette. On paper everything marked `data-print-hide` (desk chrome, AppBar) disappears.
PDF: the browser's print dialog ("Save as PDF").
