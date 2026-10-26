import { Toolbar } from "./toolbar";
import loopar from "loopar";
import { Button } from "@cn/components/ui/button";
import { PlusIcon, SaveIcon, ArrowBigRight, MenuIcon, GridIcon, KanbanIcon, PrinterIcon, ArrowLeftIcon, PencilIcon, FileTextIcon, TextCursorInputIcon } from "lucide-react";
import {Link} from "@link";
import { useDocument, useViewOptions } from "@loopar/document";
import { canOn } from "@context/auth-context";
import { useContext } from "react";
import { useFormState } from "react-hook-form";
import { BaseFormContext } from "@form-provider";
import { nextListView } from "../list/views";

/** Save. Filled (`default`) in the header — the one primary action; callers may pass another variant. */
export const SaveButton = ({ variant = "default" }) => {
  const {docRef} = useDocument();
  const { canUpdate } = useViewOptions();

  if (!docRef || !canUpdate || !docRef.save) return null;
  return (
    <Button
      variant={variant}
      tabIndex="0"
      onClick={(e) => {
        e.preventDefault();
        docRef.save();
      }}
    >
      <SaveIcon className="pr-1" />
      Save
    </Button>
  )
}

/** Where "Go to <record>" leads on builders and entities (what the record builds), or null. */
function goToTarget(Document) {
  const { Entity = {}, data = {} } = Document;
  if (Document.isNew || !data.name) return null;
  if (["Entity", "Builder"].includes(Entity.name)) return `/desk/${data.name}/${data.is_single ? "update" : "list"}`;
  if (["Page Builder", "View Builder", "Print Format Builder", "Desk Page Builder"].includes(Entity.name)) return `/desk/${data.name}/view`;
  if (Entity.name === "Dashboard") return `/desk/Dashboard/view?name=${encodeURIComponent(data.name)}`;
  return null;
}

const GoToAction = ({ to, name }) => (
  <Link variant="secondary" to={to}>
    <ArrowBigRight className="pr-1" />
    Go to {loopar.utils.Capitalize(name)}
  </Link>
);

/**
 * Rename a meta record (an entity, page, form…): asks the new name, shows what
 * the rename touches (dry run) and applies it. Server: BaseController.actionRename.
 */
const RenameAction = ({ Document }) => {
  const { Entity = {}, name } = Document;

  const describe = (plan) => [
    `Folder: ${plan.folder[0]} → ${plan.folder[1]}`,
    `Files renamed: ${plan.files.length}`,
    plan.ownsTable ? `Table "${plan.from}" → "${plan.to}" (data kept)` : null,
    plan.jsonFiles.length ? `References updated in ${plan.jsonFiles.length} JSON file(s)` : null,
    "References in this database (history, menus, permissions…) are updated; other tenants get it on the app update.",
    plan.codeUsages.length ? `\nNOT changed — review these code usages:\n${plan.codeUsages.join("\n")}` : null,
  ].filter(Boolean).join("\n");

  const run = () => loopar.prompt({
    title: `Rename ${Entity.name}`,
    label: `New name for "${name}"`,
    placeholder: name,
    validate: (value) => {
      if (!value || !value.trim()) loopar.throw("The new name is required");
      return true;
    },
    ok: async (newName) => {
      const { rename: plan } = await loopar.call(Entity.name, "rename", { body: { name, new_name: newName.trim(), dry_run: 1 } });
      loopar.confirm({
        title: `Rename "${plan.from}" → "${plan.to}"?`,
        content: <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{describe(plan)}</pre>,
      }, async () => {
        const { rename: done } = await loopar.call(Entity.name, "rename", { body: { name, new_name: plan.to } });
        loopar.navigate(`/desk/${Entity.name}/update?name=${encodeURIComponent(done.to)}`);
      });
    },
  });

  return (
    <Button variant="ghost" className="w-full justify-start" onClick={run}>
      <TextCursorInputIcon className="pr-1" />
      Rename
    </Button>
  );
};

