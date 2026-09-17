import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVirtualGroupWindow, isVirtualGroupViewportCovered, resolveBufferedGroupWindow } from '../components/ui/virtual-table-groups';
import { updateVirtualTableWindow } from '../components/ui/virtual-table-rows';

test('預載視窗在緩衝內沿用，換頁縮表或量測高度改變則重建', () => {
  const heights = Array(200).fill(24);
  const current = computeVirtualGroupWindow(heights, 500, 1020, 6);
  assert.equal(resolveBufferedGroupWindow(current, heights, 600, 600, 6), current);
  const shortened = resolveBufferedGroupWindow(current, heights.slice(0, 10), 0, 600, 6);
  assert.equal(shortened.end, 10);
  const resized = [...heights]; resized[0] = 48;
  assert.notEqual(resolveBufferedGroupWindow(current, resized, 600, 600, 6), current);
});

test('可視區尚未露出 spacer 時，剩餘緩衝不足已提前更新', () => {
  const heights = Array(200).fill(24);
  const current = computeVirtualGroupWindow(heights, 500, 600, 6);
  assert.equal(isVirtualGroupViewportCovered(current, 4800, 600, 600), true);
  const next = resolveBufferedGroupWindow(current, heights, 600, 600, 6);
  assert.notEqual(next, current);
  assert(next.end > current.end);
});

test('快速跳出上下緩衝區必須立即補列，緩衝內保持一般合併更新', () => {
  const window = { topSpacerHeight: 240, bottomSpacerHeight: 3000 };
  assert.equal(isVirtualGroupViewportCovered(window, 4800, 400, 680), true);
  assert.equal(isVirtualGroupViewportCovered(window, 4800, 200, 680), false);
  assert.equal(isVirtualGroupViewportCovered(window, 4800, 1400, 680), false);
  assert.equal(isVirtualGroupViewportCovered({ topSpacerHeight: 3600, bottomSpacerHeight: 0 }, 4800, 4200, 680), true);
});

test('200 列的小幅捲動在可見範圍不變時保留 state identity', () => {
  const heights = Array(200).fill(24);
  let current = computeVirtualGroupWindow(heights, 250, 680, 6);
  let updates = 0;
  for (let top = 250; top < 610; top += 3) {
    const next = computeVirtualGroupWindow(heights, top, 680, 6);
    const result = updateVirtualTableWindow(current, next);
    if (result !== current) updates++;
    assert.deepEqual(result, next);
    current = result;
  }
  assert(updates > 0 && updates < 40);
});

test('不同列高、zoom、捲動位置仍完整涵蓋可見群組', () => {
  for (const zoom of [0.8, 1, 1.25, 1.5]) {
    const heights = Array.from({ length: 200 }, (_, i) => (24 + (i % 7) * 12) * zoom);
    for (const top of [0, 1, 250, 1500, 4000, 9000]) {
      const result = computeVirtualGroupWindow(heights, top, 680, 6);
      let offset = 0;
      for (let i = 0; i < heights.length; i++) {
        const bottom = offset + heights[i];
        if (bottom > top && offset < top + 680) {
          assert(i >= result.start && i < result.end);
        }
        offset = bottom;
      }
      assert.equal(result.topSpacerHeight, heights.slice(0, result.start).reduce((a, b) => a + b, 0));
      assert.equal(result.bottomSpacerHeight, heights.slice(result.end).reduce((a, b) => a + b, 0));
    }
  }
});

test('列範圍相同但量測高度改變時必須更新 spacer', () => {
  const before = computeVirtualGroupWindow(Array(200).fill(24), 1500, 680, 6);
  const heights = Array(200).fill(24);
  heights[199] = 96;
  const after = computeVirtualGroupWindow(heights, 1500, 680, 6);
  assert.equal(before.start, after.start);
  assert.equal(before.end, after.end);
  assert.notEqual(updateVirtualTableWindow(before, after), before);
  assert.equal(after.bottomSpacerHeight - before.bottomSpacerHeight, 72);
});
