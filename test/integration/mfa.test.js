import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TOTP, Secret } from "otpauth";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import {
  beginSetup, confirmSetup, mfaStatus, disableMfa, resetMfa,
} from "../../apps/loopar/modules/auth/controllers/auth/mfa.js";

/**
 * Two-factor enrollment against a real tenant: the mfa_* columns exist after
 * install, secrets are encrypted at rest, and a desk save of the User (the
 * admin editing a user) does not wipe them.
 */
const USER = "Administrator";
let t;
let totp;
let recoveryCodes;

before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

const row = () => loopar.db.query("User").where({ name: USER }).select("*").first();

test("setup + first code turns 2FA on and returns 10 recovery codes", async () => {
  await t.run(async () => {
    assert.deepEqual(await mfaStatus(USER), { enabled: false, recovery_codes_left: 0 });

    const setup = await beginSetup(USER, { issuer: "Loopar Test" });
    assert.match(setup.uri, /^otpauth:\/\/totp\//);
    assert.ok(setup.qr.startsWith("data:image/png;base64,"));
    totp = new TOTP({ secret: Secret.fromBase32(setup.secret) });

    await assert.rejects(confirmSetup(USER, "000000"));
    ({ recovery_codes: recoveryCodes } = await confirmSetup(USER, totp.generate()));
    assert.equal(recoveryCodes.length, 10);
    assert.deepEqual(await mfaStatus(USER), { enabled: true, recovery_codes_left: 10 });
  });
});

test("the TOTP secret is stored encrypted, never in clear", async () => {
  await t.run(async () => {
    const r = await row();
    assert.ok(loopar.isEncryptedSecret(r.mfa_secret));
    assert.equal(r.mfa_pending_secret, "");
    assert.ok(!String(r.mfa_recovery_codes).includes(recoveryCodes[0]));
  });
});

test("saving the User from the desk keeps the 2FA secret", async () => {
  await t.run(async () => {
    const before = await row();
    const doc = await loopar.getDocument("User", USER);
    doc.password = doc.protectedPassword;
    doc.confirm_password = doc.protectedPassword;
    await doc.save();

    const after = await row();
    assert.equal(Number(after.mfa_enabled), 1);
    assert.equal(loopar.decryptSecret(after.mfa_secret), loopar.decryptSecret(before.mfa_secret));
  });
});

test("turning 2FA off needs a valid factor; a recovery code works once", async () => {
  await t.run(async () => {
    await assert.rejects(disableMfa(USER, { code: "000000" }));
    await disableMfa(USER, { recovery_code: recoveryCodes[0] });
    assert.deepEqual(await mfaStatus(USER), { enabled: false, recovery_codes_left: 0 });
  });
});

test("resetMfa clears everything without a code", async () => {
  await t.run(async () => {
    const setup = await beginSetup(USER);
    const app = new TOTP({ secret: Secret.fromBase32(setup.secret) });
    await confirmSetup(USER, app.generate());
    await resetMfa(USER);
    const r = await row();
    assert.equal(Number(r.mfa_enabled), 0);
    assert.equal(r.mfa_secret, "");
  });
});