/** Rename applies to saved meta records (entities, pages, forms…) the user may edit. */
const canRename = (Document, canUpdate) =>
  !!(Document.Entity?.is_builder && !Document.isNew && Document.name && canUpdate
    && ["update", "view"].includes(Document.meta?.action));

/** "Edit" on a read-only view, for users who may edit the record. */
function editTarget(Document) {
  const { meta = {}, Entity = {}, data = {} } = Document;
  if (meta.action !== "view" || !Document.name || Entity.is_single || Entity.is_builder) return null;
  if (!canOn(Entity.name, "update", data)) return null;
  return `/desk/${Entity.name}/update?name=${encodeURIComponent(Document.name)}`;
}

/** Can this document be printed here? (saved record, form or view, `print` permission) */
function canPrint(Document) {
  const { meta = {}, Entity = {}, data = {} } = Document;
  if (!["update", "view"].includes(meta.action)) return false;
  if (Document.isNew || !Document.name || Entity.is_single || Entity.is_builder) return false;
  return canOn(Entity.name, "print", data);
}

/** The record behind a print (form if the user may edit it, else the read-only view). */
function recordUrl(Document) {
  const { Entity = {}, data = {}, name } = Document;
  const action = canOn(Entity.name, "update", data) ? "update" : "view";
  return `/desk/${Entity.name}/${action}?name=${encodeURIComponent(name)}`;
}

function PrintToggle({ Document }) {
  const { meta = {}, Entity = {}, name } = Document;

  if (meta.action === "print" && name) {
    return (
      <Link variant="secondary" className="px-2" to={recordUrl(Document)} aria-label="Back to the document" title="Back to the document">
        <FileTextIcon />
      </Link>
    );
  }
  if (!canPrint(Document)) return null;
  return (
    <Link variant="secondary" className="px-2" to={`/desk/${Entity.name}/print?name=${encodeURIComponent(name)}`} aria-label="Print" title="Print">
      <PrinterIcon />
    </Link>
  );
}

const Pill = ({ children }) => (
  <span className="shrink-0 whitespace-nowrap rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
    {children}
  </span>
);

/** Live dirty state of the desk form — the same signal as "No changes to save". */
const DirtyPill = ({ control }) => {
  const { dirtyFields } = useFormState({ control });
  return dirtyFields && Object.keys(dirtyFields).length > 0 ? <Pill>Unsaved</Pill> : null;
};

/**
 * Save state next to the title, only on editable forms: "Not saved" for a new
 * record, "Unsaved" while the form has changes (cleared when a save resets it).
 */
const SaveState = ({ Document }) => {
  const form = useContext(BaseFormContext);
  const { canUpdate } = useViewOptions();
  if (!form || !canUpdate || !["create", "update"].includes(Document?.meta?.action)) return null;
  if (Document.isNew) return <Pill>Not saved</Pill>;
  return <DirtyPill control={form.control} />;
};

function backTarget(Document, contextName) {
  const { Entity = {}, meta = {}, name, data } = Document;

  if (["form", "view", "print"].includes(contextName) && Entity.name && !Entity.is_single) {
    return `/desk/${Entity.name}/list`;
  }
  return Entity.module ? `/desk/${Entity.module}` : null;
}

function headerTexts(Document, contextName) {
  const { Entity = {}, data = {} } = Document;

  // Module pages render the "Module" entity: show the module itself.
  if (Document.__MODULE__) return { title: Document.__MODULE__.description || Document.__MODULE__.name, subtitle: null };
  if (contextName === "module") return { title: Entity.name, subtitle: null };
  if (contextName === "list" || Entity.is_single || Document.isNew) return { title: Entity.name, subtitle: null };
  const name = Document.name || data.name;
  return { title: Entity.name, subtitle: name && name !== Entity.name ? name : null };
}

/** Toggle button: shows the view it switches to. */
const VIEW_BUTTON = {
  List: { icon: <MenuIcon />, label: "List view" },
  Grid: { icon: <GridIcon />, label: "Grid view" },
  Kanban: { icon: <KanbanIcon />, label: "Board view" },
};

