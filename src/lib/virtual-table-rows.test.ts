import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeVirtualTableWindow,
  resolveVirtualTableSpacerHeight,
  resolveVirtualTableRowHeight,
  resolveVirtualTableRowNodeCache,
  resolveVirtualTableWindow,
  summarizeVirtualTableRowHeights,
  updateVirtualTableWindow,
} from '../components/ui/virtual-table-rows';

test('visual row height 只在有效量測超過半像素時更新', () => {
  assert.equal(resolveVirtualTableRowHeight(24, 24.4), 24);
  assert.equal(resolveVirtualTableRowHeight(24, 24.75), 24.75);
  assert.equal(resolveVirtualTableRowHeight(24, 0), 24);
  assert.equal(resolveVirtualTableRowHeight(24, Number.NaN), 24);
});

test('一般資料列幾何摘要能辨識不等高列', () => {
  assert.deepEqual(summarizeVirtualTableRowHeights([24, 24, 24]), {
    min: 24,
    max: 24,
    spread: 0,
  });
  assert.deepEqual(summarizeVirtualTableRowHeights([24, 33.5, 24]), {
    min: 24,
    max: 33.5,
    spread: 9.5,
  });
  assert.equal(summarizeVirtualTableRowHeights([0, Number.NaN]), null);
});

test('有上限的同頁列快取可折返重用，但資料或內容版本改變必須失效', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ id: index }));
  let calls = 0;
  const renderRow = (_item: { id: number }, index: number) => `ROW-${index}:${++calls}`;
  const props = { items, renderRow, renderVersion: 'A', maxCachedRows: 96 };
  let current = resolveVirtualTableRowNodeCache({ ...props, current: null, start: 0, end: 40 });
  const first = current.nodes.get(0);
  current = resolveVirtualTableRowNodeCache({ ...props, current, start: 40, end: 80 });
  current = resolveVirtualTableRowNodeCache({ ...props, current, start: 0, end: 40 });
  assert.equal(current.nodes.get(0), first);
  assert.equal(calls, 80);
  for (let start = 80; start < 200; start += 20) {
    current = resolveVirtualTableRowNodeCache({ ...props, current, start, end: Math.min(200, start + 40) });
    assert(current.nodes.size <= 96);
    for (let row = start; row < Math.min(200, start + 40); row++) assert.match(String(current.nodes.get(row)), new RegExp(`^ROW-${row}:`));
  }
  current = resolveVirtualTableRowNodeCache({ ...props, current, start: 0, end: 40, renderVersion: 'B' });
  assert.notEqual(current.nodes.get(0), first);
  assert.equal(current.nodes.size, 40);
  const updated = current.nodes.get(0);
  current = resolveVirtualTableRowNodeCache({ ...props, current, items: items.slice(), start: 0, end: 40, renderVersion: 'B' });
  assert.notEqual(current.nodes.get(0), updated);
});

test('scrollTop 改變但可視列範圍相同時沿用虛擬視窗狀態', () => {
  const current = {
    start: 10,
    end: 40,
    topSpacerHeight: 250,
    bottomSpacerHeight: 1_500,
  };
  assert.equal(updateVirtualTableWindow(current, { ...current }), current);
  assert.deepEqual(updateVirtualTableWindow(current, {
    ...current,
    start: 11,
    topSpacerHeight: 275,
  }), {
    start: 11,
    end: 40,
    topSpacerHeight: 275,
    bottomSpacerHeight: 1_500,
  });
});

test('寬表只 render 可見列與固定 overscan，避免預設頁面失去虛擬化收益', () => {
  assert.deepEqual(computeVirtualTableWindow({
    count: 100,
    scrollTop: 1_000,
    viewportHeight: 500,
    rowHeight: 25,
    overscan: 5,
    enabled: true,
  }), {
    start: 35,
    end: 65,
    topSpacerHeight: 875,
    bottomSpacerHeight: 875,
  });
});

test('50 筆頁面在虛擬化開啟時不會因 overscan 全部掛載', () => {
  assert.deepEqual(computeVirtualTableWindow({
    count: 50,
    scrollTop: 0,
    viewportHeight: 663,
    rowHeight: 25,
    overscan: 6,
    enabled: true,
  }), {
    start: 0,
    end: 39,
    topSpacerHeight: 0,
    bottomSpacerHeight: 275,
  });
});

test('200 筆寬表快速跳到中段時，上下都保留完整可視高度', () => {
  assert.deepEqual(computeVirtualTableWindow({
    count: 200,
    scrollTop: 3_400,
    viewportHeight: 511,
    rowHeight: 25,
    overscan: 6,
    enabled: true,
  }), {
    start: 130,
    end: 163,
    topSpacerHeight: 3_250,
    bottomSpacerHeight: 925,
  });
});

