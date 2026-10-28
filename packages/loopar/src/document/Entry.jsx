import { useMemo } from "react";
import { useShallowStable } from "./base/use-shallow-stable";
import { DocumentProvider, DefaultView } from "./base/provider";
import { DocumentController } from "./controller/document-controller";
import { FormController } from "./controller/form-controller";
import { useController } from "./controller/use-controller";
import { pickViewOptions, pickControllerOverrides, mergeViewOptions } from "./controller/view-options";

/**
 * The chain, top-down (see README.md):
 *
 *   Workspace
 *     └─ <Entry kind>              the door the server chose (Document.entry)
 *          └─ DocumentProvider     base: Document, controller, view options
 *               └─ Middleware      FormProvider | ListProvider | none  (useForm / useList)
 *                    └─ view       client/<entity>-<kind>.jsx if the app ships one, else DefaultView
 *                         └─ <FormLayout/> …  the chrome the view decides to paint
 */

/**
 * Each kind's UI ships in its own chunk, so a web page never downloads the form,
 * list or print machinery (react-hook-form, zod, kanban, icon picker...).
 * `loadEntry(kind)` resolves a kind before its first render — AppSourceLoader
 * awaits it on the server and on the client — so <Entry> renders synchronously:
 * no Suspense, the SSR markup and the hydration render stay identical.
 */
const kindModules = {
  form:      () => import("./form"),
  list:      () => import("./list"),
  page:      () => import("./page"),
  deskPage:  () => import("./page/desk-page-layout"),
  dashboard: () => import("./page/dashboard-layout"),
  print:     () => import("./print"),
};

const middlewares = {
  form: (m) => m.form.FormProvider,
  list: (m) => m.list.ListProvider,
};

/**
 * Per kind: chunks it needs, middleware, layout and what makes the kind different (a view's `config` overrides it).
 * `has*` flags are opt-out (true unless a config/layout says false); `canUpdate` is opt-in, granted here.
 */
export const entries = {
  form:       { modules: ["form"], middleware: "form", layout: (m) => m.form.FormLayout,   defaults: { canUpdate: true } },
  view:       { modules: ["form"], middleware: "form", layout: (m) => m.form.FormLayout,   defaults: { canUpdate: false } },
  report:     { modules: ["form"], middleware: "form", layout: (m) => m.form.ReportLayout },
  print:      { modules: ["form", "print"], middleware: "form", layout: (m) => m.print.PrintLayout, defaults: { canUpdate: false, hasSidebar: false, hasHistory: false } },
  installer:  { modules: ["form"], middleware: "form", layout: (m) => m.form.BareLayout,   defaults: { controller: "System", notRequireChanges: true,
                handlers: { install: (ctrl) => ctrl.send({ action: "install" }), connect: (ctrl) => ctrl.send({ action: "connect" }) } } },
  auth:       { modules: ["form"], middleware: "form", layout: (m) => m.form.BareLayout,   defaults: { controller: "Auth" }, form: { schema: false } },
  list:       { modules: ["list"], middleware: "list", layout: (m) => m.list.ListLayout },
  page:       { modules: ["page"], layout: (m) => m.page.PageLayout },
  "desk-page": { modules: ["deskPage"], layout: (m) => m.deskPage.DeskPageLayout, defaults: { hasHistory: false, hasSidebar: false } },
  dashboard:  { modules: ["dashboard"], layout: (m) => m.dashboard.DashboardLayout, defaults: { hasHistory: false, hasSidebar: false } },
  web:        { modules: ["page"], layout: (m) => m.page.WebLayout },
  controller: { modules: [], layout: () => null },
};

const unknownKind = (kind) => new Error(`Unknown document entry "${kind}" (${Object.keys(entries).join(" | ")})`);

/** Resolved kinds: the entry with its real `layout` and `Provider`. Static per build, so one cache per process. */
const loaded = {};

export async function loadEntry(kind) {
  if (loaded[kind]) return loaded[kind];
  const entry = entries[kind];
  if (!entry) throw unknownKind(kind);

  const m = Object.fromEntries(await Promise.all(entry.modules.map(async (key) => [key, await kindModules[key]()])));
  loaded[kind] = {
    ...entry,
    layout: entry.layout(m),
    Provider: entry.middleware ? middlewares[entry.middleware](m) : null,
  };
  return loaded[kind];
}

export function Entry({ kind, children, mapDocument, ...props }) {
  if (!entries[kind]) throw unknownKind(kind);
  const entry = loaded[kind];
  if (!entry) throw new Error(`Document entry "${kind}" rendered before loadEntry("${kind}") resolved it`);

  const ctrl = useEntryController(entry, mapDocument, props);
  const options = useShallowStable(mergeViewOptions(pickViewOptions(entry.defaults), pickViewOptions(props)));

  return (
    <DocumentProvider ctrl={ctrl} layout={entry.layout} options={options}>
      <Middleware entry={entry} ctrl={ctrl}>
        {children ?? <DefaultView />}
      </Middleware>
    </DocumentProvider>
  );
}

/** The kind's logic layer, above the view (FormProvider | ListProvider | none). */
function Middleware({ entry, ctrl, children }) {
  const { Provider } = entry;
  return Provider ? <Provider ctrl={ctrl} {...entry.form}>{children}</Provider> : children;
}

function useEntryController(entry, mapDocument, props) {
  const Document = useMemo(
    () => (mapDocument ? mapDocument(props.Document) : props.Document),
    [mapDocument, props.Document]
  );
  const ctrlProps = Document === props.Document ? props : { ...props, Document };

  // Static config → resolved once per mount.
  const overrides = useMemo(
    () => ({ ...pickControllerOverrides(entry.defaults), ...pickControllerOverrides(props) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return useController(entry.middleware === "form" ? FormController : DocumentController, ctrlProps, overrides);
}
