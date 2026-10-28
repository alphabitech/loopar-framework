import { ListLayout } from '@loopar/list';
import loopar from "loopar";
import { Card } from '@card';
import { Link } from "@link";
import { useTable } from "@@table/TableContext";
import { Checkbox } from "@cn/components/ui/checkbox";
import { cn } from "@cn/lib/utils";
import {
  BoxIcon,
  BlocksIcon,
  BrushIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  MailIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  PrinterIcon,
  SlidersHorizontalIcon,
  TextCursorInputIcon,
} from 'lucide-react';

/** Avatar icon per document type (what the card opens). */
const TYPE_ICONS = {
  "Entity": DatabaseIcon,
  "Builder": BlocksIcon,
  "Page Builder": FileTextIcon,
  "View Builder": LayoutDashboardIcon,
  "Form Builder": TextCursorInputIcon,
  "Controller Builder": CodeIcon,
  "Print Format Builder": PrinterIcon,
  "Contact Form Builder": MailIcon,
  "Desk Page Builder": PanelsTopLeftIcon,
};

/** Types whose records live in their own table (list / create make sense). */
const DATA_TYPES = ["Entity", "Builder", "Contact Form Builder"];

const isTrue = (v) => v === 1 || v === true || v === "1";

/** Where the card leads: the records (list, or the single form) or the rendered page. */
function destinationOf(row, type) {
  if (row.name === "File Manager") return "list";
  if (["Page Builder", "View Builder"].includes(type)) return "view";
  if (DATA_TYPES.includes(type) || row.build) return isTrue(row.is_single) ? "update" : "list";
  return "";
}

const Chip = ({ children, className = "" }) => (
  <span className={cn("inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground", className)}>
    {children}
  </span>
);

const IconLink = ({ to, title, children }) => (
  <Link
    to={to}
    variant="ghost"
    title={title}
    aria-label={title}
    className="h-8 w-8 justify-center p-0 text-muted-foreground hover:text-foreground [&>svg]:h-4 [&>svg]:w-4"
  >
    {children}
  </Link>
);

function CardTemplate({ row }) {
  const { selectRow, selectedRows, Document } = useTable();
  const listedEntity = Document?.Entity?.name;
  // Module pages list several types (rows carry `type`); Entity/Builder lists are their own type.
  const type = row.type || listedEntity || "Entity";
  const inModule = listedEntity === "Module";

  // Child entities are edited only inside their parent's form: the card opens the definition.
  const isChild = isTrue(row.is_child);
  const isSingle = isTrue(row.is_single);
  const action = isChild ? "" : destinationOf(row, type);

  const name = encodeURIComponent(row.name);
  const definitionUrl = `/desk/${type}/update?name=${name}`;
  const openUrl = !action ? definitionUrl
    : action === "view" ? `/desk/${row.name}/view?name=${name}`
    : `/desk/${row.name}/${action}`;
  const canCreate = !isChild && !isSingle && (DATA_TYPES.includes(type) || !!row.build);

  const selected = selectedRows.includes(row.name);
  const Icon = (type === "Entity" && isSingle) ? SlidersHorizontalIcon : (TYPE_ICONS[type] || BoxIcon);

  const records = row.__records__;
  const subtitle = records != null
    ? `${records} ${records === 1 ? "record" : "records"}`
    : (!inModule && row.module) || null;

  const chips = [
    isSingle && type === "Entity" && "Single",
    isChild && "Child",
    isTrue(row.is_static) && "Static",
    isTrue(row.is_virtual) && "Virtual",
  ].filter(Boolean);

  return (
    <Card
      className={cn(
        "group relative flex h-full min-w-0 flex-col p-4 transition-colors hover:border-foreground/25 hover:bg-accent/30",
        selected && "border-primary/60 ring-1 ring-primary/40"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-white ring-1 ring-inset ring-white/10"
          style={{ backgroundColor: loopar.bgColor(row.name) }}
        >
          <Icon className="h-5 w-5" />
          {/* Above the card's stretched link so selecting doesn't navigate. */}
          <span
            className={cn(
              "absolute -left-1.5 -top-1.5 z-10 rounded bg-card transition-opacity",
              selected ? "opacity-100" : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100"
            )}
          >
            <Checkbox className="h-4 w-4" checked={selected} onCheckedChange={(checked) => selectRow(row, checked)} aria-label={`Select ${row.name}`} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* The whole card is the link (::after covers it); secondary actions sit above it. */}
          <Link
            to={openUrl}
            bare
            className="block truncate font-medium leading-tight text-foreground after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
          >
            {row.name}
          </Link>
          {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>

        <div className="relative z-10 -mr-2 -mt-1 flex flex-shrink-0 items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100">
          {canCreate && (
            <IconLink to={`/desk/${row.name}/create`} title={`New ${row.name}`}><PlusIcon /></IconLink>
          )}
          <IconLink to={definitionUrl} title="Edit definition"><BrushIcon /></IconLink>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((c) => <Chip key={c}>{c}</Chip>)}
        </div>
      )}
    </Card>
  );
}

export const gridTemplate = (row) => <CardTemplate row={row} />;

/** Entity-like lists (Entity, Module, Builder): compact launcher cards. */
export default function EntityList(opts) {
  return <ListLayout gridTemplate={gridTemplate} gridMinWidth="17rem" {...opts} />;
}
