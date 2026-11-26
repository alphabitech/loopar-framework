import { useState } from "react";
import loopar from "loopar";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { Button } from "@cn/components/ui/button";
import { Link } from "@link";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

/**
 * Header actions are data. A view passes `actions` as `{ key: action }`, where
 * an action is a descriptor — or a function returning one (read at render
 * time), or null/false to skip it:
 *
 *   label     text (required unless `render`)
 *   icon      lucide component
 *   onClick   handler, receives the event (menus pass a stub with preventDefault)
 *   to        URL: the action navigates instead of calling onClick
 *   inModal   with `to`: opens it in a desk modal (onSaved runs when its form saves)
 *   primary   the record's main action: the only filled button. Several → the
 *             first wins, the rest show as visible secondaries. On an editable
 *             form Save keeps the primary slot and these show first in the row.
 *   fallback  a primary that steps aside when another primary exists (default New)
 *   pin       always visible in the row
 *   group     menu section (actions sharing a group sit together in "Actions")
 *   danger    destructive: red, always last in "Actions"
 *   disabled, title, visible (false hides it)
 *   render    a custom control (selects, menus…): sits in the row, in "⋯" on phones
 *
 * The row shows up to MAX_VISIBLE secondaries; the rest go to "Actions ▾".
 */
export const MAX_VISIBLE = 2;

const STUB_EVENT = { preventDefault() {}, stopPropagation() {} };

/** `{ key: action }` → list of descriptors, in order, without the skipped ones. */
export function normalizeActions(actions = {}) {
  return Object.entries(actions || {})
    .map(([key, a]) => {
      const d = typeof a === "function" ? a() : a;
      return d && typeof d === "object" ? { key, ...d } : null;
    })
    .filter((a) => a && a.visible !== false && (a.render || a.label));
}

/**
 * Splits the actions into the primary one, the row, the "Actions" menu and the
 * custom controls. `keepPrimary`: the default primary (Save) keeps its slot.
 */
export function planActions(list, { keepPrimary = false } = {}) {
  const custom = list.filter((a) => a.render);
  let rest = list.filter((a) => !a.render);

  const primaries = rest.filter((a) => a.primary);
  const real = primaries.filter((a) => !a.fallback);
  // A fallback primary only stands when nothing else claims the slot.
  rest = rest.filter((a) => !(a.fallback && (real.length || keepPrimary)));

  let primary = null;
  if (!keepPrimary) {
    primary = real[0] || primaries.find((a) => rest.includes(a)) || null;
    rest = rest.filter((a) => a !== primary);
  }

  const visible = new Set(rest.filter((a) => a.primary || a.pin));
  for (const a of rest) {
    if (visible.size >= MAX_VISIBLE) break;
    if (!a.group && !a.danger) visible.add(a);
  }
  let menu = rest.filter((a) => !visible.has(a));
  // A menu of one is just a hidden button.
  if (menu.length === 1 && !menu[0].danger) {
    visible.add(menu[0]);
    menu = [];
  }

  return { primary, visible: rest.filter((a) => visible.has(a)), menu, custom };
}

const ActionContent = ({ action }) => {
  const Icon = action.icon;
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className="truncate">{action.label}</span>
    </>
  );
};

/** An action as a toolbar button (`variant="default"` = the primary). */
export function ActionButton({ action, variant = "secondary" }) {
  const filled = variant === "default";
  const className = cn(
    "gap-1.5",
    filled && "text-primary-foreground hover:text-primary-foreground",
    action.danger && !filled && "text-destructive hover:text-destructive"
  );

  if (action.to) {
    return (
      <Link variant={variant} to={action.to} inModal={action.inModal} onSaved={action.onSaved} className={className} title={action.title}>
        <ActionContent action={action} />
      </Link>
    );
  }
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      disabled={action.disabled}
      title={action.title}
      onClick={(e) => action.onClick?.(e)}
    >
      <ActionContent action={action} />
    </Button>
  );
}

const runAction = (action) => (action.to ? loopar.navigate(action.to) : action.onClick?.(STUB_EVENT));

