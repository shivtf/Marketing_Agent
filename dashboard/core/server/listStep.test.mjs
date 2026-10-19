import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neighbours } from '../listStep.js';

const list = (...ids) => ids.map((id) => ({ id }));

test('Previous and Next are the items on either side of the open one', () => {
  assert.deepEqual(neighbours(list('a', 'b', 'c'), 'b'), { index: 1, prev: { id: 'a' }, next: { id: 'c' } });
  assert.deepEqual(neighbours(list('a', 'b'), 'a'), { index: 0, prev: undefined, next: { id: 'b' } });
  assert.deepEqual(neighbours(list('a', 'b'), 'b'), { index: 1, prev: { id: 'a' }, next: undefined });
});

test('an item that left the list (labelled into another group): carry on from where it was', () => {
  // 'b' was at 1 and has left: Next is 'c', which moved into its place; Previous is 'a'.
  assert.deepEqual(neighbours(list('a', 'c'), 'b', 1), { index: -1, prev: { id: 'a' }, next: { id: 'c' } });
  // It was the last one: no Next.
  assert.deepEqual(neighbours(list('a'), 'b', 1), { index: -1, prev: { id: 'a' }, next: undefined });
  // It was the only one: nothing either way.
  assert.deepEqual(neighbours([], 'b', 0), { index: -1, prev: undefined, next: undefined });
});

test('an item opened from elsewhere that was never in the list: no Previous or Next', () => {
  assert.deepEqual(neighbours(list('a', 'b'), 'x'), { index: -1, prev: undefined, next: undefined });
});
