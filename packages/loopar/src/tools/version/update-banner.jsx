/**
 * "A new version is available" — non-blocking, never forced.
 *
 * Shown once versionWatch sees a newer build. "Reload" goes through
 * versionWatch.reload(), which flushes every open form's unsaved work to the
 * draft store first, so the user lands on the new version with their changes
 * restored. "Later" hides it until the next deploy; the next navigation will
 * pick up the new version anyway (see workspace-provider).
 */
import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { versionWatch } from "./version-watch.js";

export function UpdateBanner() {
  const [latest, setLatest] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  useEffect(() => {
    const offOutdated = versionWatch.onOutdated(({ latest }) => setLatest(latest));
    const offCurrent = versionWatch.onCurrent(() => setLatest(null));
    return () => { offOutdated(); offCurrent(); };
  }, []);

  if (!latest || dismissed === latest) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4 pointer-events-none"
    >
      <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg">
        <RefreshCw className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="flex-1 leading-snug">
          <p className="font-medium">A new version is available.</p>
          <p className="text-muted-foreground">Reload to update — any unsaved changes will be kept.</p>
        </div>
        <Button size="sm" onClick={() => versionWatch.reload(undefined, "update")}>
          Reload
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Dismiss"
          onClick={() => setDismissed(latest)}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export default UpdateBanner;
