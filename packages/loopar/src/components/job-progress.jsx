'use strict';

import loopar, { useRealtime, __ } from "loopar";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { CheckCircle2Icon, CheckIcon, Loader2Icon, TriangleAlertIcon, XCircleIcon, XIcon } from "lucide-react";
import { LoopSocket } from "@services/realtime/LoopSocket";

/**
 * Following a background job (core/jobs) from the browser. The server sends
 * the job's state and new log lines to `user:<me>` (action `job`); the full
 * log is read once from the entity's `job` action.
 *
 *   useJobEvents(handler)                    every job event of this user
 *   <JobProgress job={job} entity="App Manager" />
 *   openJobProgress(job, { entity })         the same, in a dialog that can be
 *                                            closed: the job keeps running
 *
 * Realtime is the fast path. While a job is active its state is also read
 * from the server: every few seconds when the socket is down (or there is no
 * user to route events to, as in the setup wizard), and only after a long
 * silence when it is up (a socket connected but not in the room).
 * `endpoint`: where to read the job — { entity, action } (default action "job").
 */

const POLL_MS = 2000;
const QUIET_MS = 2500;
const QUIET_CONNECTED_MS = 8000;

/** Should a follower read the job from the server now? */
export function shouldPoll(lastEventAt, { realtime = true } = {}) {
  const quiet = Date.now() - (lastEventAt || 0);
  if (!realtime || !LoopSocket.connected) return true;
  return quiet >= QUIET_CONNECTED_MS;
}

const ACTIVE = ["queued", "running"];
export const isActiveJob = (job) => !!job && ACTIVE.includes(job.state);

const userChannel = () => (typeof window !== "undefined" && window.__user__ ? `user:${window.__user__}:job` : null);

/** Every job event of the signed-in user (null handler = not listening). */
export function useJobEvents(handler) {
  useRealtime(userChannel(), handler);
}

