import { useEffect, useState } from "react";
import { XIcon, ArrowRightIcon } from "lucide-react";
import { cn } from "@cn/lib/utils";

/** Cookie of the announcement a visitor closed (read by the server too). */
const CLOSED_COOKIE = "loopar_announcement_closed";

/** Height reserved for the bar: the header and the page offset add it. */
export const ANNOUNCEMENT_HEIGHT = "2.5rem";

const VARIANTS = {
  primary: { bar: "bg-primary text-primary-foreground", headline: "opacity-80", link: "underline-offset-4 hover:underline" },
  accent: { bar: "bg-accent text-accent-foreground", headline: "text-primary", link: "text-primary underline-offset-4 hover:underline" },
  neutral: { bar: "bg-muted text-foreground", headline: "text-primary", link: "text-primary underline-offset-4 hover:underline" },
};

/**
 * Hides once the page leaves the top (and comes back at the top): the header
 * slides up by the bar's height, the page doesn't move. Starts visible, as the
 * server rendered it.
 */
export function useAnnouncementScroll(enabled) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled]);
  return scrolled;
}

/**
 * The site's announcement (Web module → Announcement): headline on every
 * screen, message on wide ones, an optional link and close button.
 */
export function AnnouncementBar({ announcement, onClose }) {
  const variant = VARIANTS[announcement.variant] || VARIANTS.primary;
  const external = /^https?:\/\//i.test(announcement.link_url || "");

  const close = () => {
    document.cookie = `${CLOSED_COOKIE}=${encodeURIComponent(announcement.name)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    onClose?.();
  };

  return (
    <div
      role="region"
      aria-label="Announcement"
      className={cn("relative flex items-center justify-center px-10 text-xs sm:text-sm", variant.bar)}
      style={{ height: ANNOUNCEMENT_HEIGHT }}
    >
      <p className="truncate text-center">
        <span className={cn("font-semibold uppercase tracking-[0.12em]", variant.headline)}>{announcement.headline}</span>
        {announcement.message ? <span className="hidden md:inline"><span className="mx-3 opacity-50">·</span>{announcement.message}</span> : null}
        {announcement.link_url ? (
          <a
            href={announcement.link_url}
            className={cn("ml-3 inline-flex items-center gap-1 font-medium", variant.link)}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {announcement.link_label || "Learn more"}
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </p>
      {announcement.dismissible ? (
        <button
          type="button"
          onClick={close}
          aria-label="Close announcement"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 opacity-70 hover:opacity-100"
        >
          <XIcon className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
