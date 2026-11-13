import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalTarget, safeTarget } from '../../packages/loopar/core/global/link-target.js';

test('script and data schemes are never followed', () => {
  for (const to of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', "javascript:fetch('http://x')"]) {
    assert.equal(safeTarget(to), '', to);
    assert.equal(isExternalTarget(to), false, to);
  }
});

test('in-app targets pass untouched and are not external', () => {
  for (const to of ['/desk/Company/update', 'Company/update', 'update?name=x', '#pricing', '/desk/User/list?q=http', '']) {
    assert.equal(safeTarget(to), to);
    assert.equal(isExternalTarget(to), false, to);
  }
});

test('web, mail and phone targets are external', () => {
  for (const to of ['https://loopar.build', 'http://x.test', 'mailto:a@b.co', 'tel:+15550100', '//cdn.example.com/x']) {
    assert.equal(safeTarget(to), to);
    assert.equal(isExternalTarget(to), true, to);
  }
});

test('a missing target is empty, not a crash', () => {
  assert.equal(safeTarget(undefined), '');
  assert.equal(safeTarget(null), '');
});
