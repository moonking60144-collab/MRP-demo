import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourceRecordUrl } from '../source-record-links';
import { isAuxWarehouse } from '../mrp/warehouse-stock';
import { reconcileWorkOrderBomUsage } from '../mrp/work-order-bom-usage';
import { computeOutsourcePriceChanges } from '../reports/outsource-price-change';

test('公開 Demo 的來源連結固定留在本機合成頁面', () => {
  assert.equal(
    buildSourceRecordUrl('work-order', 'DEMO-WO-1'),
    '/demo-record?type=work-order&id=DEMO-WO-1',
  );
});

test('倉別使用抽象 MAIN/AUX 身分', () => {
  assert.equal(isAuxWarehouse('AUX'), true);
  assert.equal(isAuxWarehouse('MAIN'), false);
});

test('合成領退料依移動方向計算，不依賴外部欄位 ID', () => {
  const result = reconcileWorkOrderBomUsage({
    plannedUsage: 100,
    bomUnit: 'pc',
    ledgerIssuedQty: 80,
    formUsage: {
      issuedQty: 80,
      remainingUsage: 20,
      issuedQtyState: 'known',
      issuedDetailCount: 1,
      issuedQtyError: null,
    },
    movements: [
      { basisType: '合成耗用', movementType: 'OUT', inputUnit: 'pc', inputQtyPc: 60, inputQtyKg: null, movementQtyPc: -60, movementQtyKg: null },
      { basisType: '合成退料', movementType: 'IN', inputUnit: 'pc', inputQtyPc: 10, inputQtyKg: null, movementQtyPc: 10, movementQtyKg: null },
    ],
    movementSourceAvailable: true,
  });
  assert.deepEqual(
    { consumedQty: result.consumedQty, returnedQty: result.returnedQty, remainingUsage: result.remainingUsage },
    { consumedQty: 50, returnedQty: 10, remainingUsage: 30 },
  );
});

test('合成核價資料使用 linkedProducts，不含正式子表 identifier', () => {
  const result = computeOutsourcePriceChanges([
    { 核價種類: '委外', ERP料號: 'DEMO-01AA', 單價: '1', 生效日期: '2026/04/01' },
    { 核價種類: '委外', ERP料號: 'DEMO-01AA', 單價: '2', 生效日期: '2026/05/01', linkedProducts: { one: { 成品對應客戶料號: 'PRODUCT-001' } } },
  ], [{ 客戶料號: 'PRODUCT-001', 客戶料號版本: 'XA-PRODUCT-001-R1' }], 2026, 5);
  assert.equal(result.changes[0]?.customerPartVersions[0], 'XA-PRODUCT-001-R1');
});
