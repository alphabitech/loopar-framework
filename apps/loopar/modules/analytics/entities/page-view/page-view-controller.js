
'use strict';

import { BaseController, loopar, ipHash as hashIp, clientIp, isInternalNetwork } from 'loopar';
import { UAParser } from 'ua-parser-js';
import { isbot } from 'isbot';
import { geoLookup } from './geo-lookup.js';

const ENGAGED_THRESHOLD_MS = 10000;

const RATE_LIMITS = {
  track: { max: 30, windowMs: 60000 },
  ping: { max: 120, windowMs: 60000 },
};
const rateBuckets = new Map();

function rateLimited(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    rateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  return ++bucket.count > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start >= 120000) rateBuckets.delete(key);
  }
}, 300000).unref();

const BOT_UA_RE = /headless|lighthouse|phantomjs|electron/i;
const isBotUA = (ua) => !ua || isbot(ua) || BOT_UA_RE.test(ua);

export default class PageViewController extends BaseController {
  constructor(props) {
    super(props);
  }

  #clientIp() {
    return clientIp(this.req || {});
  }

  async publicActionTrack() {
    const body = this.data || {};
    const viewId = String(body.viewId || "").slice(0, 64);
    const document = String(body.document || "").slice(0, 255);

    if (!viewId || !document) {
      return this.error("Missing viewId or document", { notify: false }, 400);
    }

    const req = this.req || {};
    const ip = this.#clientIp();

    if (rateLimited(`t:${ip}`, RATE_LIMITS.track)) {
      return this.error("Too many requests", { notify: false }, 429);
    }

    const ipHash = hashIp(ip);

    const userAgent = req.headers?.["user-agent"] || "";
    if (isBotUA(userAgent)) {
      return this.success("ok", { notify: false });
    }

    // Own traffic is never stored (and costs no geo lookup):
    //  - "user": logged in on this origin → the client also pins
    //    localStorage opt-out, so the browser stays excluded after logout
    //    and on networks the tenant hasn't learned (mobile data).
    //  - "network": anonymous, but from a network a logged-in user of this
    //    tenant — or the platform operator, for ANY tenant — used recently
    //    (any site/domain, any browser). No sticky
    //    client flag — guests on the same Wi-Fi shouldn't be pinned forever.
    const user = loopar.currentUser?.name;
    if (user && user !== "Guest") {
      return this.success("ok", { notify: false, internal: "user" });
    }
    if (isInternalNetwork(ip)) {
      return this.success("ok", { notify: false, internal: "network" });
    }

    const utm = (v) => String(v || "").slice(0, 100);
    const { country, city, region, timezone, isp } = await geoLookup(ip);
    const ua = new UAParser(userAgent).getResult();

    try {
      await loopar.db.insertRow("Page View", {
        name: viewId,
        document,
        workspace: "web",
        site: loopar.webApp?.name || "",
        ip_hash: ipHash,
        country,
        city,
        region,
        timezone,
        isp,
        browser: ua.browser.name || "",
        os: ua.os.name || "",
        device_type: ua.device.type || "desktop",
        user_agent: userAgent.slice(0, 255),
        referrer: String(body.referrer || req.headers?.["referer"] || "").slice(0, 255),
        language: (body.language || req.headers?.["accept-language"] || "").split(",")[0].slice(0, 32),
        session_id: String(body.sessionId || "").slice(0, 64),
        viewport: String(body.viewport || "").slice(0, 16),
        utm_source: utm(body.utmSource),
        utm_medium: utm(body.utmMedium),
        utm_campaign: utm(body.utmCampaign),
        is_internal: 0,
        scroll_depth: 0,
        active_ms: 0,
        visit_date: new Date().toISOString().split("T")[0],
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(["Can not record Page View", error]);
      return this.error("Tracking failed", { notify: false }, 500);
    }

    return this.success("ok", { notify: false });
  }

  async publicActionPing() {
    const body = this.data || {};
    const viewId = String(body.viewId || "").slice(0, 64);
    const activeMs = Math.max(0, Math.min(Number(body.activeMs) || 0, 86400000));
    const scrollDepth = Math.max(0, Math.min(100, Math.round(Number(body.scrollDepth) || 0)));

    if (!viewId) {
      return this.error("Missing viewId", { notify: false }, 400);
    }

    if (rateLimited(`p:${this.#clientIp()}`, RATE_LIMITS.ping)) {
      return this.error("Too many requests", { notify: false }, 429);
    }

    try {
      await loopar.db.updateRow("Page View", viewId, { active_ms: activeMs, scroll_depth: scrollDepth });
    } catch (error) {
      console.warn(["Can not update Page View ping", error]);
      return this.error("Ping failed", { notify: false }, 500);
    }

    return this.success("ok", { notify: false });
  }
}

export { ENGAGED_THRESHOLD_MS };
