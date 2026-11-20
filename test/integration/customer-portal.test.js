import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition, PermissionManager, SCOPE, requestContext } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Customer portal: sign-in links (core auth) let a customer in without a
 * password, the portal home lists only that customer's documents, and an
 * invoice email carries a "View online" link to it.
 */

let t, links, home, invite, A, B, mails = [];
const root = process.cwd();
const imp = (...p) => import(path.join(root, "apps", ...p));
const as = (user, fn) => t.run(() => requestContext.run({ ...requestContext.getStore(), req: { __authUserName__: user, headers: {}, cookies: {} } }, fn));
const tokenOf = (html) => decodeURIComponent(/\/auth\/link\?token=([^"'\s<&]+)/.exec(html)?.[1] || "");

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  links = await imp("loopar", "modules", "auth", "controllers", "auth", "sign-in-link.js");
  home = await imp("loopar", "modules", "web", "pages", "portal-home", "portal-home-controller.js");
  invite = await imp("erp", "modules", "crm", "portal-invite.js");
  await t.run(async () => {
    const { createCustomer } = await imp("erp", "modules", "crm", "customers.js");
    A = await createCustomer({ customer_name: "Acme Floors", email: "ana@acme.test" });
    B = await createCustomer({ customer_name: "Globex", email: "bob@globex.test" });
    loopar.mail.send = async (m) => { mails.push(m); return { ok: true }; };
  });
});
after(async () => { await t?.teardown(); });

const newQuote = async (customer, title) => {
  const quote = await loopar.newDocument("Quote", {
    customer, title,
    lines: [{ description: "Sand and refinish", quantity: 100, unit: "sq ft", rate: 3 }],
    discount_percent: 0, deposit_percent: 50,
  });
  await quote.save();
  return await loopar.getDocument("Quote", quote.name);
};

let userA;

test("a portal invitation creates the customer's Web user and emails a working sign-in link", async () => {
  await t.run(async () => {
    const r = await invite.sendPortalInvitation(A);
    assert.equal(r.created, true);
    assert.equal(r.email, "ana@acme.test");
    userA = r.user;
    assert.equal((await loopar.db.getRow("User", userA, ["user_type"])).user_type, "Web");

    const mail = mails.at(-1);
    assert.equal(mail.to, "ana@acme.test");
    const token = tokenOf(mail.html);
    assert.ok(token, "the email has a sign-in link");

    const found = await links.consumeSignInLink(token);
    assert.equal(found.user.name, userA);
    assert.equal(found.landing, "/portal");
    assert.ok(await links.consumeSignInLink(token), "reusable until it expires");

    // A second invitation reuses the same user.
    assert.equal((await invite.sendPortalInvitation(A)).created, false);
  });
});

test("sign-in links: one-use, revoked by a password change, never for desk users, no open redirect", async () => {
  await t.run(async () => {
    const once = new URL(await links.signInLink(userA, { once: true, landing: "/portal/Quote/list" })).searchParams.get("token");
    assert.equal((await links.consumeSignInLink(once)).landing, "/portal/Quote/list");
    assert.equal(await links.consumeSignInLink(once), null, "used");

    const reusable = new URL(await links.signInLink(userA)).searchParams.get("token");
    assert.ok(await links.consumeSignInLink(reusable));
    await loopar.db.updateRow("User", userA, { password: await loopar.hash("N3w-Passw0rd!") });
    assert.equal(await links.consumeSignInLink(reusable), null, "a password change revokes it");

    assert.equal(await links.consumeSignInLink("garbage"), null);
    await assert.rejects(() => links.signInLink("Administrator"), /only for portal/);

    assert.equal(links.safeLanding("//evil.test/x"), "/portal");
    assert.equal(links.safeLanding("https://evil.test"), "/portal");
    assert.equal(links.safeLanding("/auth/login"), "/portal");
    assert.equal(links.safeLanding("/portal/Invoice/print?name=X"), "/portal/Invoice/print?name=X");
  });
});

test("the portal home lists only the customer's own documents, with their portal actions", async () => {
  await t.run(async () => {
    const mine = await newQuote(A, "Living room");
    const theirs = await newQuote(B, "Kitchen");
    await PermissionManager.reload(userA);
    assert.equal(PermissionManager.scope("Quote", "list", userA), SCOPE.PORTAL);

    let summary = await home.portalSummary(userA);
    assert.equal(summary.account.desk_user, false);
    const quotes = summary.sections.find((s) => s.entity === "Quote");
    assert.ok(quotes, "a Quote card");
    assert.deepEqual(quotes.rows.map((r) => r.name), [mine.name]);
    assert.ok(!JSON.stringify(summary).includes(theirs.name), "never another customer's quote");
    assert.equal(quotes.rows[0].open, `/portal/Quote/print?name=${encodeURIComponent(mine.name)}`);
    assert.deepEqual(quotes.rows[0].actions, [], "a Draft quote has nothing to approve");

    await loopar.db.updateRow("Quote", mine.name, { status: "Sent" });
    summary = await home.portalSummary(userA);
    const row = summary.sections.find((s) => s.entity === "Quote").rows[0];
    assert.equal(row.status, "Sent");
    assert.deepEqual(row.actions.map((a) => a.href), [`/portal/Quote/approvalLink?name=${encodeURIComponent(mine.name)}`]);
  });
});

test("an invoice email has a View online link that lands on the invoice", async () => {
  await t.run(async () => {
    const quote = await newQuote(A, "Stairs");
    await applyTransition(quote, "Mark approved", {}, { system: true });
    const invoice = await quote.makeInvoice("Deposit");
    await (await loopar.getDocument("Invoice", invoice.name)).send();

    const mail = mails.at(-1);
    assert.match(mail.subject, new RegExp(`Invoice ${invoice.name}`));
    assert.match(mail.html, /View invoice online/);
    const found = await links.consumeSignInLink(tokenOf(mail.html));
    assert.equal(found.user.name, userA);
    assert.equal(found.landing, `/portal/Invoice/print?name=${encodeURIComponent(invoice.name)}`);

    const summary = await home.portalSummary(userA);
    assert.ok(summary.sections.find((s) => s.entity === "Invoice")?.rows.some((r) => r.name === invoice.name));
  });
});

test("a portal user reading a quote gets no workflow buttons; staff do", async () => {
  let name;
  await t.run(async () => { name = (await newQuote(A, "Hall")).name; });
  const transitionsAs = (user) => as(user, async () => {
    const { describeWorkflow, workflowFor } = await import(`${root}/packages/loopar/core/document/workflow.js`);
    const doc = await loopar.getDocument("Quote", name);
    return (await describeWorkflow(doc, await workflowFor("Quote"))).transitions.map((x) => x.action);
  });
  assert.deepEqual(await transitionsAs(userA), [], "the customer can't move its quote");
  assert.ok((await transitionsAs("Administrator")).length > 0, "staff see the transitions");
});

test("portal lists ignore saved list settings (no extra columns for customers)", async () => {
  const { writeListSettings, readListSettings } = await import(`${root}/packages/loopar/core/document/list-settings.js`);
  await as(userA, async () => {
    await writeListSettings("Quote", { shown: ["notes"] });
    const inPortal = await requestContext.run({ ...requestContext.getStore(), req: { __authUserName__: userA, __WORKSPACE_NAME__: "portal", headers: {}, cookies: {} } },
      () => readListSettings("Quote"));
    assert.equal(inPortal, null);
  });
  await as("Administrator", async () => {
    await writeListSettings("Quote", { shown: ["notes"] });
    assert.deepEqual((await readListSettings("Quote"))?.shown, ["notes"], "staff keep their columns on the desk");
  });
});

test("the portal prints designed formats only (never the all-fields standard sheet)", async () => {
  const { printPayload } = await import(`${root}/packages/loopar/core/document/print-format.js`);
  await t.run(async () => {
    const desk = await printPayload("Quote", { requested: "standard" });
    assert.equal(desk.format, null, "the desk may pick the standard sheet");
    for (const requested of ["standard", "nope", null]) {
      const portal = await printPayload("Quote", { requested, designedOnly: true });
      assert.ok(portal.format?.name, `portal "${requested}" → a designed format`);
    }
  });
});
