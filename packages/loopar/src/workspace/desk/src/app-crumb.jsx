import { ChevronsUpDownIcon } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { useWorkspace } from "@workspace/workspace-provider";
import { Link } from "@link";
import { __ } from "@global/i18n";
import { AppIcon, AppMenuItems, appLabel, homePath, useActiveApp, useCloseOnNavigate } from "./side-nav";

const CRUMB = "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground";

/**
 * First crumb of the desk trail: the active app — same name as its rail
 * label — doubling as the app selector (Vercel/Linear pattern). The active
 * document puts the rest of the trail after it (#desk-trail).
 */
export function AppCrumb() {
  const { __META__ } = useWorkspace();
  const apps = (Array.isArray(__META__?.menu_data) ? __META__.menu_data : []).filter(app => app.modules?.length);
  const activeApp = useActiveApp(apps);
  const [open, setOpen] = useCloseOnNavigate();
  if (!activeApp) return null;

  const label = (
    <>
      <AppIcon app={activeApp} className="h-4 w-4 shrink-0" />
      <span className="truncate">{__(appLabel(activeApp))}</span>
    </>
  );

  if (apps.length < 2) {
    return <Link award={false} bare to={homePath(activeApp)} title={__(activeApp.description)} className={CRUMB}>{label}</Link>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title={__(activeApp.description)} aria-label={__("Switch app")} className={CRUMB}>
          {label}
          <ChevronsUpDownIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-72 overflow-y-auto p-1">
        <AppMenuItems apps={apps} activeApp={activeApp} detailed />
      </PopoverContent>
    </Popover>
  );
}
