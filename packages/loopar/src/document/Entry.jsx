import { useMemo } from "react";
import { useShallowStable } from "./base/use-shallow-stable";
import { DocumentProvider, DefaultView } from "./base/provider";
import { FormProvider, FormLayout, ReportLayout, BareLayout } from "./form";
import { ListProvider, ListLayout } from "./list";
import { PageLayout, WebLayout, DeskPageLayout, DashboardLayout } from "./page";
import { PrintLayout } from "./print";
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
 * Per kind: middleware, layout and what makes the kind different (a view's `config` overrides it).
 * `has*` flags are opt-out (true unless a config/layout says false); `canUpdate` is opt-in, granted here.
 */
export const entries = {
  form:       { middleware: "form", layout: FormLayout,   defaults: { canUpdate: true } },
  view:       { middleware: "form", layout: FormLayout,   defaults: { canUpdate: false } },
  report:     { middleware: "form", layout: ReportLayout },
  print:      { middleware: "form", layout: PrintLayout,  defaults: { canUpdate: false, hasSidebar: false, hasHistory: false } },
  installer:  { middleware: "form", layout: BareLayout,   defaults: { controller: "System", notRequireChanges: true,
                handlers: { install: (ctrl) => ctrl.send({ action: "install" }), connect: (ctrl) => ctrl.send({ action: "connect" }) } } },
  auth:       { middleware: "form", layout: BareLayout,   defaults: { controller: "Auth" }, form: { schema: false } },
  list:       { middleware: "list", layout: ListLayout },
  page:       { layout: PageLayout },
  "desk-page": { layout: DeskPageLayout, defaults: { hasHistory: false, hasSidebar: false } },
  dashboard:  { layout: DashboardLayout, defaults: { hasHistory: false, hasSidebar: false } },
  web:        { layout: WebLayout },
  controller: { layout: null },
};

export function Entry({ kind, children, mapDocument, ...props }) {
  const entry = entries[kind];
  if (!entry) throw new Error(`Unknown document entry "${kind}" (${Object.keys(entries).join(" | ")})`);

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

/** The kind's logic layer, above the view. */
function Middleware({ entry, ctrl, children }) {
  if (entry.middleware === "form") return <FormProvider ctrl={ctrl} {...entry.form}>{children}</FormProvider>;
  if (entry.middleware === "list") return <ListProvider ctrl={ctrl}>{children}</ListProvider>;
  return children;
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