const MenuItem = ({ action, className }) => (
  <DropdownMenuItem
    disabled={action.disabled}
    onSelect={() => runAction(action)}
    className={cn("gap-2 [&_svg]:size-4", action.danger && "text-destructive focus:text-destructive", className)}
  >
    <ActionContent action={action} />
  </DropdownMenuItem>
);

/** Ungrouped first, then each group (in order of appearance), then the destructive ones. */
function menuSections(items) {
  const plain = [];
  const groups = new Map();
  const danger = [];
  for (const a of items) {
    if (a.danger) danger.push(a);
    else if (a.group) groups.set(a.group, [...(groups.get(a.group) || []), a]);
    else plain.push(a);
  }
  return [plain, ...groups.values(), danger].filter((s) => s.length);
}

/**
 * "Actions ▾": the overflow of the record's actions. On phones it also lists
 * the row's actions (the row hides them).
 */
function ActionsMenu({ menu, row }) {
  if (!menu.length && !row.length) return null;
  const sections = menuSections(menu);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className={cn("shrink-0 gap-1 px-3", !menu.length && "sm:hidden")}>
          {__("Actions")}
          <ChevronDownIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {row.map((a) => <MenuItem key={a.key} action={a} className="sm:hidden" />)}
        {row.length > 0 && sections.length > 0 && <DropdownMenuSeparator className="sm:hidden" />}
        {sections.map((section, i) => (
          <div key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {section.map((a) => <MenuItem key={a.key} action={a} />)}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const MenuEntries = ({ entries, className = "" }) => entries.map(([key, node]) => (
  <div key={key} className={cn("lp-toolbar-menu-item flex empty:hidden [&>*]:w-full [&>*]:justify-start", className)}>
    {node}
  </div>
));

/**
 * Header toolbar, left to right:
 *   row actions · Actions ▾ · custom controls · utilities · toggles · ⋯ · primary
 * - `actions`: planned view actions (planActions).
 * - `utilities`: `[key, node]` icon buttons (schedule, translations…): row on sm+, "⋯" on phones.
 * - `toggles`: `[key, node]` always in the row (print, record panel).
 * - `menu`: `[key, node]` document commands, always in "⋯" (rename…).
 * - `primary`: node, the only filled button.
 */
export function Toolbar({ actions, utilities = [], toggles = [], menu = [], primary = null, className = "" }) {
  const [open, setOpen] = useState(false);
  const { visible = [], menu: overflow = [], custom = [] } = actions || {};
  const customEntries = custom.map((a) => [a.key, a.render]);
  const phoneOnly = [...customEntries, ...utilities];
  const hasMenu = menu.length > 0;

  return (
    <div className={cn("lp-toolbar flex shrink-0 flex-row items-center gap-[6px]", className)}>
      {visible.map((a) => (
        <div key={a.key} className="lp-toolbar-item flex shrink-0 items-center max-sm:hidden">
          <ActionButton action={a} />
        </div>
      ))}

      <ActionsMenu menu={overflow} row={visible} />

      {phoneOnly.map(([key, node]) => (
        <div key={key} className="lp-toolbar-item flex shrink-0 items-center empty:hidden max-sm:hidden">
          {node}
        </div>
      ))}

      {toggles.map(([key, node]) => (
        <div key={key} className="flex shrink-0 items-center empty:hidden">{node}</div>
      ))}

      {(hasMenu || phoneOnly.length > 0) && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              className={cn("shrink-0 px-2", !hasMenu && "sm:hidden")}
              aria-label={__("More")}
              title={__("More")}
            >
              <MoreHorizontalIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-auto min-w-48 flex-col items-stretch gap-1 p-1"
            onClick={(e) => { if (e.target.closest?.("button, a")) setOpen(false); }}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <MenuEntries entries={phoneOnly} className="sm:hidden" />
            {hasMenu && phoneOnly.length > 0 && <div role="separator" className="my-1 h-px bg-border sm:hidden" />}
            <MenuEntries entries={menu} />
          </PopoverContent>
        </Popover>
      )}

      {primary && <div className="flex shrink-0 flex-row items-center gap-[6px] empty:hidden">{primary}</div>}
    </div>
  );
}
