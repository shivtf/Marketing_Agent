import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byPerson, repliesOf, tabOf, whyOf } from '../positiveTabs.js';

// One reply as /leads/positive lists it.
const reply = (id, leadId, repliedAt, extra = {}) => ({
  id, leadId, repliedAt, followUp: 'waiting', labelledByPerson: false, label: null, preview: '', scoreHits: [],
  reviewReason: null, ...extra,
});
const empty = { positive: [], review: [], questions: [], notInterested: [], unsubscribe: [], repliedLeads: 0 };

test('each person is listed once, on their newest reply', () => {
  const data = {
    ...empty,
    positive: [reply('yes', 'carl', '2026-10-01')],
    notInterested: [reply('no', 'carl', '2026-10-05', { followUp: 'none' })],
    questions: [reply('q', 'priya', '2026-10-03')],
  };
  const tabs = byPerson(data);
  assert.deepEqual(tabs.closed.map((r) => r.id), ['no']); // Carl said no after his yes
  assert.deepEqual(tabs.closed[0].earlier.map((r) => r.id), ['yes']);
  assert.deepEqual(tabs.reply.map((r) => r.id), ['q']);
  assert.equal(tabs.answered.length + tabs.check.length, 0);
});

test('the tab says what to do next', () => {
  assert.equal(tabOf({ group: 'positive', followUp: 'waiting' }), 'reply');
  assert.equal(tabOf({ group: 'questions', followUp: 'waiting' }), 'reply');
  assert.equal(tabOf({ group: 'positive', followUp: 'replied' }), 'answered');
  assert.equal(tabOf({ group: 'review', followUp: 'waiting' }), 'check');
  assert.equal(tabOf({ group: 'review', followUp: 'replied' }), 'answered');
  assert.equal(tabOf({ group: 'unsubscribe', labelledByPerson: false }), 'check'); // only the keywords suspect it
  assert.equal(tabOf({ group: 'unsubscribe', labelledByPerson: true }), 'closed');
  assert.equal(tabOf({ group: 'notInterested', followUp: 'none' }), 'closed');
});

test('waiting tabs list the longest waiting first, the others the newest first', () => {
  const data = {
    ...empty,
    positive: [reply('a', 'a', '2026-10-05'), reply('b', 'b', '2026-10-01'),
      reply('c', 'c', '2026-10-02', { followUp: 'replied' }), reply('d', 'd', '2026-10-06', { followUp: 'replied' })],
  };
  const tabs = byPerson(data);
  assert.deepEqual(tabs.reply.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(tabs.answered.map((r) => r.id), ['d', 'c']);
});

test('a person\'s replies, newest first, with their group', () => {
  const data = { ...empty, positive: [reply('old', 'x', '2026-10-01')], review: [reply('new', 'x', '2026-10-04')] };
  assert.deepEqual(repliesOf(data, 'x').map((r) => [r.id, r.group]), [['new', 'review'], ['old', 'positive']]);
});

test('why, in plain words', () => {
  const hit = (phrase) => [{ phrase, weight: 0.25 }];
  assert.equal(whyOf({ group: 'positive', scoreHits: hit("let's talk"), preview: '' }).text, 'Wants a call');
  assert.equal(whyOf({ group: 'positive', scoreHits: hit('sounds great'), preview: 'Send me the pricing' }).text,
    'Wants pricing');
  assert.equal(whyOf({ group: 'positive', scoreHits: hit('interested'), preview: 'Interested!' }).text, 'Interested');
  assert.equal(whyOf({ group: 'questions', preview: 'What does it cost?' }).text, 'Asked a price');
  assert.equal(whyOf({ group: 'questions', preview: 'Who else uses it?' }).text, 'Asked a question');
  assert.equal(whyOf({ group: 'review', reviewReason: 'Asks to be contacted later' }).text, 'Contact later');
  assert.equal(whyOf({ group: 'review', reviewReason: 'Points you to someone else: write to them' }).text,
    'Points to someone else');
  assert.equal(whyOf({ group: 'review', reviewReason: 'Score 0.55: says both yes and no' }).text, 'Mixed yes and no');
  assert.equal(whyOf({ group: 'review', reviewReason: 'Score 0.30: only a soft no (it may mean later)' }).text, 'Soft no');
  assert.equal(whyOf({ group: 'review', reviewReason: 'No keywords matched' }).text, 'Unclear');
  assert.equal(whyOf({ group: 'notInterested' }).text, 'Said no');
  assert.equal(whyOf({ group: 'unsubscribe' }).text, 'May want to stop');
  // A person's label is shown as given, with the score detail left out.
  const labelled = whyOf({ group: 'positive', labelledByPerson: true, label: 'interested' });
  assert.deepEqual(labelled, { text: 'Interested', tone: 'green', title: 'Labelled by a person' });
  // The tooltip names what matched.
  assert.equal(whyOf({ group: 'positive', scoreHits: hit("let's talk"), preview: '' }).title, 'Matched: “let\'s talk”');
});
