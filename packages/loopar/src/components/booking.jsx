import { useEffect, useMemo, useRef, useState } from "react";
import loopar from "loopar";
import { CalendarCheckIcon, ChevronLeftIcon, ChevronRightIcon, Loader2 } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";
import { useCaptcha, CaptchaSlot } from "./captcha-widget";
import { rootProps } from "./base/content-lines.js";
import { addDays } from "@global/calendar";
import { __ } from "@global/i18n";

/**
 * Public booking: a visitor picks a duration, a day and a free time of a
 * Calendar's business hours and leaves their contact; the booking becomes an
 * Event of that calendar (`Calendar/booking`, `slots`, `book`). Times are the
 * business's own clock.
 */

const PAGE = 7;
const utc = (day) => new Date(`${day}T00:00:00Z`);
const dayLabel = (day, options) => new Intl.DateTimeFormat(loopar.language || undefined, { timeZone: "UTC", ...options }).format(utc(day));
/** `HH:mm` in the visitor's own format (12 or 24 hours). */
const timeLabel = (time) => new Intl.DateTimeFormat(loopar.language || undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(`2000-01-01T${time}:00Z`));
const durationLabel = (minutes) => (minutes % 60 === 0 ? __("{0} h", [minutes / 60]) : __("{0} min", [minutes]));

const field = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const chip = (active) => cn(
  "rounded-md border px-3 py-1.5 text-sm transition-colors",
  active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
);

