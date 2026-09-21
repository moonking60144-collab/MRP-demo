import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBufferedAxisWindow, directionalVirtualBuffer, resolveBufferedAxisWindow, virtualSectionWindow } from '../components/ui/virtual-table-axis';

test('方向性預載保留反向基本緩衝，急速捲動仍有像素上限', () => {
  const down = directionalVirtualBuffer(120, 16, 144, 480);
  assert.deepEqual(down, { before: 144, after: 480 });
  assert.deepEqual(directionalVirtualBuffer(-120, 16, 144, 480), { before: 480, after: 144 });
  assert.deepEqual(directionalVirtualBuffer(0, 1000, 144, 480), { before: 144, after: 144 });
  assert(directionalVirtualBuffer(1, 16, 144, 480).after < down.after);
  assert.equal(directionalVirtualBuffer(1000000, 0, 144, 480).after, 480);
});

test('不同列高、月份欄寬、zoom 與快速折返都涵蓋可視資料且守住佔位總尺寸', () => {
  for (const zoom of [1, 1.15, 1.5, 1.75]) {
    for (const source of [Array(200).fill(24), Array.from({ length: 200 }, (_, i) => 24 + i % 5 * 24), Array.from({ length: 87 }, (_, i) => i % 13 === 0 ? 95 : 80)]) {
      const sizes = source.map(size => size * zoom);
      for (const position of [0, 1, 240, 1600, 4700, 1600, 240, 0]) {
        const extent = 520 * zoom;
        const buffer = directionalVirtualBuffer(position, 16, 144 * zoom, 480 * zoom);
        const window = computeBufferedAxisWindow(sizes, position, extent, buffer);
        let offset = 0;
        sizes.forEach((size, index) => {
          if (offset + size > position && offset < position + extent) assert(index >= window.start && index < window.end, `visible item ${index}`);
          offset += size;
        });
        const mounted = sizes.slice(window.start, window.end).reduce((sum, size) => sum + size, 0);
        assert(Math.abs(window.topSpacerHeight + mounted + window.bottomSpacerHeight - offset) < 0.000001);
      }
    }
  }
});

test('緩衝內不更新窗口，快速跳出、縮表與欄寬改變則重新涵蓋可視區', () => {
  const sizes = Array(200).fill(24), buffer = { before: 144, after: 144 };
  const current = computeBufferedAxisWindow(sizes, 500, 520, buffer);
  assert.equal(resolveBufferedAxisWindow(current, sizes, 510, 520, buffer), current);
  const jumped = resolveBufferedAxisWindow(current, sizes, 2500, 520, buffer);
  assert.notEqual(jumped, current);
  assert(jumped.topSpacerHeight <= 2500 && 4800 - jumped.bottomSpacerHeight >= 3020);
  assert.equal(resolveBufferedAxisWindow(jumped, sizes.slice(0, 10), 0, 520, buffer).end, 10);
  const changed = [...sizes]; changed[0] = 48;
  assert.notEqual(resolveBufferedAxisWindow(current, changed, 510, 520, buffer), current);
});

test('跨前期未結、月份群組與倉庫的局部窗口不遺漏或重複資料欄位', () => {
  const counts = [13, 12, 12, 12, 13, 13, 2, 12];
  const total = counts.reduce((a, b) => a + b, 0);
  for (let start = 0; start <= total; start += 3) {
    const end = Math.min(total, start + 17);
    const mounted: number[] = [];
    let offset = 0;
    for (const count of counts) {
      const window = virtualSectionWindow({ start, end }, offset, count);
      assert.equal(window.before + window.end - window.start + window.after, count);
      for (let i = window.start; i < window.end; i++) mounted.push(offset + i);
      offset += count;
    }
    assert.deepEqual(mounted, Array.from({ length: end - start }, (_, i) => start + i));
  }
});
