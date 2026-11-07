import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, requestContext } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Multi-site sender: on a website domain whose web app has an enabled Email
 * Account, mail goes out as that account (its From, login and notification
 * address); everywhere else Email Settings stays the sender.
 */

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

/** Runs `fn` as a request served on the website domain of `webApp`. */
const onSite = (webApp, fn) => requestContext.run({ tenant: { name: t.name, webApp } }, fn);

/** Captures what send() hands to nodemailer instead of connecting. */
async function captureSends() {
  const sent = [];
  const mail = await t.run(async () => loopar.mail); // the tenant's EmailService
  const original = mail.getTransporter;
  mail.getTransporter = async (settings) => ({
    sendMail: async (opts) => { sent.push({ opts, settings }); return { messageId: `m${sent.length}` }; },
  });
  return { sent, restore: () => { mail.getTransporter = original; } };
}

test("Email Account is installed with the loopar app", async () => {
  await t.run(async () => {
    assert.ok(await loopar.db.getValue("Entity", "name", "Email Account"));
  });
});

test("site domains send as their Email Account; the main domain keeps Email Settings", async () => {
  await t.run(async () => {
    const settings = await loopar.getDocument("Email Settings");
    Object.assign(settings, {
      host: "smtp.migadu.com", port: 465, secure: 1, auth_enabled: 1,
      user: "no-reply@loopar.build", password: "base-secret",
      from_name: "Loopar", from_email: "no-reply@loopar.build",
      notification_email: "alfredo@loopar.build",
    });
    await settings.save();

    const acc = await loopar.newDocument("Email Account", {
      name: " Hola@Alfra.dev ", web_app: "loopar", enabled: 1,
      from_name: "Alfra", password: "site-secret",
    });
    await acc.save();
  });

  const cap = await captureSends();
  try {
    await onSite("loopar", async () => {
      assert.equal(await loopar.mail.notificationEmail(), "alfredo@loopar.build", "no own notification → Email Settings'");
      await loopar.mail.send({ to: "x@example.com", subject: "s", html: "<p>h</p>", replyTo: "visitor@example.com" });
    });
    await t.run(async () => {
      await loopar.mail.send({ to: "y@example.com", subject: "s", html: "<p>h</p>" });
    });
  } finally {
    cap.restore();
  }

  const [site, main] = cap.sent;
  assert.equal(site.opts.from, '"Alfra" <hola@alfra.dev>');
  assert.equal(site.opts.replyTo, "visitor@example.com");
  assert.equal(site.settings.user, "hola@alfra.dev", "login defaults to the sender");
  assert.equal(site.settings.password, "site-secret", "password decrypted for the transport");
  assert.equal(site.settings.host, "smtp.migadu.com", "server borrowed from Email Settings");
  assert.equal(Number(site.settings.port), 465);
  assert.equal(main.opts.from, '"Loopar" <no-reply@loopar.build>');
  assert.equal(main.settings.account, undefined);
});

test("own server, own notification, explicit app and disabling", async () => {
  await t.run(async () => {
    const acc = await loopar.getDocument("Email Account", "hola@alfra.dev");
    Object.assign(acc, { host: "smtp.other.test", port: "", secure: 0, user: "login@alfra.dev", notification_email: "inbox@alfra.dev" });
    await acc.save();

    const s = await loopar.mail.resolve("loopar");
    assert.equal(s.host, "smtp.other.test");
    assert.equal(s.port, 587, "STARTTLS default without SSL");
    assert.equal(s.user, "login@alfra.dev");
    assert.equal(await loopar.mail.notificationEmail("loopar"), "inbox@alfra.dev");
    assert.equal((await loopar.mail.resolve()).from_email, "no-reply@loopar.build", "no site in a desk request");

    // One enabled account per web app.
    const dup = await loopar.newDocument("Email Account", { name: "other@alfra.dev", web_app: "loopar", enabled: 1, password: "x" });
    await assert.rejects(() => dup.save(), /already sends through hola@alfra\.dev/);

    acc.enabled = 0;
    await acc.save();
    assert.equal((await loopar.mail.resolve("loopar")).from_email, "no-reply@loopar.build", "disabled → Email Settings");

    await dup.save(); // now free
    assert.equal((await loopar.mail.resolve("loopar")).from_email, "other@alfra.dev");
  });
});

test("Email Account validates its addresses", async () => {
  await t.run(async () => {
    const bad = await loopar.newDocument("Email Account", { name: "not-an-email", web_app: "loopar", enabled: 0, password: "x" });
    await assert.rejects(() => bad.save(), /valid email/);
    const badNotify = await loopar.newDocument("Email Account", { name: "ok@alfra.dev", web_app: "loopar", enabled: 0, password: "x", notification_email: "nope" });
    await assert.rejects(() => badNotify.save(), /Notification email/);
  });
});
