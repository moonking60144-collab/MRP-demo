import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { mapInventoryRecord, reconcileInventorySnapshot } from './sync-engine';

test('新庫存列以零初始化六個批號快照欄位', () => {
  const row = mapInventoryRecord(38, {
    _ragic_id: '43838',
    '1005345': 'ERP-V01',
    '1028374': '25,111',
  });

  assert.deepEqual({
    inStockPc: row.inStockPc,
    inStockKg: row.inStockKg,
    wfgStockPc: row.wfgStockPc,
    wfgStockKg: row.wfgStockKg,
    ye1StockPc: row.ye1StockPc,
    ye1StockKg: row.ye1StockKg,
  }, {
    inStockPc: 0,
    inStockKg: 0,
    wfgStockPc: 0,
    wfgStockKg: 0,
    ye1StockPc: 0,
    ye1StockKg: 0,
  });
});

test('庫存同步先正規化 ERP 料號，讓計算與來源查詢使用相同 key', () => {
  const row = mapInventoryRecord(38, {
    _ragic_id: 'trimmed-erp',
    '1005345': '  ERP-V01  ',
  });

  assert.equal(row.erpPartNo, 'ERP-V01');
});

test('庫存快照保留採購前置期空白與明確零週的差異', () => {
  const blankLead = mapInventoryRecord(38, {
    _ragic_id: 'blank-lead',
    '1005345': 'ERP-BLANK',
  });
  const zeroLead = mapInventoryRecord(38, {
    _ragic_id: 'zero-lead',
    '1005345': 'ERP-ZERO',
    '1037338': '0',
  });
  const configuredLead = mapInventoryRecord(38, {
    _ragic_id: 'configured-lead',
    '1005345': 'ERP-12W',
    '1037338': '12',
  });

  assert.deepEqual(
    [
      [blankLead.purchaseLeadWeeks, blankLead.purchaseLeadWeeksConfigured],
      [zeroLead.purchaseLeadWeeks, zeroLead.purchaseLeadWeeksConfigured],
      [configuredLead.purchaseLeadWeeks, configuredLead.purchaseLeadWeeksConfigured],
    ],
    [
      [0, false],
      [0, true],
      [12, true],
    ],
  );
});

test('庫存批號聚合只更新六個快照欄位有差異的列', async () => {
  let queryText = '';
  const db = {
    $executeRaw: async (query: Prisma.Sql) => {
      queryText = query.strings.join('?');
      return 1;
    },
  } as unknown as Pick<Prisma.TransactionClient, '$executeRaw'>;

  const result = await reconcileInventorySnapshot(35, db);

  assert.equal(result.updatedRows, 1);
  assert.match(queryText, /summary AS MATERIALIZED/);
  assert.match(queryText, /summary_map AS MATERIALIZED/);
  assert.match(queryText, /jsonb_object_agg/);
  for (const column of [
    'in_stock_pc',
    'in_stock_kg',
    'wfg_stock_pc',
    'wfg_stock_kg',
    'ye1_stock_pc',
    'ye1_stock_kg',
  ]) {
    assert.match(
      queryText,
      new RegExp(`inventory\\.${column} IS DISTINCT FROM reconciled\\.${column}`),
    );
  }
});
