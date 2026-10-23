import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blogToday, checkUpload, findBlog, lastPostDay, readBlogs, thisMonday, weekOf } from '../weeklyBlogs.js';

const TODAY = new Date('2026-10-21T10:00:00Z'); // a Wednesday: this week starts Monday 2026-10-19
const blog = (id, day, extra = {}) => ({ id, topic: `Topic ${id}`, publish_date: day, content: '# Hi', ...extra });
const file = (...blogs) => JSON.stringify({ blogs });
const messages = (r) => r.errors.map((e) => `${e.id}: ${e.message}`);

test('this week starts on its Monday, also on a Monday and a Sunday', () => {
  assert.equal(thisMonday(TODAY), '2026-10-19');
  assert.equal(thisMonday(new Date('2026-10-19T00:00:00Z')), '2026-10-19');
  assert.equal(thisMonday(new Date('2026-10-25T18:00:00Z')), '2026-10-19'); // Sunday 23:30 in India
  assert.equal(thisMonday(new Date('2026-10-25T18:40:00Z')), '2026-10-26'); // already Monday in India, Sunday in UTC
});

test('the blog day is India time, whatever the server clock', () => {
  assert.equal(blogToday(new Date('2026-10-21T18:29:00Z')), '2026-10-21');
  assert.equal(blogToday(new Date('2026-10-21T18:31:00Z')), '2026-10-22');
});

test('the week is read from the blogs\' dates and names the file', () => {
  const r = checkUpload(file(blog('BLG-1', '2026-10-27'), blog('BLG-2', '2026-10-31')), TODAY);
  assert.equal(r.monday, '2026-10-26');
  assert.equal(r.fileName, '26_10_26-31_10_26.json');
  assert.equal(checkUpload(file(blog('BLG-1', '2026-11-04')), TODAY).fileName, '02_11_26-07_11_26.json'); // weeks ahead
});

test('a file across two weeks, with a Sunday (Wed Oct 21 to Mon Oct 26), is refused with why', () => {
  const r = checkUpload(file(...['21', '22', '23', '24', '25', '26'].map((d, i) => blog(`blog-${i}`, `2026-10-${d}`))), TODAY);
  assert.equal(r.monday, '2026-10-19'); // most of them are in that week
  assert.deepEqual(messages(r), [
    ': The blogs are in 2 different weeks (2026-10-19 to 2026-10-24, 2026-10-26 to 2026-10-31): one file holds one week, Monday to Saturday.',
    'blog-4: 2026-10-25 is a Sunday: a week is Monday to Saturday.',
    'blog-5: 2026-10-26 is not in this week (2026-10-19 to 2026-10-24).',
  ]);
});

test('without one real date the week is unknown', () => {
  assert.deepEqual(weekOf(readBlogs({ blogs: [blog('B', 'soon')] }).blogs), { monday: null, weeks: [] });
  const r = checkUpload(file(blog('B', 'soon')), TODAY);
  assert.equal(r.fileName, null);
  assert.deepEqual(messages(r), ['B: publish_date must be a real date written as YYYY-MM-DD.']);
});

test('a good file for next week passes', () => {
  const r = checkUpload(file(blog('BLG-1', '2026-10-26'), blog('BLG-2', '2026-10-31')), TODAY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.blogs.map((b) => b.id), ['BLG-1', 'BLG-2']);
});

test('this week is still allowed (to correct it); a week already over is not', () => {
  assert.deepEqual(checkUpload(file(blog('BLG-1', '2026-10-24')), TODAY).errors, []);
  const past = checkUpload(file(blog('BLG-1', '2026-10-13')), TODAY);
  assert.deepEqual(messages(past), [': The week of 2026-10-12 is already over.']);
});

test('text that is not JSON, or has no "blogs" list, cannot be read at all', () => {
  assert.match(checkUpload('{"blogs": [', TODAY).error, /not valid JSON/);
  assert.equal(checkUpload('{}', TODAY).error, 'The file has no "blogs" list.');
  assert.equal(checkUpload('[]', TODAY).error, 'The file has no "blogs" list.');
});

