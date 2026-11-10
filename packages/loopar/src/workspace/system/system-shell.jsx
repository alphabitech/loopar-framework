import { Link } from "@link";
import { ArrowRightIcon } from "@radix-ui/react-icons";
import Particles from "@particles";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

const PARTICLES = {
  "particles_settings": JSON.stringify({
    "particles.number.value": 6,
    "particles.shape.type": "square",
    "particles.opacity.value.max": 0.31,
    "particles.size.value.min": 10,
    "particles.size.value.max": 1000,
    "particles.paint.color.value": "#433271",
    "particles.move.enable": true,
    "particles.move.speed.min": 1,
    "particles.move.speed.max": 3,
    "particles.move.random": true,
    "particles.links.enable": false,
  }),
  key: "authparticlessettings"
};

/** The animated background of the auth and setup pages. */
export function AuthBackdrop({ className, children }) {
  return (
    <Particles fullScreen={false} className={className} data={PARTICLES}>
      {children}
    </Particles>
  );
}

/** Title + description on top of a system page step (auth, install wizard). */
export function SystemHeader({ title, description, className }) {
  return (
    <header className={cn("mb-2 space-y-1 text-center", className)}>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}

const WIDTHS = {
  md: "max-w-md",
  "3xl": "max-w-3xl",
};

/**
 * Shared frame of every system page (login, password recovery, 2FA, install
 * wizard, update): one card centered over the auth backdrop, logo on top and
 * the documentation link below. Only the card width changes per workspace.
 */
export default function SystemShell({ width = "md", children }) {
  return (
    <div className="vaul-drawer-wrapper relative min-h-dvh">
      <meta name="robots" content="noindex, nofollow" />
      <AuthBackdrop className="fixed inset-0 bg-purple-900/5 z-0" />
      <main className="relative z-10 flex min-h-dvh flex-col items-center justify-start px-4 py-6 sm:justify-center sm:px-8 sm:py-12">
        <div className={cn("w-full rounded-xl border bg-background/85 shadow-lg backdrop-blur-sm p-5 sm:p-8", WIDTHS[width] || width)}>
          <div className="mb-6 flex justify-center">
            <img src="/assets/public/images/loopar.svg" alt="loopar" style={{ height: 28, width: 140 }} />
          </div>
          {children}
        </div>
        <Link variant="ghost" className="mt-4 text-sm text-muted-foreground" _target="_blank" to="https://loopar.build/Doc">
          <ArrowRightIcon className="mr-2" />
          {__("Documentation")}
        </Link>
      </main>
    </div>
  );
}
