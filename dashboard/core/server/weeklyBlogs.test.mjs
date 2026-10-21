import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpload, findBlog, readBlogs, thisMonday } from '../weeklyBlogs.js';

const TODAY = new Date('2026-10-21T10:00:00Z'); // a Wednesday: this week starts Monday 2026-10-19
const blog = (id, day, extra = {}) => ({ id, topic: `Topic ${id}`, publish_date: day, content: '# Hi', ...extra });
const file = (...blogs) => JSON.stringify({ blogs });
const messages = (r) => r.errors.map((e) => `${e.id}: ${e.message}`);

test('this week starts on its Monday, also on a Monday and a Sunday', () => {
  assert.equal(thisMonday(TODAY), '2026-10-19');
  assert.equal(thisMonday(new Date('2026-10-19T00:00:00Z')), '2026-10-19');
  assert.equal(thisMonday(new Date('2026-10-25T23:59:00Z')), '2026-10-19');
});

test('a good file for next week passes', () => {
  const r = checkUpload(file(blog('BLG-1', '2026-10-26'), blog('BLG-2', '2026-10-31')), '2026-10-26', TODAY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.blogs.map((b) => b.id), ['BLG-1', 'BLG-2']);
});

test('this week is still allowed (to correct it); a week already over is not', () => {
  assert.deepEqual(checkUpload(file(blog('BLG-1', '2026-10-24')), '2026-10-19', TODAY).errors, []);
  const past = checkUpload(file(blog('BLG-1', '2026-10-13')), '2026-10-12', TODAY);
  assert.deepEqual(messages(past), [': The week of 2026-10-12 is already over.']);
});

test('text that is not JSON, or has no "blogs" list, cannot be read at all', () => {
  assert.match(checkUpload('{"blogs": [', '2026-10-26', TODAY).error, /not valid JSON/);
  assert.equal(checkUpload('{}', '2026-10-26', TODAY).error, 'The file has no "blogs" list.');
  assert.equal(checkUpload('[]', '2026-10-26', TODAY).error, 'The file has no "blogs" list.');
});

test('every rule the page shows is an error here too', () => {
  assert.deepEqual(messages(checkUpload(file(), '2026-10-26', TODAY)), [': The "blogs" list is empty.']);
  const r = checkUpload(file(
    blog('', '2026-10-26'),
    blog('BLG-2', '2026-10-27', { topic: '' }),
    blog('BLG-2', '2026-10-28'),
    blog('BLG-4', '2026-11-02'),
    blog('BLG-5', '2026-02-30'),
  ), '2026-10-26', TODAY);
  assert.deepEqual(messages(r).sort(), [
    'Blog #1: Missing id.',
    'BLG-2: Missing topic.',
    'BLG-2: This id is used more than once.',
    'BLG-5: publish_date must be a real date written as YYYY-MM-DD.',
    'BLG-4: 2026-11-02 is not in this week (2026-10-26 to 2026-10-31).',
  ].sort());
});

test('no content or two blogs on one day are warnings only', () => {
  const r = checkUpload(file(blog('BLG-1', '2026-10-26', { content: '' }), blog('BLG-2', '2026-10-26')), '2026-10-26', TODAY);
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
