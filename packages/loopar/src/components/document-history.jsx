import { useState, useEffect, useCallback, useMemo } from "react";
import { loopar } from "loopar";
import { useWorkspace } from "@workspace/workspace-provider";
import { useCaptcha, CaptchaSlot } from "./captcha-widget";
import {
  Plus, Pencil, Trash2, RotateCcw, MessageSquare,
  Check, X, Clock, Send, Loader2, ChevronDown, ChevronUp,
  LogIn, CornerDownRight,
} from "lucide-react";
import { __ } from "@global/i18n";
import { formatDateTime } from "@global/format";

const HISTORY_DOC = "Document History";
const STATUS = Object.freeze({ ACTIVE: 1, PENDING: 4, APPROVED: 5, REJECTED: 6 });

const ICON_BY_ACTION = {
  Created: Plus, Updated: Pencil, Deleted: Trash2, Restored: RotateCcw, Commented: MessageSquare,
};

function formatDate(value) {
  return value ? formatDateTime(value, "medium") : "";
}

function initials(name = "") {
  return String(name).split(/\s+/).map(w => w[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "?";
}

function parseDiff(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj === "object" ? Object.entries(obj) : null;
  } catch { return null; }
}

function preview(v) {
  if (v === null || v === undefined || v === "") return "∅";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 50 ? `${s.slice(0, 50)}…` : s;
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8 text-muted-foreground" aria-busy="true">
      <Loader2 className="w-5 h-5 animate-spin opacity-70" />
    </div>
  );
}

function Avatar({ name, className = "" }) {
  return (
    <span className={`flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500/80 text-white text-xs font-medium shrink-0 ${className}`}>
      {initials(name)}
    </span>
  );
}

function SignInPrompt() {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-4 flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-muted-foreground">{__("Sign in to join the conversation.")}</p>
      <a href="/auth/login" className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity">
        <LogIn className="w-4 h-4" /> {__("Sign in")}
      </a>
    </div>
  );
}

function Composer({ onSubmit, submitting, guestIdentity = false, loggedInName = null, compact = false, autoFocus = false, placeholder = "Write a comment…", onCancel }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Anti-bot check applies to guests only; logged-in users proved themselves
  // at login. With no captcha integration enabled, this is all a no-op.
  const ts = useCaptcha();
  const verificationMissing = guestIdentity && ts.required && !ts.token;

  const identityMissing = guestIdentity && (!name.trim() || !email.trim());
  const send = async () => {
    const value = text.trim();
    if (!value || submitting || identityMissing || verificationMissing) return;
    const identity = guestIdentity
      ? { guest_name: name.trim(), guest_email: email.trim(), captcha_token: ts.token }
      : null;
    const ok = await onSubmit(value, identity);
    if (ok) setText("");
    if (guestIdentity) ts.reset();
  };

  const inputCls = "w-full h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="flex flex-col gap-2">
      {loggedInName && !compact && (
        <p className="text-xs text-muted-foreground">{__("Commenting as")} <span className="font-medium text-foreground">{loggedInName}</span></p>
      )}
      {guestIdentity && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input className={inputCls} placeholder={__("Your name")} value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} />
          <input type="email" className={inputCls} placeholder={__("Your email")} value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} />
        </div>
      )}
      <textarea
        className={`w-full rounded-md border border-border bg-background p-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-primary ${compact ? "min-h-14" : "min-h-20"}`}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        disabled={submitting}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      {guestIdentity && <CaptchaSlot captcha={ts} />}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting} className="px-3 h-8 rounded-md text-sm text-muted-foreground hover:text-foreground">{__("Cancel")}</button>
        )}
        <button
          type="button" onClick={send} disabled={submitting || !text.trim() || identityMissing || verificationMissing}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {compact ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const s = Number(status);
  if (s === STATUS.PENDING) return <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px]"><Clock className="w-2.5 h-2.5" /> {__("Pending")}</span>;
  if (s === STATUS.REJECTED) return <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full bg-red-500/15 text-red-600 text-[10px]">{__("Rejected")}</span>;
  return null;
}

