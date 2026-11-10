import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  loopar, sanitizeInput, trustedInput, requestContext,
  hasFreshStepUp, markStepUp, clearStepUp, markOauthProof, takeOauthProof,
} from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Field write policy (core/global/field-policy.js) on the real User entity:
 *   layer A — sanitizeInput() drops what client input may not write;
 *   layer B — save() refuses changes to protected/system fields unless the
 *             server code authorize()s them.
 */
let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

const PASSWORD = "Str0ng!Passw0rd";

async function makeUser(name) {
  const doc = await loopar.newDocument("User", {
    name,
    email: `${name}@policy.test`,
    password: PASSWORD,
    confirm_password: PASSWORD,
    user_type: "Web",
  });
  await doc.save();
  return name;
}

/** Open the stored user the way a desk save does (masks = unchanged password). */
async function openUser(name, data = null) {
  const doc = await loopar.getDocument("User", name, data);
  doc.password = doc.protectedPassword;
  doc.confirm_password = doc.protectedPassword;
  return doc;
}

const forbidden = (err) => Number(err?.code) === 403 && /verified flow/.test(err.message);

test("the User ref carries the write policy from user.json", async () => {
  await t.run(async () => {
    const map = loopar.getRef("User").__WRITE_POLICY__;
    assert.equal(map.email.policy, "protected");
    assert.equal(map.password.policy, "protected");
    assert.equal(map.mfa_enabled.policy, "system");
    assert.equal(map.oauth_sub.policy, "system");
    assert.equal(map.name.policy, "create_only");
    assert.equal(map.first_name, undefined);       // plain editable
  });
});

test("layer A: update input loses protected/system/create_only fields", async () => {
  await t.run(async () => {
    const clean = await sanitizeInput("User", {
      first_name: "Ana",
      name: "renamed",
      email: "evil@x.test",
      password: "Hacked!123",
      mfa_enabled: 0,
      oauth_sub: "attacker",
      must_change_password: 0,
    }, { op: "update" });
    assert.deepEqual(clean, { first_name: "Ana", password: "********" });
  });
});

test("layer A: create input keeps protected fields, never system ones", async () => {
  await t.run(async () => {
    const clean = await sanitizeInput("User", {
      name: "new-user", email: "a@b.test", password: "x", mfa_enabled: 1, oauth_sub: "s",
    }, { op: "create" });
    assert.deepEqual(clean, { name: "new-user", email: "a@b.test", password: "x" });
  });
});

test("layer B: a system field changed through raw input is refused", async () => {
  await t.run(async () => {
    const name = await makeUser("policy-b1");
    const doc = await openUser(name, { mfa_enabled: 1 });
    await assert.rejects(() => doc.save(), forbidden);
    const row = await loopar.db.query("User").where({ name }).first("mfa_enabled");
    assert.ok(!loopar.utils.trueValue(row.mfa_enabled));
  });
});

test("layer B: `doc.field = value` on a protected field is refused", async () => {
  await t.run(async () => {
    const name = await makeUser("policy-b2");
    const doc = await openUser(name);
    doc.email = "stolen@x.test";
    await assert.rejects(() => doc.save(), forbidden);
    const row = await loopar.db.query("User").where({ name }).first("email");
    assert.equal(row.email, `${name}@policy.test`);
  });
});

test("layer B: authorize() lets server code change it, once", async () => {
  await t.run(async () => {
    const name = await makeUser("policy-b3");
    const doc = await openUser(name);
    doc.authorize("email");
    doc.email = "verified@x.test";
    await doc.save();
    assert.equal((await loopar.db.query("User").where({ name }).first("email")).email, "verified@x.test");

    // The authorization is consumed by that save.
    doc.email = "again@x.test";
    doc.password = doc.protectedPassword;
    doc.confirm_password = doc.protectedPassword;
    await assert.rejects(() => doc.save(), forbidden);
  });
});

test("layer B: editable fields and unchanged guarded fields save normally", async () => {
  await t.run(async () => {
    const name = await makeUser("policy-b4");
    // A desk form posts every field back, guarded ones unchanged.
    const doc = await openUser(name, { first_name: "Maria", email: `${name}@policy.test`, mfa_enabled: 0 });
    await doc.save();
    assert.equal((await loopar.db.query("User").where({ name }).first("first_name")).first_name, "Maria");
  });
});

/** Runs `fn` as if inside an HTTP request (guest, empty session). */
const asRequest = (fn) => requestContext.run(
  { tenant: { name: t.name }, req: { headers: {}, cookies: {}, session: {} } },
  fn,
);

test("in a request, getDocument() filters its input by itself (no controller code)", async () => {
  await t.run(() => makeUser("policy-a1"));
  await asRequest(async () => {
    const doc = await loopar.getDocument("User", "policy-a1", {
      first_name: "Lucia", mfa_enabled: 1, oauth_sub: "attacker", email: "evil@x.test",
    });
    assert.equal(doc.first_name, "Lucia");
    assert.ok(!loopar.utils.trueValue(doc.mfa_enabled));   // stored value kept
    assert.equal(doc.oauth_sub || "", "");
    assert.equal(doc.email, "policy-a1@policy.test");
    doc.password = doc.protectedPassword;
    doc.confirm_password = doc.protectedPassword;
    await doc.save();                                       // nothing guarded changed
  });
  await t.run(async () => {
    const row = await loopar.db.query("User").where({ name: "policy-a1" }).first("first_name", "email");
    assert.deepEqual({ ...row }, { first_name: "Lucia", email: "policy-a1@policy.test" });
  });
});

test("in a request, newDocument() drops system fields from its data", async () => {
  await asRequest(async () => {
    const doc = await loopar.newDocument("User", {
      name: "policy-a2", email: "a2@policy.test", password: PASSWORD, confirm_password: PASSWORD, mfa_enabled: 1,
    });
    assert.ok(!loopar.utils.trueValue(doc.mfa_enabled));
    assert.equal(doc.email, "a2@policy.test");            // protected is fine on create
  });
});

test("trustedInput() marks constructor data built by server code", async () => {
  await asRequest(async () => {
    const doc = await loopar.newDocument("User", trustedInput({
      name: "policy-a3", email: "a3@policy.test", password: PASSWORD, confirm_password: PASSWORD, must_change_password: 1,
    }));
    assert.ok(loopar.utils.trueValue(doc.must_change_password));
  });
});

test("step-up proof lives in the session, bound to the user, consumed on use", async () => {
  await asRequest(async () => {
    assert.equal(hasFreshStepUp("ana"), false);
    markStepUp("ana");
    assert.equal(hasFreshStepUp("ana"), true);
    assert.equal(hasFreshStepUp("bob"), false);
    clearStepUp();
    assert.equal(hasFreshStepUp("ana"), false);

    markOauthProof("ana");
    assert.equal(takeOauthProof("bob"), false);   // wrong user — and consumed
    assert.equal(takeOauthProof("ana"), false);
    markOauthProof("ana");
    assert.equal(takeOauthProof("ana"), true);
    assert.equal(takeOauthProof("ana"), false);   // single use
  });
});

test("step-up fails closed without a session", async () => {
  await t.run(async () => {
    assert.equal(hasFreshStepUp("Administrator"), false);
  });
});
