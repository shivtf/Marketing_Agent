// Tests for the blog approval rules. Run: node --test core/server/blogApproval.test.mjs (from dashboard/). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalOf, blogHash, blogsWithHash, isLocked, planDecisions, planRemoval, postOf, staleApprovals } from './blogApproval.js';

const blog = (id, day, extra = {}) => ({ id, topic: `Topic ${id}`, publish_date: day, content: '# Hi', ...extra });
const fileOf = (...blogs) => blogsWithHash({ blogs }).blogs;
const byId = (blogs, id) => blogs.find((b) => b.id === id);
const TODAY = '2026-10-21';
const NOW = new Date('2026-10-21T09:00:00Z');
const decide = (blogs, decisions) => planDecisions({ fileName: 'w.json', blogs, decisions, by: 'ana@team.test', today: TODAY, now: NOW });

test('the hash is the same whatever the key order, and changes with any field', () => {
  const a = { id: 'B1', topic: 'T', publish_date: '2026-10-26', keywords: ['x', 'y'] };
  const b = { keywords: ['x', 'y'], publish_date: '2026-10-26', topic: 'T', id: 'B1' };
  assert.equal(blogHash(a), blogHash(b));
  assert.notEqual(blogHash(a), blogHash({ ...a, topic: 'T2' }));
  assert.notEqual(blogHash(a), blogHash({ ...a, keywords: ['y', 'x'] })); // order inside a list matters
  assert.notEqual(blogHash(a), blogHash({ ...a, content: '' }));
});

test('each blog keeps the copy written in the file next to what the page shows', () => {
  const [b] = fileOf(blog('B1', '2026-10-26', { extra_field: 1 }));
  assert.deepEqual(b.raw, blog('B1', '2026-10-26', { extra_field: 1 }));
  assert.equal(b.hash, blogHash(b.raw));
  assert.equal(blogsWithHash({}).error, 'The file has no "blogs" list.');
});

test('approval: no row waits; a row counts only for the version it was made on', () => {
  const row = { status: 'approved', blog_hash: 'h1', decided_by: 'ana@team.test', decided_at: 't', reason: null };
  assert.deepEqual(approvalOf('h1', null), { status: 'waiting' });
  assert.deepEqual(approvalOf('h1', row), { status: 'approved', by: 'ana@team.test', at: 't', reason: '' });
  assert.deepEqual(approvalOf('h2', row), {
    status: 'waiting', earlier: { status: 'approved', by: 'ana@team.test', at: 't', reason: '' } });
});

test('replacing a file drops approvals of blogs that changed or are gone, keeps the rest and every rejection', () => {
  const before = fileOf(blog('B1', '2026-10-26'), blog('B2', '2026-10-27'), blog('B3', '2026-10-28'));
  const rows = [
    { blog_id: 'B1', status: 'approved', blog_hash: byId(before, 'B1').hash },
    { blog_id: 'B2', status: 'approved', blog_hash: byId(before, 'B2').hash },
    { blog_id: 'B3', status: 'approved', blog_hash: byId(before, 'B3').hash },
    { blog_id: 'B4', status: 'rejected', blog_hash: 'old' },
  ];
  const after = fileOf(blog('B1', '2026-10-26'), blog('B2', '2026-10-29')); // B2 moved, B3 removed
  assert.deepEqual(staleApprovals(rows, after), ['B2', 'B3']);
  assert.deepEqual(staleApprovals(rows, before), []);
});

test('approving saves a copy of the blog as it is, with who and when', () => {
  const blogs = fileOf(blog('B1', '2026-10-26', { keywords: ['k'] }));
  const out = decide(blogs, [{ id: 'B1', status: 'approved', hash: blogs[0].hash }]);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.upserts, [{
    file_name: 'w.json', blog_id: 'B1', status: 'approved', blog: blog('B1', '2026-10-26', { keywords: ['k'] }),
    blog_hash: blogs[0].hash, publish_date: '2026-10-26', reason: null, decided_by: 'ana@team.test',
    decided_at: '2026-10-21T09:00:00.000Z',
  }]);
});

test('rejecting needs a reason; back to waiting clears the decision', () => {
  const blogs = fileOf(blog('B1', '2026-10-26'), blog('B2', '2026-10-27'));
  const [b1, b2] = blogs;
  assert.deepEqual(decide(blogs, [{ id: 'B1', status: 'rejected', reason: '  ', hash: b1.hash }]).problems,
    [{ id: 'B1', message: 'Say why it is rejected.' }]);
  const out = decide(blogs, [
    { id: 'B1', status: 'rejected', reason: ' Intro too long ', hash: b1.hash },
    { id: 'B2', status: 'waiting', hash: b2.hash },
  ]);
  assert.deepEqual(out.problems, []);
  assert.equal(out.upserts[0].reason, 'Intro too long');
  assert.deepEqual(out.clear, ['B2']);
});