test('every rule the page shows is an error here too', () => {
  assert.deepEqual(messages(checkUpload(file(), TODAY)), [': The "blogs" list is empty.']);
  const r = checkUpload(file(
    blog('', '2026-10-26'),
    blog('BLG-2', '2026-10-27', { topic: '' }),
    blog('BLG-2', '2026-10-28'),
    blog('BLG-4', '2026-11-02'),
    blog('BLG-5', '2026-02-30'),
  ), TODAY);
  assert.deepEqual(messages(r).sort(), [
    ': The blogs are in 2 different weeks (2026-10-26 to 2026-10-31, 2026-11-02 to 2026-11-07): one file holds one week, Monday to Saturday.',
    'Blog #1: Missing id.',
    'BLG-2: Missing title (or topic).',
    'BLG-2: This id is used more than once.',
    'BLG-5: publish_date must be a real date written as YYYY-MM-DD.',
    'BLG-4: 2026-11-02 is not in this week (2026-10-26 to 2026-10-31).',
  ].sort());
});

test('no content or two blogs on one day are warnings only', () => {
  const r = checkUpload(file(blog('BLG-1', '2026-10-26', { content: '' }), blog('BLG-2', '2026-10-26')), TODAY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.message), ['No content: the blog text is empty.', '2 blogs are on 2026-10-26.']);
});

// The schedule row clicked (as the list sent it), then the file read again when the viewer opens.
const blogsIn = (...blogs) => readBlogs({ blogs }).blogs;
const rowFor = (blogs, id) => blogs.find((b) => b.id === id);

test('the viewer finds the blog by its id, even after the file was replaced and the blogs moved', () => {
  const before = blogsIn(blog('BLG-1', '2026-10-26'), blog('BLG-2', '2026-10-27'));
  const row = rowFor(before, 'BLG-2'); // 2nd in the file
  const after = blogsIn(blog('BLG-0', '2026-10-26'), blog('BLG-1', '2026-10-27'), blog('BLG-2', '2026-10-27'));
  assert.equal(after[1].n, 2); // position 2 is now another blog: the old lookup showed BLG-1 here
  assert.deepEqual(findBlog(after, row), { blog: after[2], changed: false });
});

test('a blog whose topic or date was changed is still found, and marked as changed', () => {
  const row = rowFor(blogsIn(blog('BLG-1', '2026-10-26')), 'BLG-1');
  const moved = blogsIn(blog('BLG-1', '2026-10-28'));
  assert.equal(findBlog(moved, row).changed, true);
  const renamed = blogsIn(blog('BLG-1', '2026-10-26', { topic: 'New title' }));
  assert.equal(findBlog(renamed, row).changed, true);
});

test('a blog taken out of the file is gone, not swapped for another one', () => {
  const row = rowFor(blogsIn(blog('BLG-1', '2026-10-26'), blog('BLG-2', '2026-10-27')), 'BLG-2');
  assert.equal(findBlog(blogsIn(blog('BLG-1', '2026-10-26'), blog('BLG-3', '2026-10-27')), row), null);
});

test('an old file without ids: by position, but only while the topic is the same', () => {
  const row = blogsIn(blog('', '2026-10-26', { topic: 'A' }), blog('', '2026-10-27', { topic: 'B' }))[1];
  const same = blogsIn(blog('', '2026-10-26', { topic: 'A' }), blog('', '2026-10-27', { topic: 'B' }));
  assert.equal(findBlog(same, row).blog.topic, 'B');
  const other = blogsIn(blog('', '2026-10-26', { topic: 'A' }), blog('', '2026-10-27', { topic: 'C' }));
  assert.equal(findBlog(other, row), null);
});

test('title and one reference_url are read too (the files the generator writes)', () => {
  const [b] = readBlogs({ blogs: [blog('B1', '2026-10-26', { title: 'Real title', reference_url: 'https://a.test' })] }).blogs;
  assert.equal(b.title, 'Real title');
  assert.deepEqual(b.referenceUrls, ['https://a.test']);
  assert.deepEqual(messages(checkUpload(file(blog('B1', '2026-10-26', { topic: '', title: 'T' })), TODAY)), []);
});

test('a missed blog can be posted until the Saturday of its week, a Sunday one only that day', () => {
  assert.equal(lastPostDay('2026-10-19'), '2026-10-24'); // Monday
  assert.equal(lastPostDay('2026-10-22'), '2026-10-24'); // Thursday
  assert.equal(lastPostDay('2026-10-24'), '2026-10-24'); // Saturday
  assert.equal(lastPostDay('2026-10-25'), '2026-10-25'); // Sunday
});
