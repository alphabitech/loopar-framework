'use strict';

/**
 * Policies an administrator sets in System Settings (Security and Files
 * tabs), with the defaults that apply while nothing was saved. Pure helpers
 * here; `systemPolicy()` reads the current workspace's values.
 */

import { loopar } from '../loopar.js';

export const POLICY_DEFAULTS = Object.freeze({
  max_login_attempts: 15,
  password_min_length: 8,
  password_complexity: 1,
  max_upload_mb: 50,
  allowed_extensions: '',
});

/** Hard ceiling of one uploaded file: what the upload parser itself accepts. */
export const UPLOAD_CEILING_MB = 50;

const FIELDS = Object.keys(POLICY_DEFAULTS);
const truthy = (v) => v === 1 || v === true || v === '1' || v === 'true';
const intIn = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Raw stored values → a complete, bounded policy. */
export function normalizePolicy(raw = {}) {
  const has = (key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '';
  return {
    maxLoginAttempts: intIn(raw.max_login_attempts, POLICY_DEFAULTS.max_login_attempts, 3, 10000),
    passwordMinLength: intIn(raw.password_min_length, POLICY_DEFAULTS.password_min_length, 6, 128),
    passwordComplexity: has('password_complexity') ? truthy(raw.password_complexity) : true,
    maxUploadMb: intIn(raw.max_upload_mb, POLICY_DEFAULTS.max_upload_mb, 1, UPLOAD_CEILING_MB),
    allowedExtensions: String(raw.allowed_extensions ?? '').toLowerCase().split(/[\s,;]+/)
      .map(e => e.replace(/^\./, '')).filter(Boolean),
  };
}

/** Why `password` is not acceptable under `policy`, or null when it is. */
export function passwordProblem(password, policy) {
  const value = String(password ?? '');
  const complex = /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);
  if (value.length >= policy.passwordMinLength && (!policy.passwordComplexity || complex)) return null;
  return policy.passwordComplexity
    ? `Password must be at least ${policy.passwordMinLength} characters and include uppercase, lowercase, number and special character.`
    : `Password must be at least ${policy.passwordMinLength} characters.`;
}

/** Why an uploaded file is not acceptable under `policy`, or null when it is. */
export function uploadProblem(file, policy) {
  const name = String(file?.originalname || file?.name || 'file');
  if (Number(file?.size) > policy.maxUploadMb * 1024 * 1024) {
    return `${name} is larger than the ${policy.maxUploadMb} MB allowed per file.`;
  }
  if (policy.allowedExtensions.length) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!policy.allowedExtensions.includes(ext)) {
      return `${name}: this type of file is not allowed (allowed: ${policy.allowedExtensions.join(', ')}).`;
    }
  }
  return null;
}

/** The current workspace's policy; the defaults when it can't be read (not installed yet). */
export async function systemPolicy() {
  try {
    const rows = await loopar.db.qx()('Document Single Values').select('field', 'value')
      .where({ document: 'System Settings' }).whereIn('field', FIELDS);
    return normalizePolicy(Object.fromEntries(rows.map(({ field, value }) => [field, value])));
  } catch {
    return normalizePolicy();
  }
}