export function AppBar({Document, viewTypeToggle, viewType, sidebarOpen, ...props}) {
  const { actions = {}, actionsInMenu, primaryAction, onlyGrid, onlyList, canUpdate } = useViewOptions();
  const { inModal } = useDocument();
  const { meta, Entity } = Document;

  const contextName = ["create", "update"].includes(meta.action) ? "form" : meta.action;
  const { title, subtitle } = headerTexts(Document, contextName);
  const isList = contextName === "list";

  const back = !inModal && props.hasBreadcrumb !== false ? backTarget(Document, contextName) : null;

  const goTo = canUpdate ? goToTarget(Document) : null;

  const edit = editTarget(Document);

  const viewActions = Object.entries(actions).filter(([, node]) => node);

  const defaults = [
    ...(goTo ? [["__goto", <GoToAction key="__goto" to={goTo} name={Document.data?.name} />]] : []),
    ...(isList && onlyGrid !== true && onlyList !== true ? [[
      "__viewtype",
      <Button key="__viewtype" className="px-2" variant="secondary" onClick={viewTypeToggle} title="Toggle view">
        {VIEW_BUTTON[nextListView(Document, viewType)].icon}
        <span className="lp-menu-label pl-1">{VIEW_BUTTON[nextListView(Document, viewType)].label}</span>
      </Button>,
    ]] : []),
  ];

  // `primaryAction` (view option) replaces the default one: New on lists, Save elsewhere.
  const primary = primaryAction ? (typeof primaryAction === "function" ? primaryAction() : primaryAction)
    : isList ? (
      <Link variant="default" className="text-primary-foreground hover:text-primary-foreground" tabIndex="0" to={`/desk/${Entity.name}/create`}>
        <PlusIcon className="pr-1" />
        New
      </Link>
    ) : edit ? (
      // Read-only view: Edit takes Save's place.
      <Link variant="default" className="text-primary-foreground hover:text-primary-foreground" to={edit}>
        <PencilIcon className="pr-1" />
        Edit
      </Link>
    ) : <SaveButton />;

  return (
    <div
      className="flex w-full flex-row items-center gap-3 border-b pb-3"
      // The same right gutter on every page (room for the fixed ⋮ sidebar toggle,
      // shown or not), so the buttons keep their spot between pages (record ⇄ print).
      style={{ paddingRight: !sidebarOpen ? "1.5rem" : undefined }}
      data-print-hide
    >
      <div className="flex min-w-0 flex-1 flex-row items-center gap-2">
        {back && (
          <Link variant="ghost" className="-ml-1 h-8 w-8 shrink-0 p-0" to={back} aria-label="Back" title="Back">
            <ArrowLeftIcon />
          </Link>
        )}
        {/* wide: Entity (big) · record (small) — phones: record (bold) under a small Entity */}
        <h1 className="flex min-w-0 flex-row items-baseline gap-2 max-sm:flex-col-reverse max-sm:items-start max-sm:gap-0">
          <span className={`truncate text-2xl font-bold ${subtitle ? "max-sm:text-xs max-sm:font-normal max-sm:text-muted-foreground" : "max-sm:text-lg"}`}>{title}</span>
          {subtitle && <span className="truncate text-lg text-muted-foreground max-sm:font-bold max-sm:text-foreground">{subtitle}</span>}
        </h1>
        <span className="flex shrink-0 empty:hidden"><SaveState Document={Document} /></span>
      </div>
      <Toolbar
        // View actions sit in the row (⋯ on phones) unless the view opts into `actionsInMenu`.
        inline={[...(actionsInMenu ? [] : viewActions), ...defaults]}
        menu={[
          ...(actionsInMenu ? viewActions : []),
          ...(canRename(Document, canUpdate) ? [["__rename", <RenameAction key="__rename" Document={Document} />]] : []),
        ]}
        toggle={<PrintToggle Document={Document} />}
        primary={primary}
      />
    </div>
  );
}
