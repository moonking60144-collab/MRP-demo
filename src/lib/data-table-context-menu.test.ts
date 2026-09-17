import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CellContextMenu } from '@/components/data-table/ui/cell-context-menu';

const noop = () => {};

function renderMenu({
  isVirtual = false,
  canFreezeColumn = () => true,
}: {
  isVirtual?: boolean;
  canFreezeColumn?: (columnId: string) => boolean;
}) {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1280, innerHeight: 800 },
  });

  try {
    return renderToStaticMarkup(React.createElement(CellContextMenu, {
      position: { x: 100, y: 100 },
      target: {
        col: {
          id: 'stockWeeks',
          header: '庫存週數',
          filterType: 'numeric',
        },
        value: 4,
        formattedValue: '4',
        rowId: isVirtual ? undefined : 42,
        isVirtual,
      },
      columnFilters: [],
      onSetFilter: noop,
      onRemoveFilter: noop,
      onClose: noop,
      sortFields: [],
      onAddSort: noop,
      onRemoveSort: noop,
      onToggleColumn: noop,
      onFreezeToColumn: noop,
      canFreezeColumn,
      onPinRow: noop,
    }));
  } finally {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  }
}

test('一般資料格右鍵提供欄位操作與釘選', () => {
  const markup = renderMenu({});

  assert.match(markup, /以此值篩選/);
  assert.match(markup, /此欄升冪排序/);
  assert.match(markup, /隱藏此欄/);
  assert.match(markup, /凍結到此欄/);
  assert.match(markup, /釘選此列到頂端/);
  assert.match(markup, /複製此值/);
});

test('不可凍結的欄位不顯示凍結選項', () => {
  const markup = renderMenu({ canFreezeColumn: () => false });

  assert.doesNotMatch(markup, /凍結到此欄/);
  assert.match(markup, /隱藏此欄/);
});

test('虛擬期推移格不提供欄位篩選排序與隱藏', () => {
  const markup = renderMenu({ isVirtual: true });

  assert.doesNotMatch(markup, /以此值篩選/);
  assert.doesNotMatch(markup, /此欄升冪排序/);
  assert.doesNotMatch(markup, /隱藏此欄/);
  assert.doesNotMatch(markup, /凍結到此欄/);
  assert.match(markup, /複製此值/);
});
