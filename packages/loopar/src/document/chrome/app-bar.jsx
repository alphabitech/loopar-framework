import { Toolbar, ActionButton, normalizeActions, planActions } from "./toolbar";
import { Trail, moduleCrumbs, homeCrumbs } from "./trail";
import { useLocation } from "react-router";
import { StateBadge, useWorkflowActions } from "../form/workflow-bar";
import { cn } from "@cn/lib/utils";
import loopar from "loopar";
import { Button } from "@cn/components/ui/button";
import { PlusIcon, SaveIcon, ArrowBigRight, MenuIcon, GridIcon, KanbanIcon, CalendarIcon, ChartColumnIcon, CheckIcon, PrinterIcon, PanelRightIcon, PencilIcon, FileTextIcon, TextCursorInputIcon } from "lucide-react";
import {Link} from "@link";
import { useDocument, useViewOptions } from "@loopar/document";
import { canOn } from "@context/auth-context";
import { useWorkspace } from "@workspace/workspace-provider";
import { useContext } from "react";
import { useFormState } from "react-hook-form";
import { BaseFormContext } from "@form-context";
import { listViews, nextListView } from "../list/views";
import { SavedViewsMenu } from "../list/saved-views";
import { ScheduleAction, eventTarget } from "../form/record-events";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { __ } from "@global/i18n";
import { RecordTranslationsButton, useRecordTranslations } from "../../components/translation/record-translations";

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
      {__("Save")}
    </Button>
  )
}

