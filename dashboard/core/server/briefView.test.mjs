// Tests for the research brief on the proposal page. Run: node --test core/server/briefView.test.mjs (from dashboard/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefFor, siteOf } from '../briefView.js';

const SHA = 'b672249572ec' + '0'.repeat(52);
const brief = (over = {}) => ({
  for_sha256: SHA,
  status: 'ready',
  company_types: [{ text: 'Makers of infotainment units', sources: ['https://www.example.org/a', 'https://docs.example.net/b'] }],
  buying_signals: [{ text: 'Moving to a new Android version', sources: ['https://www.example.org/a'] }],
  key_terms: [],
  not_confirmed: ['typical budgets'],
  queries: ['digital cockpit Android explained'],
  searched_at: '2026-10-17T17:20:00+05:30',
  ...over,
});

test('the brief of the version on screen is shown, with short site names for its sources', () => {
  const b = briefFor(brief(), { sha256: SHA });
  assert.equal(b.label, 'Ready');
  assert.deepEqual(b.parts.map((p) => p.title), ['Typical customers', 'Buying signals']); // empty parts are left out
  assert.deepEqual(b.parts[0].items[0].sources.map((s) => s.site), ['example.org', 'docs.example.net']);
  assert.equal(b.parts[0].items[0].sources[0].url, 'https://www.example.org/a');
  assert.deepEqual(b.notConfirmed, ['typical budgets']);
});

test('a brief written for another version, or no brief at all, is not shown', () => {
  assert.equal(briefFor(brief(), { sha256: 'something-else' }), null);
  assert.equal(briefFor(null, { sha256: SHA }), null);
  assert.equal(briefFor(brief(), null), null);
  assert.equal(briefFor(brief({ for_sha256: '' }), { sha256: '' }), null);
});

test('an unavailable brief is shown as a warning with its reason', () => {
  const b = briefFor(brief({ status: 'unavailable', company_types: [], buying_signals: [],
    not_confirmed: ['no web page could be read (search or fetch failed)'] }), { sha256: SHA });
  assert.equal(b.warn, true);
  assert.equal(b.label, 'Not available');
  assert.deepEqual(b.parts, []);
  assert.match(b.notConfirmed[0], /no web page could be read/);
});

test('only web links are kept as sources', () => {
  assert.equal(siteOf('javascript:alert(1)'), null);
  assert.equal(siteOf('not a url'), null);
  assert.equal(siteOf('https://www.kpit.com/expertise/cockpit/'), 'kpit.com');
  const b = briefFor(brief({ buying_signals: [{ text: 'x y', sources: ['javascript:alert(1)', 'https://a.example/'] }] }), { sha256: SHA });
  assert.deepEqual(b.parts[1].items[0].sources.map((s) => s.site), ['a.example']);
});
