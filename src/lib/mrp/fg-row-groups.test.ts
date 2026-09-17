import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFgRowGroups } from './fg-row-groups';
import { computeVirtualGroupWindow } from '../../components/ui/virtual-table-groups';

const options = { showTree: true, aggregated: true, expanded: new Set<number>(), memberCounts: {}, loading: {} };
const items = ['A', 'A', 'B', 'C', 'C', 'A'].map((forgingParent, id) => ({ id, forgingParent }));

test('tree windows retain complete contiguous source groups, without joining separated parents', () => {
  const groups = buildFgRowGroups(items, options);
  assert.deepEqual(groups.map(({ start, end }) => [start, end]), [[0, 2], [2, 3], [3, 5], [5, 6]]);
  assert.deepEqual(groups.flatMap(group => items.slice(group.start, group.end)), items);
  assert.deepEqual(groups.map(group => group.estimatedHeight), [72, 24, 72, 24]);
  assert.deepEqual(groups.map(group => group.stripeStart), [0, 3, 4, 7]);
});

test('collapsed trees keep each main row and all expanded members in one measurable group', () => {
  const expandedItems = [{ id: 1, forgingParent: 'A', aggregatedMembers: ['a', 'b', 'c'] }];
  const expanded = { ...options, showTree: false, expanded: new Set([1]), memberCounts: { 1: 3 } };
  assert.equal(buildFgRowGroups(expandedItems, expanded)[0].estimatedHeight, 96);
  assert.equal(buildFgRowGroups(expandedItems, { ...expanded, loading: { 1: true } })[0].estimatedHeight, 56);
  assert.equal(buildFgRowGroups(expandedItems, { ...expanded, expanded: new Set() })[0].estimatedHeight, 24);
});

test('variable group windows cover every intersecting group and conserve total height', () => {
  for (let count = 0; count < 70; count++) {
    const heights = Array.from({ length: count }, (_, index) => 24 + ((index * 137) % 913));
    const total = heights.reduce((sum, height) => sum + height, 0);
    for (let top = 0; top <= total + 600; top += 379) {
      const window = computeVirtualGroupWindow(heights, top, 600, 1);
      let offset = 0;
      heights.forEach((height, index) => {
        if (offset + height > top && offset < top + 600) {
          assert.ok(index >= window.start && index < window.end, `missing group ${index} at ${top}`);
        }
        offset += height;
      });
      assert.equal(window.topSpacerHeight + heights.slice(window.start, window.end).reduce((sum, height) => sum + height, 0) + window.bottomSpacerHeight, total);
      assert.ok(window.start <= window.end && window.end <= count);
    }
  }
});

test('one oversized tree remains intact, including when viewport starts inside it', () => {
  const window = computeVirtualGroupWindow([24, 9000, 24], 5000, 600, 0);
  assert.deepEqual(window, { start: 1, end: 2, topSpacerHeight: 24, bottomSpacerHeight: 24 });
});
