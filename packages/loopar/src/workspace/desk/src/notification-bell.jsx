import { useCallback, useEffect, useState } from "react";
import { loopar, useRealtime } from "loopar";
import { Link } from "@link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { BellIcon } from "lucide-react";
import { __ } from "@global/i18n";
import { useWorkspace } from "@workspace/workspace-provider";

/**
 * Notifications of the signed-in user (desk header): what others did on the
 * user's records — a customer approved a quote, someone commented, a
 * workflow moved. Loaded once, then followed live on the user's realtime
 * room (`user:<name>`, event `notification`) — no polling.
 */
const ago = (iso) => {
  const t = new Date(String(iso || "").replace(" ", "T")).getTime();
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return __("now");
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const linkOf = (n) => (n.document && n.document_name
  ? `/desk/${n.document}/update?name=${encodeURIComponent(n.document_name)}`
  : null);

export function NotificationBell() {
  const { user: session } = useWorkspace();
  // The realtime room is named after the user (same id the server stamps: userId || name).
  const user = session?.userId || session?.name || null;
  const [state, setState] = useState(null);

  const load = useCallback(() => {
    loopar.call("Notification", "mine", { query: { limit: 20 }, freeze: false, notifyError: false })
      .then((r) => r && Array.isArray(r.items) && setState({ unread: Number(r.unread) || 0, items: r.items }))
      .catch(() => setState(null));
  }, []);

  useEffect(() => { if (user) load(); }, [user, load]);

  useRealtime(user ? `user:${user}:notification` : null, (n = {}) => {
    loopar.notify(n.subject || __("New notification"), "info");
    setState((s) => {
      const items = (s?.items || []).filter((i) => i.name !== n.name);
      return { unread: (s?.unread || 0) + (n.coalesced ? 0 : 1), items: [{ ...n, is_read: 0 }, ...items].slice(0, 20) };
    });
  });

  const markRead = (body) => loopar.call("Notification", "markRead", { body, freeze: false, notifyError: false })
    .then(() => setState((s) => s && {
      unread: body.all ? 0 : Math.max(0, s.unread - (body.names || []).length),
      items: s.items.map((i) => (body.all || (body.names || []).includes(i.name) ? { ...i, is_read: 1 } : i)),
    }))
    .catch(() => {});

  if (!user || !state) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={__("Notifications")} className="relative inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent">
          <BellIcon className="h-4 w-4" />
          {state.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {state.unread > 99 ? "99+" : state.unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[24rem] bg-card p-1">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{__("Notifications")}</span>
          {state.unread > 0 && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => markRead({ all: 1 })}>
              {__("Mark all as read")}
            </button>
          )}
        </div>
        <div className="max-h-[26rem] overflow-y-auto">
          {state.items.map((n) => {
            const to = linkOf(n);
            const body = (
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!Number(n.is_read) && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                  <span className="truncate text-sm font-medium text-foreground">{n.subject}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{ago(n.created_at)}</span>
                </div>
                {n.message && <div className="line-clamp-2 text-xs text-muted-foreground">{n.message}</div>}
              </div>
            );
            const read = () => !Number(n.is_read) && markRead({ names: [n.name] });
            return to ? (
              <Link key={n.name} to={to} variant="ghost" onClick={read} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent">
                {body}
              </Link>
            ) : (
              <div key={n.name} onClick={read} className="flex w-full items-start gap-2 rounded px-2 py-1.5 hover:bg-accent">{body}</div>
            );
          })}
          {!state.items.length && <div className="px-2 py-3 text-xs text-muted-foreground">{__("No notifications yet.")}</div>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