test('overscan 剩餘一半前沿用窗口，低於一半時提前重建', () => {
  const input = {
    count: 100,
    viewportHeight: 617,
    rowHeight: 25,
    overscan: 6,
    enabled: true,
  };
  const initial = computeVirtualTableWindow({ ...input, scrollTop: 0 });

  assert.equal(resolveVirtualTableWindow(initial, { ...input, scrollTop: 175 }), initial);
  assert.equal(resolveVirtualTableWindow(initial, { ...input, scrollTop: 225 }), initial);

  const shifted = resolveVirtualTableWindow(initial, { ...input, scrollTop: 250 });
  assert.notEqual(shifted, initial);
  assert.deepEqual(shifted, {
    start: 4,
    end: 41,
    topSpacerHeight: 100,
    bottomSpacerHeight: 1_475,
  });
  assert.equal(resolveVirtualTableWindow(shifted, { ...input, scrollTop: 275 }), shifted);
});

test('zoom table 的 spacer 先換回 layout 高度，避免視覺高度重複縮放', () => {
  assert.equal(resolveVirtualTableSpacerHeight(777, 1), 777);
  assert.equal(resolveVirtualTableSpacerHeight(777, 1.5), 518);
  assert.equal(resolveVirtualTableSpacerHeight(777, 1.75), 444);
});

test('往回捲出緩衝窗口時重建上方窗口，不保留陳舊列', () => {
  const input = {
    count: 100,
    viewportHeight: 617,
    rowHeight: 25,
    overscan: 6,
    enabled: true,
  };
  const shifted = computeVirtualTableWindow({ ...input, scrollTop: 325 });
  const returned = resolveVirtualTableWindow(shifted, { ...input, scrollTop: 150 });

  assert.deepEqual(returned, {
    start: 0,
    end: 37,
    topSpacerHeight: 0,
    bottomSpacerHeight: 1_575,
  });
});

test('接近底部時回填上方 overscan，維持固定掛載列數', () => {
  assert.deepEqual(computeVirtualTableWindow({
    count: 50,
    scrollTop: 735,
    viewportHeight: 617,
    rowHeight: 25,
    overscan: 6,
    enabled: true,
  }), {
    start: 13,
    end: 50,
    topSpacerHeight: 325,
    bottomSpacerHeight: 0,
  });
});

test('窗口位移只建立新進列，重疊列沿用既有 ReactNode', () => {
  const items = Array.from({ length: 100 }, (_, index) => `row-${index}`);
  const rendered: number[] = [];
  const renderRow = (item: string, rowIndex: number) => {
    rendered.push(rowIndex);
    return `${item}:node`;
  };
  const version = {};
  const initial = resolveVirtualTableRowNodeCache({
    current: null,
    items,
    start: 0,
    end: 37,
    renderRow,
    renderVersion: version,
  });
  assert.equal(initial.nodes.size, 37);
  assert.deepEqual(rendered, Array.from({ length: 37 }, (_, index) => index));

  rendered.length = 0;
  const shifted = resolveVirtualTableRowNodeCache({
    current: initial,
    items,
    start: 7,
    end: 44,
    renderRow,
    renderVersion: version,
  });
  assert.equal(shifted.nodes.size, 37);
  assert.deepEqual(rendered, [37, 38, 39, 40, 41, 42, 43]);
  assert.equal(shifted.nodes.get(7), initial.nodes.get(7));
  assert.equal(shifted.nodes.get(36), initial.nodes.get(36));
  assert.equal(shifted.nodes.has(0), false);
});

test('列內容版本改變時整個可視窗口重新建立', () => {
  const items = Array.from({ length: 10 }, (_, index) => `row-${index}`);
  const initial = resolveVirtualTableRowNodeCache({
    current: null,
    items,
    start: 0,
    end: 5,
    renderRow: (item) => item,
    renderVersion: 'v1',
  });
  const rendered: number[] = [];
  resolveVirtualTableRowNodeCache({
    current: initial,
    items,
    start: 0,
    end: 5,
    renderRow: (_item, rowIndex) => {
      rendered.push(rowIndex);
      return `new-${rowIndex}`;
    },
    renderVersion: 'v2',
  });

  assert.deepEqual(rendered, [0, 1, 2, 3, 4]);
});

test('搜尋縮小資料集時，過期 window 不得把越界 item 傳給 renderer', () => {
  const renderedItems: string[] = [];
  const next = resolveVirtualTableRowNodeCache({
    current: null,
    items: ['only-result'],
    start: 0,
    end: 37,
    renderRow: (item) => {
      renderedItems.push(item);
      return `${item}:node`;
    },
    renderVersion: 'search-result',
  });

  assert.deepEqual(renderedItems, ['only-result']);
  assert.equal(next.nodes.size, 1);
  assert.equal(next.nodes.get(0), 'only-result:node');
});

test('搜尋縮表的同一次 render 會先把舊 window 收斂到最新 count', () => {
  assert.deepEqual(resolveVirtualTableWindow({
    start: 0,
    end: 37,
    topSpacerHeight: 0,
    bottomSpacerHeight: 4_075,
  }, {
    count: 1,
    scrollTop: 0,
    viewportHeight: 617,
    rowHeight: 25,
    overscan: 6,
    enabled: false,
  }), {
    start: 0,
    end: 1,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
  });
});

test('明確關閉虛擬化時保留完整列，供展開群組使用', () => {
  assert.deepEqual(computeVirtualTableWindow({
    count: 50,
    scrollTop: 400,
    viewportHeight: 300,
    rowHeight: 25,
    overscan: 5,
    enabled: false,
  }), {
    start: 0,
    end: 50,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
  });
});