/** One job, kept up to date: the initial read plus the realtime events. */
export function useJob(initial, { entity, action = "job", realtime = true } = {}) {
  const [job, setJob] = useState(initial || null);
  const id = initial?.id;
  const jobRef = useRef(job);
  jobRef.current = job;
  const lastEvent = useRef(0);

  useEffect(() => {
    if (!id || !entity) return;
    let alive = true;
    // The server's copy is complete (state + whole log): it replaces ours.
    // Silent: a poll that fails (a busy server mid-install) just tries again.
    const read = () => loopar.call(entity, action, { query: { id }, freeze: false, notifyError: false })
      .then((r) => { if (alive && r?.job) setJob((prev) => ({ ...prev, ...r.job })); })
      .catch((e) => {
        // The server no longer knows the job (the core restarted while it
        // ran): it won't report again, so stop waiting for it.
        if (!alive || (e?.code ?? e?.status) !== 404) return;
        setJob((prev) => isActiveJob(prev)
          ? { ...prev, state: "failed", error: __("The job was interrupted: the server restarted while it ran.") }
          : prev);
      });

    read();
    const timer = setInterval(() => {
      if (!isActiveJob(jobRef.current)) return;
      if (Date.now() - lastEvent.current < QUIET_MS) return;
      if (shouldPoll(lastEvent.current, { realtime })) read();
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [id, entity, action, realtime]);

  useJobEvents((event) => {
    if (!event || event.id !== id) return;
    lastEvent.current = Date.now();
    setJob((prev) => {
      const { lines = [], ...state } = event;
      return { ...(prev || {}), ...state, log: [...(prev?.log || []), ...lines] };
    });
  });

  return job;
}

/** "6.2 s" / "1 min 4 s", or null without both ends. */
function formatDuration(start, end) {
  if (!start || !end || end < start) return null;
  const s = (end - start) / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const LEVEL_CLASS = {
  step: "text-foreground font-medium",
  warn: "text-amber-500",
  error: "text-red-500",
  info: "text-foreground/80",
};

/**
 * A log line's mark: what is done reads as done. The step still running (the
 * last one while the job is active) spins; finished steps and done items get
 * a check; warnings and errors their own sign.
 */
function LineMark({ line, running, failedHere }) {
  const cls = "mt-[3px] h-3 w-3 flex-shrink-0";
  if (line.level === "error" || failedHere) return <XIcon className={cn(cls, "text-red-500")} />;
  if (line.level === "warn") return <TriangleAlertIcon className={cn(cls, "text-amber-500")} />;
  if (running) return <Loader2Icon className={cn(cls, "animate-spin text-primary")} />;
  return <CheckIcon className={cn(cls, line.level === "step" ? "text-emerald-500" : "text-emerald-500/70")} />;
}

export function JobProgress({ job: initial, entity, action, realtime, closable = true, onEnd }) {
  const job = useJob(initial, { entity, action, realtime }) || initial || {};
  const logRef = useRef(null);
  const log = job.log || [];

  // Once, when the job ends (the page decides what comes next).
  const ended = useRef(false);
  useEffect(() => {
    if (ended.current || !job.state || isActiveJob(job)) return;
    ended.current = true;
    onEnd?.(job);
  }, [job.state]);

  // Follow the end of the log unless the user scrolled up to read. Whether to
  // follow is decided on scroll (before new lines grow the box), so a burst
  // of lines can't push the bottom out of reach.
  const follow = useRef(true);
  const onLogScroll = (e) => {
    const el = e.currentTarget;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const lastLine = log[log.length - 1];
  // The step in progress (or the one that failed): the last step line.
  const lastStepIndex = log.findLastIndex((line) => line.level === "step");
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log.length, lastLine]);

  const { done = 0, total = 0, label } = job.progress || {};
  const active = isActiveJob(job);
  const failed = job.state === "failed";
  const completed = job.state === "completed";
  // Overall percent from the server (phases); a bare counter otherwise.
  const percent = completed || failed ? 100
    : job.percent != null ? job.percent
    : total ? Math.min(99, Math.round((done / total) * 100))
    // Queued / just started: an empty bar, never a guess that later goes back.
    : 0;

  const duration = formatDuration(job.startedAt, job.finishedAt);

  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center gap-2 text-sm">
        {active && <Loader2Icon className="h-4 w-4 flex-shrink-0 animate-spin text-primary" />}
        {completed && <CheckCircle2Icon className="h-4 w-4 flex-shrink-0 text-emerald-500" />}
        {failed && <XCircleIcon className="h-4 w-4 flex-shrink-0 text-red-500" />}
        <span className={cn("min-w-0 flex-1 truncate", failed && "text-red-500")}>
          {failed ? __("Failed") : completed ? __("Finished") : (job.step || __("Starting…"))}
        </span>
        {active && <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">{percent}%</span>}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            failed ? "bg-red-500" : completed ? "bg-emerald-500" : "bg-primary",
            // Steps without a counter (snapshot, rebuild…) keep pulsing.
            active && !job.progress && "animate-pulse"
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {active && label && (
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={label}>
          {done}/{total} · {label}
        </p>
      )}

      <div
        ref={logRef}
        onScroll={onLogScroll}
        className="max-h-72 min-h-24 overflow-y-auto rounded-md border bg-black/30 p-2 font-mono text-[11px] leading-relaxed"
      >
        {log.length === 0
          ? <span className="text-muted-foreground">{__("Waiting for the first steps…")}</span>
          : log.map((line, i) => {
            const isLastStep = i === lastStepIndex;
            return (
              <div key={i} className={cn("flex items-start gap-1.5", LEVEL_CLASS[line.level] || LEVEL_CLASS.info)}>
                <LineMark line={line} running={active && isLastStep} failedHere={failed && isLastStep} />
                <span className="min-w-0 whitespace-pre-wrap break-words">{line.message}</span>
              </div>
            );
          })}
      </div>

      {/* The outcome, impossible to miss: the log above is the detail. */}
      {completed && (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 animate-in fade-in-0 slide-in-from-bottom-1">
          <CheckCircle2Icon className="h-6 w-6 flex-shrink-0 text-emerald-500" />
          <div className="min-w-0">
            <p className="font-medium text-emerald-600 dark:text-emerald-400">
              {__("{0} completed", [job.title || __("Job")])}
            </p>
            {duration && <p className="text-xs text-muted-foreground">{__("Took {0}", [duration])}</p>}
          </div>
        </div>
      )}
      {failed && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 animate-in fade-in-0 slide-in-from-bottom-1">
          <XCircleIcon className="mt-0.5 h-6 w-6 flex-shrink-0 text-red-500" />
          <div className="min-w-0">
            <p className="font-medium text-red-600 dark:text-red-400">{__("{0} failed", [job.title || __("Job")])}</p>
            {job.error && <p className="break-words text-xs text-muted-foreground">{job.error}</p>}
            {job.errorLink?.to && (
              <Link to={job.errorLink.to} variant="outline" size="sm" className="mt-2 h-7 px-2 text-xs">
                {__(job.errorLink.label)}
              </Link>
            )}
          </div>
        </div>
      )}

      {active && closable && (
        <p className="text-xs text-muted-foreground">
          {__("You can close this window: the job keeps running and you'll be notified when it ends.")}
        </p>
      )}
    </div>
  );
}

/** The job's progress in a dialog; closing it leaves the job running. */
export function openJobProgress(job, { entity } = {}) {
  if (!job?.id) return;
  loopar.dialog({
    id: `job-${job.id}`,
    title: job.title || __("Background job"),
    size: "lg",
    content: <JobProgress job={job} entity={entity} />,
    buttons: [{ name: "close", text: __("Close"), variant: "secondary", dismiss: true, onClick: () => {} }],
  });
}
