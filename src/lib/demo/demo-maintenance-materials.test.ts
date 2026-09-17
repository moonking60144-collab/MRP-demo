import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '@/app/demo-api/[...path]/route';
import { dataset, type DemoRow } from './data';
import { hydrateRows } from './calculator';
import { prepareDemo } from './run-control';
import { latestRun } from './store';
import { resolveWorkOrderMaterialLedgers, type WorkOrderLedgerMovement } from '../mrp/work-order-material-ledger';
import { resolveComponentWeeklyMovementInventoryFeedback } from '../mrp/component-weekly-movement-feedback';

async function query(path: string) {
  const url = new URL(`http://127.0.0.1:3142/demo-api/${path}`);
  const response = await GET(new NextRequest(url), { params: Promise.resolve({ path: url.pathname.slice('/demo-api/'.length).split('/') }) });
  assert.equal(response.status, 200);
  return response.json();
}
test.before(async () => prepareDemo());

test('Demo 維運與合成容量不是取得失敗，也不宣告真實維運成功', async () => {
  const maintenance = await query('maintenance-status');
  assert.equal(maintenance.demo, true);
  assert.equal(maintenance.ragic, null);
  assert.equal(maintenance.backup.enabled, false);
  assert.equal(maintenance.retention.enabled, false);
  assert.equal(maintenance.backup.latestBackup, null);
  const storage = await query('storage-status');
  assert.equal(storage.demo, true);
  assert.deepEqual(storage.warnings, []);
  assert.ok(storage.volumes.every((row: { label: string }) => row.label.startsWith('模擬')));
});

test('元件批號可用量守恆，Form 20 原始交易可獨立對回 BOM、週推與來源身分', async () => {
  const runId = latestRun().id, data = dataset(runId);
  for (const component of data.cw) {
    const unit = component.unit === 'kg' ? 'Kg' : 'Pc';
    const lots = data.source.inventory_lots.filter(row => row.erpPartNo === component.materialPartNo);
    assert.ok(lots.length >= 2);
    assert.ok(lots.every(row => row.mrpRunId === runId));
    const available = lots.filter(row => row.stockStatus === '在庫' && row.qualityStatus === '正常');
    assert.equal(available.reduce((sum, row) => sum + Number(row[`stock${unit}`]), 0), Number(component[`goodStock${unit}`]));
  }
  for (const [material, type, gross, out, returned, reserved, count] of [
    ['DEMO-B-003', 'B', 1500, 0, 0, 1500, 2],
    ['DEMO-D-004', 'D', 3000, 3000, 0, 0, 3],
    ['DEMO-B-005', 'B', 3000, 3000, 300, 0, 4],
  ] as const) {
    const detail = await query(`component-weekly/${material}/usage-details?runId=${runId}&mrpType=${type}&weekIndex=all`);
    assert.equal(detail.movements.length, count, 'MATERIAL_MOVEMENTS_REQUIRED');
    assert.equal(detail.movementContext.length, count);
    const bom = data.source.work_order_bom.find(row => row.componentNo === material && row.issuedQtyState === 'known')!;
    assert.ok(detail.movements.every((row: DemoRow) => row.workOrderNo === bom.woNumber && row.componentNo === material && row.mrpRunId === runId));
    const sourceOut = detail.movements.filter((row: DemoRow) => row.movementType === 'OUT出庫').reduce((sum: number, row: DemoRow) => sum - Number(row.movementQtyPc), 0);
    const sourceReturn = detail.movements.filter((row: DemoRow) => row.basisType === '入-製令單退料').reduce((sum: number, row: DemoRow) => sum + Number(row.movementQtyPc), 0);
    assert.equal(sourceOut, out); assert.equal(sourceReturn, returned);
    assert.equal(bom.grossIssuedQty, gross);
    assert.equal(bom.consumedQty, out - returned);
    assert.equal(bom.returnedQty, returned);
    assert.equal(bom.netIssuedQty, gross - returned);
    assert.equal(bom.reservedQty, reserved);
    assert.equal(bom.remainingUsage, Number(bom.minUsage) - gross + returned);
    const allocations = [{ bomRecordId: String(bom.ragicRecordId), workOrderNo: String(bom.woNumber), bomItemKey: String(bom.ragicRecordId), componentNo: material, inventoryLotNo: detail.movements[0].inventoryLotNo, unit: 'pc', issuedAt: new Date(detail.movements[1].movementDate) }];
    const ledger = resolveWorkOrderMaterialLedgers({ allocations, movements: hydrateRows('StagingWorkOrderMaterialMovement', detail.movementContext) as unknown as WorkOrderLedgerMovement[] }).summaries.get(String(bom.ragicRecordId))!;
    assert.equal(ledger.error, null); assert.equal(ledger.grossIssuedQty, gross);
    const expected = data.source.work_order_bom.filter(row => row.componentNo === material).reduce((sum, row) => sum + Number(row.remainingUsage), 0);
    assert.equal(detail.expectedUsage, expected);
    assert.equal(detail.includedTotal, expected);
    assert.equal(detail.materialSummary.netIssuedQty, gross - returned);
    assert.equal(detail.materialSummary.reservedQty, reserved);
    for (const lot of detail.inventoryLots.filter((row: DemoRow) => row.sourceWorkOrderNo)) assert.equal(lot.sourceWorkOrderRagicRecordId, data.source.work_orders.find(row => row.woNumber === lot.sourceWorkOrderNo)?.ragicRecordId);
    // 工令需求在 9/21（W04）；較早交易仍屬於這張工令的明細。
    const scoped = await query(`component-weekly/${material}/usage-details?runId=${runId}&mrpType=${type}&weekIndex=4`);
    assert.equal(scoped.movements.length, count);
    const later = await query(`component-weekly/${material}/usage-details?runId=${runId}&mrpType=${type}&weekIndex=27`);
    assert.equal(later.movements.length, 0);
    assert.equal(later.movementContext.length, count);
    if (returned) {
      const movement = detail.movements.find((row: DemoRow) => row.basisType === '入-製令單退料');
      const feedback = resolveComponentWeeklyMovementInventoryFeedback({ movement, movementIndex: detail.movementContext.findIndex((row: DemoRow) => row.ragicRecordId === movement.ragicRecordId), movements: detail.movementContext, inventoryLots: detail.inventoryLots, unit: 'pc' });
      assert.equal(feedback.state, 'in_stock'); assert.equal(feedback.availableQty, returned);
    }
  }
});