/** Where "Go to <record>" leads on builders and entities (what the record builds), or null. */
function goToTarget(Document) {
  const { Entity = {}, data = {} } = Document;
  if (Document.isNew || !data.name) return null;
  if (["Entity", "Builder"].includes(Entity.name)) {
    // Child entities have no route of their own: rows live inside the parent form.
    if (data.is_child === 1 || data.is_child === true) return null;
    return `/desk/${data.name}/${data.is_single ? "update" : "list"}`;
  }
  if (["Page Builder", "View Builder", "Print Format Builder", "Desk Page Builder"].includes(Entity.name)) return `/desk/${data.name}/view`;
  if (Entity.name === "Dashboard") return `/desk/Dashboard/view?name=${encodeURIComponent(data.name)}`;
  return null;
}

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
    title: __("Rename {0}", [Entity.name]),
    label: `New name for "${name}"`,
    placeholder: name,
    validate: (value) => {
      if (!value || !value.trim()) loopar.throw("The new name is required");
      return true;
    },
    ok: async (newName) => {
      const { rename: plan } = await loopar.call(Entity.name, "rename", { body: { name, new_name: newName.trim(), dry_run: 1 } });
      loopar.confirm({
        title: __("Rename \"{0}\" → \"{1}\"?", [plan.from, plan.to]),
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
      {__("Rename")}
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
  if (meta.action !== "view" || !Document.name || Entity.is_single || Entity.is_builder || Entity.read_only) return null;
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
  // The portal shows records only as their print format: nothing to toggle to.
  const portal = useWorkspace().workspace === "portal";
  if (portal) return null;

  if (meta.action === "print" && name) {
    return (
      <Link variant="secondary" className="px-2" to={recordUrl(Document)} aria-label={__("Back to the document")} title={__("Back to the document")}>
        <FileTextIcon />
      </Link>
    );
  }
  if (!canPrint(Document)) return null;
  return (
    <Link variant="secondary" className="px-2" to={`/desk/${Entity.name}/print?name=${encodeURIComponent(name)}`} aria-label={__("Print")} title={__("Print")}>
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
  return dirtyFields && Object.keys(dirtyFields).length > 0 ? <Pill>{__("Unsaved")}</Pill> : null;
};

/**
 * Save state next to the title, only on editable forms: "Not saved" for a new
 * record, "Unsaved" while the form has changes (cleared when a save resets it).
 */
const SaveState = ({ Document }) => {
  const form = useContext(BaseFormContext);
  const { canUpdate } = useViewOptions();
  if (!form || !canUpdate || !["create", "update"].includes(Document?.meta?.action)) return null;
  if (Document.isNew) return <Pill>{__("Not saved")}</Pill>;
  return <DirtyPill control={form.control} />;
};

/** Toggle button: shows the view it switches to. */
// Labels are functions: translated on render, in the request's language
// (a module-level __() would freeze the server's language at import time).
const VIEW_BUTTON = {
  List: { icon: <MenuIcon />, label: () => __("List view") },
  Grid: { icon: <GridIcon />, label: () => __("Grid view") },
  Kanban: { icon: <KanbanIcon />, label: () => __("Board view") },
  Calendar: { icon: <CalendarIcon />, label: () => __("Calendar view") },
  Report: { icon: <ChartColumnIcon />, label: () => __("Report view") },
};

/**
 * View switch of a list: the button shows the current view and opens a menu
 * to pick another (two views would just toggle).
 */
function ViewSwitch({ Document, viewType, viewTypeToggle, setViewType }) {
  const views = listViews(Document);
  if (views.length <= 2 || !setViewType) {
    const next = VIEW_BUTTON[nextListView(Document, viewType)];
    return (
      <Button className="px-2" variant="secondary" onClick={viewTypeToggle} title={__("Toggle view")}>
        {next.icon}
        <span className="lp-menu-label pl-1">{next.label()}</span>
      </Button>
    );
  }

  const current = VIEW_BUTTON[viewType] || VIEW_BUTTON.List;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="px-2" variant="secondary" title={__("Change view")}>
          {current.icon}
          <span className="lp-menu-label pl-1">{current.label()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {views.map((view) => (
          <DropdownMenuItem key={view} onSelect={() => setViewType(view)} className="gap-2 [&_svg]:size-4">
            {VIEW_BUTTON[view].icon}
            <span className="flex-1">{VIEW_BUTTON[view].label()}</span>
            {view === viewType && <CheckIcon className="text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where the page sits: app › module › entity list (› record on its print).
 * Ancestors only — the page itself is the title.
 */
function trailOf(Document, contextName, apps, search) {
  const { Entity = {}, name } = Document;
  const home = homeCrumbs(apps, Document, search);
  if (home) return home;
  if (Document.__MODULE__) {
    const moduleName = Document.__MODULE__.name || Document.__MODULE__;
    // The module itself closes the trail (active): the top bar already shows the app.
    return moduleCrumbs(apps, moduleName);
  }

  const crumbs = moduleCrumbs(apps, Entity.module);
  if (["form", "view", "print"].includes(contextName) && Entity.name && !Entity.is_single) {
    crumbs.push({ label: __(Entity.name), to: `/desk/${Entity.name}/list` });
  }
  if (contextName === "print" && name) crumbs.push({ label: name, to: recordUrl(Document) });
  return crumbs;
}

function headerTitle(Document, contextName) {
  const { Entity = {}, data = {} } = Document;
  if (Document.__MODULE__) return __(Document.__MODULE__.description || Document.__MODULE__.name || Document.__MODULE__);
  if (contextName === "print") return __("Print");
  if (contextName === "list" || contextName === "module" || Entity.is_single) return __(Entity.name);
  if (Document.isNew) return __("New {0}", [__(Entity.name)]);
  return Document.name || data.name || __(Entity.name);
}

/** Record state next to the title: the view's `status` option, else the workflow state. */
function StatusBadge({ status, workflow }) {
  const value = typeof status === "function" ? status() : status;
  if (value) {
    const { label, color } = typeof value === "string" ? { label: value } : value;
    return label ? <StateBadge state={__(label)} color={color} className="shrink-0" /> : null;
  }
  return workflow ? <StateBadge state={workflow.state} color={workflow.color} className="shrink-0" /> : null;
}

const PanelToggle = ({ panel }) => (
  <Button
    variant="secondary"
    // Pressed look without a second filled button next to the primary.
    className={cn("px-2", panel.open && "bg-accent text-accent-foreground ring-1 ring-border")}
    onClick={(e) => { e.preventDefault(); panel.toggle(); }}
    aria-pressed={panel.open}
    aria-label={__("Details")}
    title={__("Details")}
  >
    <PanelRightIcon />
  </Button>
);

/**
 * Document header:
 *   1. breadcrumbs — where the page sits, in the desk top bar (not in modals)
 *   2. title + status · toolbar — sticky under the top bar; the toolbar drops below the title when both don't fit
 *   3. `headerTabs` (view option) — always visible, scrolls sideways on narrow screens
 */
export function AppBar({ Document, viewTypeToggle, setViewType, viewType, applyView, panel, hasBreadcrumb }) {
  const {
    actions = {}, status, headerTabs, onlyGrid, onlyList, canUpdate, hasListSettings,
  } = useViewOptions();
  const { inModal, docRef } = useDocument();
  const { __META__ } = useWorkspace();
  const { search } = useLocation();
  const apps = Array.isArray(__META__?.menu_data) ? __META__.menu_data : [];
  const { meta = {}, Entity = {} } = Document;

  const contextName = ["create", "update"].includes(meta.action) ? "form" : meta.action;
  const isList = contextName === "list";
  const title = headerTitle(Document, contextName);
  const crumbs = !inModal && hasBreadcrumb !== false ? trailOf(Document, contextName, apps, search) : [];

  const workflow = useWorkflowActions(Document);

  // Also on read-only views: a builder locked in production still leads to what it builds.
  const goTo = (canUpdate || meta.action === "view") ? goToTarget(Document) : null;
  const edit = editTarget(Document);
  const recordTranslations = useRecordTranslations();

  const list = [
    ...workflow.actions,
    ...normalizeActions(actions),
    ...(goTo ? [{
      key: "__goto", pin: true, icon: ArrowBigRight, to: goTo,
      label: __("Go to {0}", [__(loopar.utils.Capitalize(Document.data?.name))]),
    }] : []),
    // Read-only view: Edit is the primary unless the view names another one.
    ...(edit ? [{ key: "__edit", primary: true, icon: PencilIcon, label: __("Edit"), to: edit }] : []),
    // Read-only entities: records come from the app's flows — no New.
    ...(isList && !Entity.read_only ? [{
      key: "__new", primary: true, fallback: true, icon: PlusIcon, label: __("New"), to: `/desk/${Entity.name}/create`,
    }] : []),
    ...(isList && applyView && hasListSettings !== false && onlyGrid !== true && onlyList !== true ? [{
      key: "__savedviews",
      render: <SavedViewsMenu key="__savedviews" Document={Document} viewType={viewType} applyView={applyView} />,
    }] : []),
    ...(isList && onlyGrid !== true && onlyList !== true ? [{
      key: "__viewtype",
      render: <ViewSwitch key="__viewtype" Document={Document} viewType={viewType} viewTypeToggle={viewTypeToggle} setViewType={setViewType} />,
    }] : []),
  ];

  // An editable form keeps Save as its primary; the view's primaries lead the row.
  const hasSave = !!(canUpdate && docRef?.save && !isList && ["form", "view"].includes(contextName) && !edit);
  const planned = planActions(list, { keepPrimary: hasSave });

  const utilities = [
    ...(!inModal && eventTarget(Document) ? [["__schedule", <ScheduleAction key="__schedule" Document={Document} />]] : []),
    ...(recordTranslations && canUpdate ? [["__translations", <RecordTranslationsButton key="__translations" />]] : []),
  ];
  const toggles = [
    ["__print", <PrintToggle key="__print" Document={Document} />],
    ...(panel?.available ? [["__panel", <PanelToggle key="__panel" panel={panel} />]] : []),
  ];
  const menu = canRename(Document, canUpdate) ? [["__rename", <RenameAction key="__rename" Document={Document} />]] : [];

  const primary = hasSave ? <SaveButton /> : planned.primary ? <ActionButton action={planned.primary} variant="default" /> : null;
  const tabs = typeof headerTabs === "function" ? headerTabs() : headerTabs;

  // A fragment: the title row must be a direct child of the document column to
  // stay sticky through the whole document (inside a <header> it would leave with it).
  return (
    <>
      <Trail items={crumbs} />
      <div
        data-print-hide
        // Sticky under the top bar: Save, the actions and the panel toggle stay at hand on long documents.
        className={cn(
          // top: below the top bar and its 1px border. py-2 keeps the same room above and
          // below while stuck; unstuck, -mt-2 cancels the desk content's pt-2 so the
          // buttons stay centered between the top bar and this row's border.
          "sticky top-[calc(var(--spacing-header-height)+1px)] z-30 -mx-2 flex flex-row flex-wrap items-center gap-x-3 gap-y-2 bg-background/95 px-2 py-2 backdrop-blur-sm",
          !inModal && "sm:-mt-2",
          !tabs && "border-b"
        )}
      >
        {/* The title keeps at least 16rem: past that, the toolbar wraps below it. */}
        <div className="flex min-w-0 flex-[1_1_16rem] flex-row items-center gap-2">
          <h1 className="truncate text-xl font-semibold" title={typeof title === "string" ? title : undefined}>{title}</h1>
          <StatusBadge status={status} workflow={workflow.state} />
          <span className="flex shrink-0 empty:hidden"><SaveState Document={Document} /></span>
        </div>
        <Toolbar
          // Compact row: every action (buttons and links from any view) at h-9; icons keep their size.
          className="ml-auto [&_:is(a,button)]:h-9"
          actions={planned}
          utilities={utilities}
          toggles={toggles}
          menu={menu}
          primary={primary}
        />
      </div>
      {tabs && <div className="-mt-3 min-w-0 overflow-x-auto border-b" data-print-hide>{tabs}</div>}
      {workflow.modal}
    </>
  );
}
