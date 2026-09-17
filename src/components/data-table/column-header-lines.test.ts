import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColumnHeaderButton, type ColumnHeaderMenuController } from './ui/column-header-menu';

test('共用表頭預設保持兩行，產銷可局部選用三行而不改其他報表', () => {
  const controller = {
    sortByColumnId: new Map(), filteredColumnIds: new Set(), open: false,
    activeColumn: null, openColumnMenu: () => {},
  } as unknown as ColumnHeaderMenuController;
  const props = { column: { id: 'stockWeeks', header: '庫存可支應週數', filterType: 'numeric' as const }, controller };
  const defaultMarkup = renderToStaticMarkup(React.createElement(ColumnHeaderButton, props));
  const salesMarkup = renderToStaticMarkup(React.createElement(ColumnHeaderButton, { ...props, labelMaxLines: 3 }));
  assert.match(defaultMarkup, /max-height:2\.35em/);
  assert.match(salesMarkup, /max-height:3\.50em/);
});
