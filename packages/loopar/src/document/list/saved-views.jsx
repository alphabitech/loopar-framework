import { useEffect, useState } from "react";
import loopar from "loopar";
import { BookmarkIcon, Loader2, MailIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@cn/components/ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { Checkbox } from "@cn/components/ui/checkbox";
import { useWorkspace } from "@workspace/workspace-provider";
import { queryOf } from "@@table/list-url";
import { REPORT_PARAMS } from "@global/list-report";
import { __ } from "@global/i18n";

const SAVED_VIEW = "Saved View";

// Labels are functions: translated on render, in the page's language.
const SCHEDULES = {
  none: () => __("Never"),
  daily: () => __("Every day"),
  weekly: () => __("Every Monday"),
  monthly: () => __("The 1st of every month"),
};

/** Email schedule of one of the user's own views: when, and to whom (default: the user). */
function ScheduleForm({ view, onSaved }) {
  const [schedule, setSchedule] = useState(view.email_schedule || "none");
  const [to, setTo] = useState(view.email_to || "");
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await loopar.call(SAVED_VIEW, "schedule", { body: { name: view.name, schedule, to }, freeze: false });
      onSaved();
    } catch {
      // The error toast already says why.
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="mb-1 ml-2 flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
      <div className="text-xs text-muted-foreground">{__("Send this view by email (a table, and the whole of it as CSV)")}</div>
      <Select value={schedule} onValueChange={setSchedule}>
        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(SCHEDULES).map(([key, label]) => <SelectItem key={key} value={key}>{label()}</SelectItem>)}
        </SelectContent>
      </Select>
      {schedule !== "none" && (
        <Input className="h-8" value={to} placeholder={__("Emails, separated by commas (empty: yours)")} onChange={(e) => setTo(e.target.value)} />
      )}
      <div className="flex justify-end">
        <Button type="submit" className="h-8" disabled={saving}>{__("Save")}</Button>
      </div>
    </form>
  );
}

/** What a saved view keeps of the list's URL: filters, sort and — on the Report view — the report. */
function currentQuery(url, viewType) {
  const params = queryOf(url);
  ["page", "preloaded", "workspace", ...(viewType === "Report" ? [] : REPORT_PARAMS)].forEach((key) => params.delete(key));
  return params.toString();
}

/**
 * Saved views of a list (core/document/saved-views.js): a menu to open one —
 * its filters, sort, view type and report — and to save the list as it is
 * now, for oneself or shared with everyone who can open the list.
 */
export function SavedViewsMenu({ Document, viewType, applyView }) {
  const entity = Document.Entity?.name;
  const { pathname: currentUrl } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, views: [] });
  const [title, setTitle] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  // The view whose email schedule is being edited.
  const [scheduling, setScheduling] = useState(null);

  const load = () => {
    setState((s) => ({ ...s, loading: true }));
    loopar.call(SAVED_VIEW, "views", { query: { entity }, freeze: false, notifyError: false })
      .then((r) => setState({ loading: false, views: r?.views || [] }))
      .catch(() => setState({ loading: false, views: [] }));
  };

  useEffect(() => { if (open) load(); }, [open, entity]);

  const query = currentQuery(currentUrl, viewType);
  const isCurrent = (view) => view.view_type === viewType && view.query === query;

  const save = async (e) => {
    e?.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await loopar.call(SAVED_VIEW, "save", { body: { entity, title, query, view_type: viewType, shared: shared ? 1 : 0 }, freeze: false });
      setTitle("");
      setShared(false);
      load();
    } catch {
      // The error toast already says why.
    } finally {
      setSaving(false);
    }
  };

  const remove = async (view) => {
    try {
      await loopar.call(SAVED_VIEW, "remove", { body: { name: view.name }, freeze: false });
      load();
    } catch {
      // The error toast already says why.
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="px-2" variant="secondary" title={__("Saved views")} aria-label={__("Saved views")}>
          <BookmarkIcon />
          {/* Shown when the toolbar folds into its menu (phones), like the view switch. */}
          <span className="lp-menu-label pl-1">{__("Saved views")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          {__("Saved views")}
          {state.loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>

        {state.views.length === 0 && !state.loading && (
          <p className="mb-3 text-sm text-muted-foreground">{__("No saved views yet. Set filters, sort or a report and save it here.")}</p>
        )}

        <ul className="mb-3 flex max-h-64 flex-col gap-0.5 overflow-y-auto empty:hidden">
          {state.views.map((view) => (
            <li key={view.name} className="flex flex-col">
              <div className="group flex items-center gap-1">
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${isCurrent(view) ? "bg-accent/60 font-medium" : ""}`}
                onClick={() => { setOpen(false); applyView(view); }}
              >
                <span className="min-w-0 flex-1 truncate">{view.title}</span>
                {view.shared && <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={__("Shared")} />}
                <span className="shrink-0 text-xs text-muted-foreground">{__(view.view_type === "Kanban" ? "Board" : view.view_type)}</span>
              </button>
              {view.mine && (
                <button
                  type="button"
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground hover:opacity-100 ${view.email_schedule && view.email_schedule !== "none" ? "text-primary" : "text-muted-foreground opacity-60"}`}
                  title={__("Send by email on a schedule")} aria-label={__("Send by email on a schedule")}
                  onClick={() => setScheduling((current) => (current === view.name ? null : view.name))}
                >
                  <MailIcon className="size-3.5" />
                </button>
              )}
              {view.mine && (
                <button
                  type="button"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100"
                  title={__("Remove this view")} aria-label={__("Remove this view")}
                  onClick={() => remove(view)}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              )}
              </div>
              {scheduling === view.name && <ScheduleForm view={view} onSaved={() => { setScheduling(null); load(); }} />}
            </li>
          ))}
        </ul>

        <form onSubmit={save} className="flex flex-col gap-2 border-t pt-3">
          <div className="text-xs text-muted-foreground">{__("Save the list as it is now")}</div>
          <div className="flex items-center gap-2">
            <Input className="h-9" value={title} maxLength={80} placeholder={__("View name")} onChange={(e) => setTitle(e.target.value)} />
            <Button type="submit" className="h-9" disabled={!title.trim() || saving}>{__("Save")}</Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={shared} onCheckedChange={(checked) => setShared(!!checked)} />
            {__("Share with everyone who can open this list")}
          </label>
        </form>
      </PopoverContent>
    </Popover>
  );
}