function Step({ title, children }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export default function Booking(props) {
  const data = props.data || {};
  const { designing } = useDesigner();
  const calendar = String(data.calendar || "").trim();

  const [config, setConfig] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [duration, setDuration] = useState(null);
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState(null);
  const [slots, setSlots] = useState(null);
  const [time, setTime] = useState(null);
  const [contact, setContact] = useState({ name: "", email: "", phone: "", notes: "" });
  const [hp, setHp] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [booked, setBooked] = useState(null);
  const captcha = useCaptcha();
  const request = useRef(0);

  useEffect(() => {
    if (designing || !calendar) return;
    let alive = true;
    loopar.call("Calendar", "booking", { query: { calendar }, freeze: false, notifyError: false })
      .then((r) => {
        if (!alive) return;
        if (!r?.booking) return setUnavailable(true);
        setConfig(r.booking);
        setDuration(r.booking.durations[0]);
      })
      .catch(() => alive && setUnavailable(true));
    return () => { alive = false; };
  }, [calendar, designing]);

  // The days shown: a week at a time, from today to the last bookable day.
  const days = useMemo(() => {
    if (!config) return [];
    return Array.from({ length: PAGE }, (_, i) => addDays(config.today, offset + i)).filter((d) => d <= config.last_day);
  }, [config, offset]);
  const open = (d) => config.days.includes(utc(d).getUTCDay());

  useEffect(() => {
    if (!config || !day || !duration) return;
    const id = ++request.current;
    setSlots(null);
    setTime(null);
    loopar.call("Calendar", "slots", { query: { calendar, date: day, duration }, freeze: false, notifyError: false })
      .then((r) => { if (id === request.current) setSlots(Array.isArray(r?.slots) ? r.slots : []); })
      .catch(() => { if (id === request.current) setSlots([]); });
  }, [config, calendar, day, duration]);

  const book = (e) => {
    e.preventDefault();
    if (sending || !captcha.ready || !day || !time) return;
    setSending(true);
    setError(null);
    loopar.call("Calendar", "book", {
      body: { calendar, date: day, time, duration, ...contact, captcha_token: captcha.token, _hp: hp },
      freeze: false,
      notifyError: false,
      success: () => { setSending(false); setBooked({ day, time, duration }); },
      error: (err) => {
        setSending(false);
        captcha.reset();
        setError(err?.message || __("Something went wrong. Please try again."));
        // The time may be gone: show what is free now.
        setTime(null);
        request.current++;
        loopar.call("Calendar", "slots", { query: { calendar, date: day, duration }, freeze: false, notifyError: false })
          .then((r) => setSlots(Array.isArray(r?.slots) ? r.slots : []))
          .catch(() => setSlots([]));
      },
    });
  };

  const header = (data.title || data.description) && (
    <div>
      {data.title && (
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarCheckIcon className="size-5 text-primary" />
          {data.title}
        </h3>
      )}
      {data.description && <p className="mt-1 text-sm text-muted-foreground">{data.description}</p>}
    </div>
  );

  const shell = (children) => (
    <div {...rootProps(props)}>
      <div className="space-y-5 rounded-xl border bg-card p-6 text-card-foreground">
        {header}
        {children}
      </div>
    </div>
  );

  if (designing) {
    return shell(
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        {calendar ? __("Booking on the calendar {0}: visitors pick a free time here.", [calendar]) : __("Choose the calendar visitors book on.")}
      </p>
    );
  }
  if (!calendar || unavailable) return null;
  if (!config) return shell(<div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>);

  if (booked) {
    return shell(
      <div className="py-4 text-center">
        <CalendarCheckIcon className="mx-auto mb-3 size-10 text-primary" />
        <p className="text-lg font-semibold">{data.success_message || __("Your booking is confirmed.")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {dayLabel(booked.day, { weekday: "long", month: "long", day: "numeric" })} · {timeLabel(booked.time)} · {durationLabel(booked.duration)}
        </p>
      </div>
    );
  }

  return shell(
    <form onSubmit={book} className="space-y-5">
      {config.durations.length > 1 && (
        <Step title={__("Duration")}>
          <div className="flex flex-wrap gap-2">
            {config.durations.map((d) => (
              <button key={d} type="button" className={chip(d === duration)} onClick={() => setDuration(d)}>{durationLabel(d)}</button>
            ))}
          </div>
        </Step>
      )}

      <Step title={__("Day")}>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))} title={__("Previous")}>
            <ChevronLeftIcon className="size-4" />
          </Button>
          <div className="grid flex-1 grid-cols-7 gap-1">
            {days.map((d) => (
              <button
                key={d}
                type="button"
                disabled={!open(d)}
                onClick={() => setDay(d)}
                className={cn(chip(d === day), "flex flex-col items-center px-1 py-1.5 disabled:cursor-not-allowed disabled:opacity-40")}
              >
                <span className="text-[11px] uppercase">{dayLabel(d, { weekday: "short" })}</span>
                <span className="text-base font-semibold leading-tight">{Number(d.slice(8))}</span>
                <span className="text-[11px]">{dayLabel(d, { month: "short" })}</span>
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={addDays(config.today, offset + PAGE) > config.last_day} onClick={() => setOffset((o) => o + PAGE)} title={__("Next")}>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </Step>

      {day && (
        <Step title={__("Time")}>
          {slots === null ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : slots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{__("No free times that day. Try another one.")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button key={s} type="button" className={chip(s === time)} onClick={() => setTime(s)}>{timeLabel(s)}</button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{__("Times are in {0}.", [String(config.time_zone).replace(/_/g, " ")])}</p>
        </Step>
      )}

      {time && (
        <Step title={__("Your details")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={field} required maxLength={120} placeholder={__("Name")} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
            <input className={field} required type="email" maxLength={190} placeholder={__("Email")} value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
            <input className={field} type="tel" maxLength={40} placeholder={__("Phone")} value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
            <textarea className={cn(field, "sm:col-span-2")} rows={3} maxLength={2000} placeholder={__("Anything we should know?")} value={contact.notes} onChange={(e) => setContact({ ...contact, notes: e.target.value })} />
          </div>
          {/* Honeypot — invisible to people, bait for bots */}
          <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}>
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
          </div>
          <CaptchaSlot captcha={captcha} />
          {error && <p className="text-sm text-destructive">{String(error)}</p>}
          <Button type="submit" disabled={sending || !captcha.ready}>
            {sending ? __("Booking…") : (data.button_text || __("Book"))}
          </Button>
        </Step>
      )}
    </form>
  );
}

Booking.metaFields = () => [
  {
    group: "General",
    elements: {
      calendar: {
        element: CONNECTION,
        data: { label: "Calendar", description: "Calendar visitors book on. Turn on \"Public booking\" in it and set its hours.", options: "Calendar" },
      },
    },
  },
  {
    group: "content",
    elements: {
      title: { element: INPUT, data: { label: "Title", default: "Book a time" } },
      description: { element: TEXTAREA, data: { label: "Description" } },
      button_text: { element: INPUT, data: { label: "Button text", default: "Book" } },
      success_message: { element: INPUT, data: { label: "Success message", default: "Your booking is confirmed." } },
    },
  },
];