/** A comment card + its (recursive) reply tree. */
function CommentNode({ node, ctx, depth = 0 }) {
  const { childrenOf, canComment, canModerate, activeKey, setActiveKey, composerProps, onModerate, moderatingName } = ctx;
  const key = `c:${node.name}`;
  const isPending = Number(node.status) === STATUS.PENDING;
  const indent = Math.min(depth, 5);

  return (
    <li className={indent ? "mt-3" : "mt-3"} style={indent ? { marginLeft: indent * 20 } : undefined}>
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-start gap-2">
          <Avatar name={node.user} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{node.user || "Guest"}</span>
              <span className="text-xs text-muted-foreground">{__("commented ·")} {formatDate(node.event_at)}</span>
              <StatusBadge status={node.status} />
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">{node.comment}</p>
            <div className="flex items-center gap-3 mt-2">
              {canComment && (
                <button type="button" onClick={() => setActiveKey(activeKey === key ? null : key)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <CornerDownRight className="w-3 h-3" /> {__("Reply")}
                </button>
              )}
              {canModerate && isPending && (
                <>
                  <button type="button" onClick={() => onModerate(node, STATUS.APPROVED)} disabled={moderatingName === node.name} className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-500 disabled:opacity-40">
                    {moderatingName === node.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {__("Approve")}
                  </button>
                  <button type="button" onClick={() => onModerate(node, STATUS.REJECTED)} disabled={moderatingName === node.name} className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-500 disabled:opacity-40">
                    <X className="w-3 h-3" /> {__("Reject")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeKey === key && (
        <div className="mt-2" style={{ marginLeft: 20 }}>
          <Composer
            {...composerProps}
            compact autoFocus
            placeholder={`Reply to ${node.user || "comment"}…`}
            onCancel={() => setActiveKey(null)}
            onSubmit={(text, identity) => composerProps.submit(text, identity, { parent: node.name, targetDocument: node.document, targetDocumentName: node.document_name })}
          />
        </div>
      )}

      <ul>
        {childrenOf(node.name).map(child => <CommentNode key={child.name} node={child} ctx={ctx} depth={depth + 1} />)}
      </ul>
    </li>
  );
}

function AuditNode({ node, ctx }) {
  const { canComment, eventCommentsOf, activeKey, setActiveKey, composerProps } = ctx;
  const Icon = ICON_BY_ACTION[node.action] || MessageSquare;
  const diff = parseDiff(node.diff);
  const key = `e:${node.name}`;
  const eventComments = eventCommentsOf(node.name);

  return (
    <li className="mt-3">
      <div className="flex items-start gap-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-secondary text-muted-foreground shrink-0 mt-0.5">
          <Icon className="w-3 h-3" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{node.user || "System"}</span> {(node.action || "").toLowerCase()} · {formatDate(node.event_at)}
          </p>
          {diff && diff.length > 0 && (
            <ul className="mt-0.5 space-y-0.5">
              {diff.map(([field, change]) => (
                <li key={field} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{field}</span>: <span className="line-through opacity-70">{preview(change?.before)}</span> → <span className="text-foreground">{preview(change?.after)}</span>
                </li>
              ))}
            </ul>
          )}
          {canComment && (
            <button type="button" onClick={() => setActiveKey(activeKey === key ? null : key)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1">
              <MessageSquare className="w-3 h-3" /> {__("Comment")}
            </button>
          )}
        </div>
      </div>

      {activeKey === key && (
        <div className="mt-2" style={{ marginLeft: 20 }}>
          <Composer
            {...composerProps}
            compact autoFocus
            placeholder={__("Comment on this change…")}
            onCancel={() => setActiveKey(null)}
            onSubmit={(text, identity) => composerProps.submit(text, identity, { parent: null, targetDocument: HISTORY_DOC, targetDocumentName: node.name })}
          />
        </div>
      )}

      {eventComments.length > 0 && (
        <ul style={{ marginLeft: 20 }}>
          {eventComments.map(c => <CommentNode key={c.name} node={c} ctx={ctx} depth={1} />)}
        </ul>
      )}
    </li>
  );
}

export default function DocumentHistory({
  document,
  documentName,
  enableHistory = false,
  enableComments = false,
  requireLogin = false,
  canModerate,
  guestIdentity,
  historyApi,
  commentApi,
  title,
  collapsible = false,
  defaultCollapsed = false,
  emptyMessage = "Nothing here yet.",
  className = "",
}) {
  const { user, workspace } = useWorkspace();
  const loggedIn = !!(user && user.name);
  const isWeb = workspace === "web";

  const commentsOnly = enableComments && !enableHistory;
  const canComment = enableComments;
  const effCanModerate = (canModerate ?? enableHistory) && !isWeb;
  const showGuestFields = enableComments && !loggedIn && !requireLogin;
  const showSignIn = enableComments && !loggedIn && requireLogin;
  const effGuestIdentity = guestIdentity ?? showGuestFields;
  const writeAction = commentApi?.action ?? "addComment";
  const heading = title ?? (commentsOnly ? "Comments" : "History");

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [moderatingName, setModeratingName] = useState(null);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [activeKey, setActiveKey] = useState(null);

  const load = useCallback(async () => {
    if (!document || !documentName) return;
    setLoading(true);
    setError("");
    try {
      // `document` is guaranteed here (guard above) — RPC straight to the
      // entity's controller (publicActionComments on BaseController).
      const res = await loopar.call(document, "comments", {
        query: { documentType: document, documentName },
        freeze: false,
      });
      setRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (e) {
      console.error("DocumentHistory load error:", e);
      setError(e?.message || "Could not load.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [document, documentName]);

  useEffect(() => { load(); }, [load]);

  // Post a comment. `opts` targets a reply (parent) or an event (targetDocument).
  const submit = useCallback(async (text, identity, opts = {}) => {
    setSubmitting(true);
    setNotice("");
    setError("");
    try {
      const options = {
        body: {
          documentType: document,
          documentName: opts.targetDocumentName || documentName,
          comment: text,
          ...(opts.parent ? { parent: opts.parent } : {}),
          ...(opts.targetDocument ? { document: opts.targetDocument } : {}),
          ...(identity || {}),
        },
        freeze: false,
      };

      await loopar.call(document, writeAction, options);

      setNotice(effGuestIdentity ? "Comment submitted — it will appear once approved." : "Comment submitted.");
      setActiveKey(null);
      await load();
      return true;
    } catch (e) {
      console.error("DocumentHistory comment error:", e);
      setError(e?.message || "Could not post comment.");
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [writeAction, document, documentName, load, effGuestIdentity]);

  const onModerate = useCallback(async (node, status) => {
    setModeratingName(node.name);
    try {
      // RPC to the entity's controller (actionModerate is inherited from
      // BaseController) — replaces the relative-URL sendAction pattern.
      await loopar.call(document, "moderate", { body: { name: node.name, status }, freeze: false });
      await load();
    } catch (e) {
      console.error("DocumentHistory moderate error:", e);
      setError(e?.message || "Could not moderate.");
    } finally {
      setModeratingName(null);
    }
  }, [document, load]);

  const { feed, childrenOf, eventCommentsOf } = useMemo(() => {
    const audit = rows.filter(r => r.action !== "Commented");
    const comments = rows.filter(r => r.action === "Commented");

    const childrenOf = (name) => comments
      .filter(c => c.parent === name)
      .sort((a, b) => new Date(a.event_at || 0) - new Date(b.event_at || 0));

    const eventCommentsOf = (eventName) => comments
      .filter(c => !c.parent && c.document === HISTORY_DOC && c.document_name === eventName)
      .sort((a, b) => new Date(a.event_at || 0) - new Date(b.event_at || 0));

    const rootRecordComments = comments.filter(c => !c.parent && c.document !== HISTORY_DOC);

    const feed = [...audit, ...rootRecordComments]
      .sort((a, b) => new Date(b.event_at || 0) - new Date(a.event_at || 0));

    return { feed, childrenOf, eventCommentsOf };
  }, [rows]);

  if (!enableHistory && !enableComments) return null;
  if (!document || !documentName) {
    return <div className="text-xs text-muted-foreground p-3">{__("DocumentHistory needs")} <code>document</code> {__("and")} <code>documentName</code>.</div>;
  }

  const ctx = {
    childrenOf, eventCommentsOf, canComment, canModerate: effCanModerate,
    activeKey, setActiveKey, onModerate, moderatingName,
    composerProps: { submit, submitting, guestIdentity: effGuestIdentity, loggedInName: loggedIn ? user.name : null },
  };

  return (
    <div className={`rounded-lg border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h5 className="text-sm font-semibold">{heading}</h5>
        {collapsible && (
          <button type="button" onClick={() => setCollapsed(c => !c)} className="text-muted-foreground hover:text-foreground" aria-label={collapsed ? "Expand" : "Collapse"}>
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="p-4">
          {canComment && (
            <div className="mb-4">
              {showSignIn ? <SignInPrompt /> : (
                <Composer
                  submit={submit}
                  onSubmit={(text, identity) => submit(text, identity, {})}
                  submitting={submitting}
                  guestIdentity={effGuestIdentity}
                  loggedInName={loggedIn ? user.name : null}
                />
              )}
            </div>
          )}
          {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-3">{notice}</p>}
          {error && <p className="text-xs text-destructive mb-3">{error}</p>}

          {loading ? <Spinner /> : feed.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{emptyMessage}</p>
          ) : (
            <ul>
              {feed.map(node => node.action === "Commented"
                ? <CommentNode key={node.name} node={node} ctx={ctx} depth={0} />
                : <AuditNode key={node.name} node={node} ctx={ctx} />
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}