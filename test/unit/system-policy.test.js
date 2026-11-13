import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy, passwordProblem, uploadProblem } from "../../packages/loopar/core/global/system-policy.js";

test("nothing saved: the defaults that were fixed in code before", () => {
  assert.deepEqual(normalizePolicy(), {
    maxLoginAttempts: 15, passwordMinLength: 8, passwordComplexity: true, maxUploadMb: 50, allowedExtensions: [],
  });
});

test("values are bounded: nobody locks everyone out or lifts the server's ceiling", () => {
  const p = normalizePolicy({ max_login_attempts: "1", password_min_length: "2", max_upload_mb: "900", password_complexity: "0" });
  assert.equal(p.maxLoginAttempts, 3);
  assert.equal(p.passwordMinLength, 6);
  assert.equal(p.maxUploadMb, 50);
  assert.equal(p.passwordComplexity, false);
});

test("passwords: length always, complexity only when required", () => {
  const strict = normalizePolicy({ password_min_length: 10 });
  assert.match(passwordProblem("Short1!", strict), /at least 10 characters and include/);
  assert.match(passwordProblem("longbutsimple", strict), /include uppercase/);
  assert.equal(passwordProblem("Long-Enough-1", strict), null);

  const relaxed = normalizePolicy({ password_complexity: 0 });
  assert.equal(passwordProblem("simplepass", relaxed), null);
  assert.match(passwordProblem("short", relaxed), /^Password must be at least 8 characters\.$/);
});

test("uploads: size and allowed types", () => {
  const policy = normalizePolicy({ max_upload_mb: 2, allowed_extensions: ".JPG, png  pdf" });
  assert.deepEqual(policy.allowedExtensions, ["jpg", "png", "pdf"]);
  assert.equal(uploadProblem({ originalname: "photo.JPG", size: 1024 }, policy), null);
  assert.match(uploadProblem({ originalname: "big.png", size: 3 * 1024 * 1024 }, policy), /larger than the 2 MB/);
  assert.match(uploadProblem({ originalname: "run.exe", size: 10 }, policy), /not allowed/);
  assert.match(uploadProblem({ originalname: "noextension", size: 10 }, policy), /not allowed/);
  assert.equal(uploadProblem({ originalname: "run.exe", size: 10 }, normalizePolicy()), null);
});
