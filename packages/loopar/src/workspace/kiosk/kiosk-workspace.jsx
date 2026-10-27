import BaseWorkspace from "@workspace/base/base-workspace";
import { useWorkspace } from "@workspace/workspace-provider";
import { getImage } from "@@file/file-manager";
import { ThemeToggle } from "@workspace/theme-toggle";

/** The app's logo (light/dark), not a link: a kiosk never leaves its page. */
function KioskLogo({ webApp }) {
  const logo = (field) => getImage(webApp, field);
  return (
    <div className="flex items-center">
      <img alt={webApp.name || ""} src={logo("logo")} className="h-10 w-auto dark:hidden" />
      <img alt={webApp.name || ""} src={logo("logo_dark")} className="hidden h-10 w-auto dark:block" />
    </div>
  );
}

/**
 * Kiosk workspace: a web app page on a shared device (a station tablet, a
 * check-in screen) — the app's logo and the page, no site navigation, no
 * footer. The page authenticates the device itself (see WORKSPACE_CAPABILITIES).
 */
export default function KioskWorkspace() {
  const { ActiveView, __META__ } = useWorkspace();
  const webApp = __META__.web_app || {};
  const activePage = __META__.Document?.Entity?.name;

  return (
    <BaseWorkspace activePage={activePage} webApp={webApp}>
      <div className="flex min-h-dvh flex-col bg-background">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-2 sm:px-6">
          <KioskLogo webApp={webApp} />
          <ThemeToggle />
        </header>
        <main className="flex-1">{ActiveView}</main>
      </div>
    </BaseWorkspace>
  );
}