test('a blog changed since the admin looked at it is not decided (the file was replaced)', () => {
  const blogs = fileOf(blog('B1', '2026-10-26'));
  const out = decide(blogs, [{ id: 'B1', status: 'approved', hash: 'the-version-on-screen' }]);
  assert.equal(out.changed, true);
  assert.deepEqual(out.upserts, []);
});

test('what cannot be approved: a past date, a bad date, a missing or repeated id, an unknown decision', () => {
  const blogs = fileOf(blog('OLD', '2026-10-20'), blog('BAD', '26/10/2026'), blog('TWICE', '2026-10-26'),
    blog('TWICE', '2026-10-27'), blog('OK', '2026-10-21'));
  const h = (id) => byId(blogs, id).hash;
  const out = decide(blogs, [
    { id: 'OLD', status: 'approved', hash: h('OLD') },
    { id: 'BAD', status: 'approved', hash: h('BAD') },
    { id: 'TWICE', status: 'approved', hash: h('TWICE') },
    { id: 'NOPE', status: 'approved', hash: 'x' },
    { id: 'OK', status: 'maybe', hash: h('OK') },
  ]);
  assert.deepEqual(out.problems.map((p) => `${p.id}: ${p.message}`), [
    'OLD: Its date (2026-10-20) has passed.',
    'BAD: Its publish_date is not a real date: fix the file first.',
    'TWICE: This id is used more than once in the file: fix the file first.',
    'NOPE: This blog is not in the file.',
    'OK: Unknown decision.',
  ]);
  // Today is still fine, and a past blog can still be rejected.
  assert.deepEqual(decide(blogs, [{ id: 'OK', status: 'approved', hash: h('OK') }]).problems, []);
  assert.deepEqual(decide(blogs, [{ id: 'OLD', status: 'rejected', reason: 'late', hash: h('OLD') }]).problems, []);
  assert.deepEqual(decide(blogs, []).problems, [{ id: '', message: 'No blogs to decide on.' }]);
});

test('a blog posted or being posted can\'t be decided again; a failed one or a Dev.to draft can', () => {
  const blogs = fileOf(blog('B1', '2026-10-21'), blog('B2', '2026-10-21'));
  const locked = new Set([
    { blog_id: 'B1', status: 'posted', draft: false },
    { blog_id: 'B2', status: 'failed', draft: false },
  ].filter(isLocked).map((r) => r.blog_id));
  const plan = planDecisions({ fileName: 'w.json', blogs, by: 'ana@team.test', today: TODAY, now: NOW, locked,
    decisions: ['B1', 'B2'].map((id) => ({ id, status: 'waiting', hash: byId(blogs, id).hash })) });
  assert.deepEqual(plan.problems.map((x) => x.id), ['B1']);
  assert.equal(plan.changed, false);
  assert.equal(isLocked({ status: 'posting', draft: false }), true);
  assert.equal(isLocked({ status: 'posted', draft: true }), false);
  assert.equal(isLocked(null), false);
});

test('a post row becomes what the page shows', () => {
  assert.equal(postOf(null), null);
  assert.deepEqual(postOf({ status: 'failed', draft: false, url: null, error: 'boom', started_at: 's', posted_at: null }),
    { status: 'failed', draft: false, url: '', error: 'boom', at: 's' });
});

test('removing a blog leaves every other blog as written, and refuses what it must', () => {
  const json = { note: 'kept', blogs: [blog('B1', '2026-10-26'), blog('B2', '2026-10-27', { extra: 1 })] };
  const blogs = blogsWithHash(json).blogs;
  const remove = (id, hash = byId(blogs, id)?.hash, locked) => planRemoval({ json, blogs, id, hash, locked });
  assert.deepEqual(remove('B1').json, { note: 'kept', blogs: [blog('B2', '2026-10-27', { extra: 1 })] });
  assert.equal(remove('B9', 'x').status, 404);
  assert.equal(remove('B1', 'old').status, 409);
  assert.equal(remove('B1', undefined, new Set(['B1'])).status, 400);
  const one = { blogs: [blog('B1', '2026-10-26')] };
  assert.deepEqual(planRemoval({ json: one, blogs: blogsWithHash(one).blogs, id: 'B1', hash: blogsWithHash(one).blogs[0].hash }).json,
    { blogs: [] }); // the last one: the route deletes the file
  const twice = { blogs: [blog('B1', '2026-10-26'), blog('B1', '2026-10-27')] };
  assert.equal(planRemoval({ json: twice, blogs: blogsWithHash(twice).blogs, id: 'B1', hash: 'x' }).status, 400);
});

test('a blog with no content can\'t be approved (posting would fail), but can be rejected', () => {
  const blogs = fileOf(blog('B1', '2026-10-26', { content: '  ' }));
  const [b] = blogs;
  assert.deepEqual(decide(blogs, [{ id: 'B1', status: 'approved', hash: b.hash }]).problems.map((x) => x.message),
    ['It has no content, so it can\'t be posted: fix the file first.']);
  assert.equal(decide(blogs, [{ id: 'B1', status: 'rejected', reason: 'empty', hash: b.hash }]).upserts.length, 1);
});
