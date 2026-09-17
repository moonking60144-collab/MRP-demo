import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { reconcileWorkOrderBomLinks } from './sync-engine';
import { aggregateComponentWeeklyUsageRows } from '../mrp/component-weekly-engine';
import { summarizeComponentWeeklyUsage } from '../mrp/component-weekly-usage';
import { generateWeeklyPeriods } from '../mrp/period-utils';
import { classifyWorkOrderMaterialAnomaly, classifyWorkOrderMaterialUsageWarning } from '../mrp/work-order-material-anomaly';

test('解除工令關聯的 BOM 保留原始數量，但同步後不再形成週推需求，歷史 Run 不變', {
  skip: !process.env.MRP_BOM_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.MRP_BOM_TEST_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'mrp_fix_test');
  assert.equal(url.pathname, '/mrp_bom_test');
  assert.ok(url.port && url.port !== '5432');
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    await db.$transaction(async (tx) => {
      await tx.stagingWorkOrderBom.deleteMany({ where: { mrpRunId: { in: [233, 234] } } });
      await tx.stagingWorkOrder.deleteMany({ where: { mrpRunId: { in: [233, 234] } } });
      await tx.stagingWorkOrder.createMany({ data: [
        { mrpRunId: 234, woNumber: ' WO-A ', status: '未結案' },
        { mrpRunId: 234, woNumber: 'WO-CLOSED', status: '已結案' },
        { mrpRunId: 233, woNumber: 'WO-OTHER-RUN', status: '未結案' },
      ] });
      const cases = [
        { ragicRecordId: '23670', woNumber: null, minUsage: 451, remainingUsage: 451 },
        { ragicRecordId: 'blank', woNumber: '   ', minUsage: 400, remainingUsage: 400 },
        { ragicRecordId: 'missing', woNumber: 'WO-MISSING', minUsage: 600, remainingUsage: 600 },
        { ragicRecordId: 'other-run', woNumber: 'WO-OTHER-RUN', minUsage: 700, remainingUsage: 700 },
        { ragicRecordId: 'closed', woNumber: 'WO-CLOSED', minUsage: 800, remainingUsage: 800 },
        { ragicRecordId: 'valid', woNumber: 'WO-A', minUsage: 900, remainingUsage: 300 },
      ];
      const weeks = generateWeeklyPeriods(new Date('2026-06-08T00:00:00Z'), 2);
      await tx.stagingWorkOrderBom.createMany({ data: cases.map((row) => ({
        ...row, mrpRunId: 234, componentNo: '0110711000-V01-01BU',
        unit: 'pc', sourceType: '採購', issuedQtyState: 'known',
        issuedQty: row.minUsage - row.remainingUsage,
        startDate: new Date('2026-06-11T00:00:00Z'),
      })) });
      await tx.stagingWorkOrderBom.create({ data: {
        ...cases[0], mrpRunId: 233, componentNo: 'HISTORICAL',
      } });
      const historyBefore = await tx.stagingWorkOrderBom.findMany({ where: { mrpRunId: 233 } });
      assert.equal(await reconcileWorkOrderBomLinks(234, tx), 5, 'ORPHAN_BOM_EXCLUSION');
      assert.equal(await reconcileWorkOrderBomLinks(234, tx), 0, 'repeat reconciliation must be idempotent');
      assert.deepEqual(await tx.stagingWorkOrderBom.findMany({ where: { mrpRunId: 233 } }), historyBefore);
      const rows = await tx.stagingWorkOrderBom.findMany({ where: { mrpRunId: 234 }, orderBy: { id: 'asc' } });
      for (const row of rows.slice(0, 5)) {
        assert.equal(row.issuedQtyError, 'unlinked_work_order');
        assert.equal(row.remainingUsage, null);
        assert.equal(classifyWorkOrderMaterialAnomaly(row).level, 'blocking');
        assert.equal(classifyWorkOrderMaterialUsageWarning(row)?.reason, 'unlinked_work_order');
      }
      assert.equal(Number(rows[0].minUsage), 451);
      assert.equal(Number(rows[0].issuedQty), 0);
      const { usageMap } = aggregateComponentWeeklyUsageRows(rows, weeks);
      assert.equal([...usageMap.values()].flatMap((row) => [...row.values()]).reduce((a, b) => a + b, 0), 300);
      const detail = summarizeComponentWeeklyUsage({
        materialPartNo: '0110711000-V01-01BU', weeks, weekIndex: null,
        expectedUsage: 300, bomRows: rows,
        workOrders: await tx.stagingWorkOrder.findMany({ where: { mrpRunId: 234 } }),
      });
      assert.equal(detail.includedTotal, 300);
      assert.equal(detail.reconciled, true);
      assert.equal(detail.excluded.filter((row) => row.reason === 'unlinked_work_order').length, 5);
    }, { timeout: 15_000 });
  } finally {
    await db.$disconnect();
  }
});
