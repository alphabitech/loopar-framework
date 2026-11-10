import { useEffect, useRef } from "react";

const HEARTBEAT_MS = 15000;
const IDLE_MS = 30000;
const SESSION_KEY = "loopar_sid";
const SESSION_TTL_MS = 30 * 60 * 1000;
const NOTRACK_KEY = "loopar_notrack";
const ENDPOINT = (action) => `/api/${encodeURIComponent("Page View")}/${action}`;

function optedOut() {
  try {
    const q = new URLSearchParams(window.location.search).get("notrack");
    if (q === "1") localStorage.setItem(NOTRACK_KEY, "1");
    if (q === "0") localStorage.removeItem(NOTRACK_KEY);
    return localStorage.getItem(NOTRACK_KEY) === "1";
  } catch {
    return false;
  }
}

function sessionId() {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.id && now - s.t < SESSION_TTL_MS) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: s.id, t: now }));
        return s.id;
      }
    }
    const id = uuid();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, t: now }));
    return id;
  } catch {
    return "";
  }
}

function utmParams() {
  try {
    const q = new URLSearchParams(window.location.search);
    return {
      utmSource: q.get("utm_source") || "",
      utmMedium: q.get("utm_medium") || "",
      utmCampaign: q.get("utm_campaign") || "",
    };
  } catch {
    return { utmSource: "", utmMedium: "", utmCampaign: "" };
  }
}

function scrollPct() {
  const h = document.documentElement.scrollHeight;
  if (!h) return 0;
  return Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h) * 100));
}

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function sendPing(viewId, activeMs, scrollDepth, { beacon = false } = {}) {
  const payload = JSON.stringify({ viewId, activeMs: Math.round(activeMs), scrollDepth });
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT("ping"), new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch(ENDPOINT("ping"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

export function TrafficTracker({ page }) {
  const ref = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined" || !page) return;
    if (optedOut()) return;

    const s = {
      viewId: uuid(),
      activeMs: 0,
      sentMs: 0,
      maxScroll: scrollPct(),
      sentScroll: 0,
      lastTick: Date.now(),
      lastActivity: Date.now(),
      stopped: false,
    };
    ref.current = s;

    fetch(ENDPOINT("track"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        viewId: s.viewId,
        document: page,
        referrer: document.referrer || "",
        language: navigator.language || "",
        sessionId: sessionId(),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        ...utmParams(),
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res?.internal) return;
        // Own traffic: the server stored nothing, stop pinging. A logged-in
        // user also pins the opt-out so this browser stays excluded on this
        // origin after logout / on networks the server hasn't learned.
        s.stopped = true;
        if (res.internal === "user") {
          try { localStorage.setItem(NOTRACK_KEY, "1"); } catch { /* storage blocked */ }
        }
      })
      .catch(() => {});

    const isActive = () =>
      document.visibilityState === "visible" &&
      Date.now() - s.lastActivity < IDLE_MS;

    const accumulate = () => {
      const now = Date.now();
      if (isActive()) s.activeMs += now - s.lastTick;
      s.lastTick = now;
    };

    const flush = ({ beacon = false } = {}) => {
      if (s.stopped) return;
      accumulate();
      if (s.activeMs <= s.sentMs && s.maxScroll <= s.sentScroll) return;
      s.sentMs = s.activeMs;
      s.sentScroll = s.maxScroll;
      sendPing(s.viewId, s.activeMs, s.maxScroll, { beacon });
    };

    const onActivity = () => { s.lastActivity = Date.now(); };
    const onScroll = () => {
      s.lastActivity = Date.now();
      const pct = scrollPct();
      if (pct > s.maxScroll) s.maxScroll = pct;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flush({ beacon: true });
      } else {
        s.lastTick = Date.now();
        s.lastActivity = Date.now();
      }
    };
    const onPageHide = () => flush({ beacon: true });

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    // capture:true also catches scroll from inner overflow containers
    // (scroll events don't bubble, but they do go through the capture phase).
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    const hb = setInterval(() => flush(), HEARTBEAT_MS);

    return () => {
      clearInterval(hb);
      flush({ beacon: true });
      events.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [page]);

  return null;
}

export default TrafficTracker;
