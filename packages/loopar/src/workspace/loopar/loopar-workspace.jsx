import BaseWorkspace from "@workspace/base/base-workspace";
import { Link } from "@link";
import { ArrowRightIcon } from "@radix-ui/react-icons";
import { useWorkspace } from "@workspace/workspace-provider";
import { AuthBackdrop } from "../auth/auth-workspace";
import { __ } from "@global/i18n";

/**
 * System pages (install wizard, update): one wide card centered over the
 * auth backdrop. The wizard needs the width the login panel doesn't have.
 */
function SetupLayout({ children }) {
  return (
    <div className="vaul-drawer-wrapper relative min-h-dvh">
      <meta name="robots" content="noindex, nofollow" />
      <AuthBackdrop className="fixed inset-0 bg-purple-900/5 z-0" />
      <main className="relative z-10 flex min-h-dvh items-start justify-center px-4 py-6 sm:items-center sm:px-8 sm:py-12">
        <div className="w-full max-w-3xl rounded-xl border bg-background/85 shadow-lg backdrop-blur-sm p-5 sm:p-10">
          <div className="mb-6 flex justify-center sm:mb-8">
            <img src="/assets/public/images/loopar.svg" alt="loopar" style={{ height: 28, width: 140 }} />
          </div>
          {children}
        </div>
      </main>
      <div className="relative z-10 pb-6 text-center">
        <Link variant="ghost" className="text-sm text-muted-foreground" _target="_blank" to="https://loopar.build/Doc">
          <ArrowRightIcon className="mr-2" />
          {__("Documentation")}
        </Link>
      </div>
    </div>
  );
}

export default function LooparWorkspace() {
  const { ActiveView } = useWorkspace();

  return (
    <BaseWorkspace>
      <SetupLayout>{ActiveView}</SetupLayout>
    </BaseWorkspace>
  );
}
