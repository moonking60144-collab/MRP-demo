import { dataset, modelRow, type DemoDataset, type DemoRow } from './data';
import { latestRun, mutate, state } from './store';
import { DemoError } from './run-control';
import { events } from './events';
import { parseFulfillToPeriod, parsePositivePlanQty } from '../mrp/fg-plan-input';
import { computeOutsourcePriceChanges } from '../reports/outsource-price-change';
import type { TransferReconciliationCandidate } from '../mrp/transfer-reconciliation';

export function suggestions(runId: number, partVersion?: string): DemoRow[] {
  return state().suggestions.filter((row) => row.mrpRunId === runId && (!partVersion || row.partVersion === partVersion)).map((row) => {
    const transfer = state().transfers.find((item) => item.mrpRunId === runId && item.partVersion === row.partVersion && item.planSequence === row.planSequence);
    return { ...row, transferId: transfer?.id ?? null, sourceRecordId: transfer?.sourceRecordId ?? null, sourcePlanNo: transfer?.sourcePlanNo ?? null, sourceUrl: transfer?.sourceUrl ?? null, workOrderStatus: transfer?.workOrderStatus ?? null, workOrderError: transfer?.workOrderError ?? null, workOrderCompletedAt: transfer?.workOrderCompletedAt ?? null };
  });
}
export function planItems(runId: number): DemoRow[] {
  const data = dataset(runId);
  return suggestions(runId).map((suggestion) => {
    const fg = data.fg.find((row) => !row.isAggregated && row.partVersion === suggestion.partVersion);
    return { ...fg, ...suggestion, inventoryValidationAvailable: true, inventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [], sharedErpCount: data.fg.filter((row) => !row.isAggregated && row.erpPartNo === fg?.erpPartNo).length, usesSharedErpPool: true, status: suggestion.isTransferred ? '已轉單' : ['pending', 'unknown'].includes(String(suggestion.transferStatus)) ? '待確認' : suggestion.useManualQty ? '已儲存' : '未儲存' };
  });
}
export function requireLatest(runId: unknown): void {
  if (!Number.isInteger(runId) || Number(runId) !== latestRun().id) throw new DemoError('必須指定目前版本；舊版與歷史資料唯讀，不能更新。', 409);
  if (state().runs.some((run) => ['pending', 'syncing', 'synced', 'calculating'].includes(run.status))) throw new DemoError('Demo 計算中，請完成後再修改規劃。', 409);
}
function transferRecord(suggestion: DemoRow): DemoRow {
  const id = Math.max(0, ...state().transfers.map((item) => Number(item.id))) + 1;
  return modelRow('ProductionPlanTransfer', { id, mrpRunId: suggestion.mrpRunId, mrpVersionCode: latestRun().versionCode, partVersion: suggestion.partVersion, planSequence: suggestion.planSequence, customerCode: dataset(latestRun().id).fg.find((row) => row.partVersion === suggestion.partVersion)?.customerCode, suggestedQty: suggestion.suggestedQty, completionDate: suggestion.completionDate, sourceRecordId: String(100000 + id), sourcePlanNo: `DEMO-PLAN-${id}`, sourceUrl: `/demo-record?type=production_plan&id=${100000 + id}`, transferredAt: new Date().toISOString(), transferredBy: 'Interview Demo', workOrderStatus: 'idle' });
}
export function saveSuggestion(partVersion: string, body: DemoRow): DemoRow {
  requireLatest(body.runId);
  const sequence = Number(body.planSequence);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 3) throw new DemoError('planSequence 必須是 1～3。');
  const runId = latestRun().id;
  if (!dataset(runId).fg.some((row) => !row.isAggregated && row.partVersion === partVersion)) throw new DemoError('找不到合成客料版本。', 404);
  const previous = state().suggestions.find((row) => row.mrpRunId === runId && row.partVersion === partVersion && row.planSequence === sequence);
  if (previous?.isTransferred && body.isTransferred !== true) throw new DemoError('已建立的合成計畫不能改寫。', 409);
  if (body.suggestedQty !== undefined && parsePositivePlanQty(body.suggestedQty) === null) throw new DemoError('規劃量必須大於零且為有限數。');
  if (body.fulfillToPeriod !== undefined && parseFulfillToPeriod(body.fulfillToPeriod) === null) throw new DemoError('支應月份必須是 0～12，且以半月為單位。');
  if (body.completionDate && !Number.isFinite(Date.parse(String(body.completionDate)))) throw new DemoError('預計完成日無效。');
  const result = mutate((draft) => {
    let row = draft.suggestions.find((item) => item.mrpRunId === runId && item.partVersion === partVersion && item.planSequence === sequence);
    if (!row) { row = modelRow('FgPlanSuggestion', { id: Math.max(0, ...draft.suggestions.map((item) => Number(item.id))) + 1, mrpRunId: runId, partVersion, planSequence: sequence, bufferPct: 0.1, transferStatus: 'idle', completionDate: latestRun().runDate }); draft.suggestions.push(row); }
    for (const key of ['suggestedQty', 'completionDate', 'targetStartPeriod', 'fulfillToPeriod', 'materialWeightKg', 'bufferPct']) if (body[key] !== undefined) row[key] = body[key];
    if (body.suggestedQty !== undefined) row.useManualQty = true;
    if (body.isTransferred === true && !row.isTransferred) {
      if (['pending', 'unknown'].includes(String(row.transferStatus))) throw new DemoError('結果待確認，請先對帳，不能重複轉單。', 409);
      if (!(Number(row.suggestedQty) > 0) || !row.completionDate) throw new DemoError('請先儲存有效的規劃量與完成日。');
      row.isTransferred = true; row.transferStatus = 'succeeded'; row.transferError = null; row.transferredAt = new Date().toISOString();
      draft.transfers.push(transferRecord(row));
    }
    return structuredClone(row);
  });
  const enriched = suggestions(runId, partVersion).find((row) => row.planSequence === sequence)!;
  return { ...result, ...enriched, transfer: state().transfers.find((row) => row.id === enriched.transferId) ?? null, suggestions: body.returnSuggestions ? suggestions(runId, partVersion) : undefined };
}
export function reconcile(partVersion: string, body: DemoRow): unknown {
  requireLatest(body.runId);
  const runId = Number(body.runId), sequence = Number(body.planSequence);
  const suggestion = state().suggestions.find((row) => row.mrpRunId === runId && row.partVersion === partVersion && row.planSequence === sequence);
  if (!suggestion) throw new DemoError('找不到合成規劃建議。', 404);
  const candidates: TransferReconciliationCandidate[] = state().transfers.filter((row) => row.mrpRunId === runId && row.partVersion === partVersion && row.planSequence === sequence).map((row) => ({ sourceRecordId: String(row.sourceRecordId), sourcePlanNo: row.sourcePlanNo as string | null, sourceUrl: String(row.sourceUrl), suggestedQty: Number(row.suggestedQty), completionDate: String(row.completionDate).slice(0, 10), createdAt: String(row.transferredAt), mrpSourceCode: String(row.mrpVersionCode) }));
  if (body.action === 'inspect') return { inspection: { action: 'inspect', matchStatus: candidates.length === 0 ? 'not_found' : candidates.length === 1 ? 'single_match' : 'multiple_matches', candidates } };
  if (body.action === 'confirm_created') {
    const candidate = candidates.find((row) => row.sourceRecordId === String(body.sourceRecordId));
    if (!candidate) throw new DemoError('只能選擇本機已存在的合成生產計畫。', 409);
    mutate((draft) => { const row = draft.suggestions.find((item) => item.mrpRunId === runId && item.partVersion === partVersion && item.planSequence === sequence)!; row.isTransferred = true; row.transferStatus = 'succeeded'; row.transferError = null; });
    return { reconciliation: { action: body.action, transferStatus: 'succeeded', ...candidate } };
  }
  if (body.action === 'confirm_not_created') {
    if (candidates.length) throw new DemoError('本機已有計畫，不能宣告未建立。', 409);
    mutate((draft) => { const row = draft.suggestions.find((item) => item.mrpRunId === runId && item.partVersion === partVersion && item.planSequence === sequence)!; row.isTransferred = false; row.transferStatus = 'failed'; row.transferError = '已確認本機未建立，可重試。'; });
    return { reconciliation: { action: body.action, transferStatus: 'failed', sourceRecordId: null, sourcePlanNo: null, sourceUrl: null } };
  }
  throw new DemoError('不支援的 Demo 對帳動作。');
}
export function workOrderCommand(transferId: number, action: string, body: DemoRow): unknown {
  const current = state().transfers.find((row) => row.id === transferId);
  if (!current) throw new DemoError('找不到本機生產計畫。', 404);
  requireLatest(current.mrpRunId);
  if (action === 'record-link') {
    if (String(body.sourceRecordId) !== String(100000 + transferId)) throw new DemoError(`Demo 只接受此計畫的合成 ID：${100000 + transferId}`);
    const linked = mutate((draft) => { const row = draft.transfers.find((item) => item.id === transferId)!; row.sourceRecordId = String(body.sourceRecordId); row.sourceUrl = `/demo-record?type=production_plan&id=${body.sourceRecordId}`; if (row.workOrderStatus === 'unknown') row.workOrderStatus = 'idle'; row.workOrderError = null; return row; });
    return { linked };
  }
  if (current.workOrderStatus === 'succeeded') return { ...current, alreadyGenerated: true };
  if (['pending', 'queued', 'unknown'].includes(String(current.workOrderStatus))) throw new DemoError('工令處理中或待確認，禁止重複建立。', 409);
  mutate((draft) => { const row = draft.transfers.find((item) => item.id === transferId)!; row.workOrderStatus = 'queued'; row.workOrderStartedAt = new Date().toISOString(); row.workOrderError = null; });
  events.emit('plans', { type: 'work-order-status', ...state().transfers.find((row) => row.id === transferId), transferId });
  setTimeout(() => {
    const row = state().transfers.find((item) => item.id === transferId);
    if (!row || row.workOrderStatus !== 'queued') return;
    try {
      const artifact = generatedArtifacts(row, dataset(Number(row.mrpRunId)));
      mutate((draft) => { const item = draft.transfers.find((entry) => entry.id === transferId)!; item.workOrderStatus = 'succeeded'; item.workOrderCompletedAt = new Date().toISOString(); item.workOrderResponse = artifact; });
    } catch (error) {
      mutate((draft) => { const item = draft.transfers.find((entry) => entry.id === transferId)!; item.workOrderStatus = 'failed'; item.workOrderError = error instanceof Error ? error.message : String(error); });
    }
    events.emit('plans', { type: 'work-order-status', ...state().transfers.find((item) => item.id === transferId), transferId });
  }, 300);
  return { workOrderStatus: 'queued' };
}
function generatedArtifacts(row: DemoRow, data: DemoDataset): DemoRow {
  const transferId = Number(row.id), part = data.source.part_versions.find((item) => item.partVersion === row.partVersion);
  if (!part) throw new Error('合成工令缺少客料版本。');
  const woNumber = `DEMO-GENERATED-WO-${transferId}`;
  const workOrder = modelRow('StagingWorkOrder', { id: 10000 + transferId, mrpRunId: row.mrpRunId, sourceRecordId: `DEMO-GENERATED-${transferId}`, woNumber, partVersion: row.partVersion, erpPartNo: part.erpPartNo, woQty: row.suggestedQty, subProcessCode: 'HF01', jobOrderCode: '01', startDate: row.completionDate, endDate: row.completionDate, status: '生產中', alreadyPicked: 'No' });
  const templateJob = data.source.work_orders.find((item) => item.partVersion === row.partVersion);
  const bom = data.source.work_order_bom.filter((item) => item.woNumber === templateJob?.woNumber).map((item, index) => { const qty = item.unit === 'kg' ? Number(row.suggestedQty) * Number(part.unitWeightG) / 1000 : Number(row.suggestedQty); return modelRow('StagingWorkOrderBom', { ...item, id: 10000 + transferId * 3 + index, sourceRecordId: `DEMO-GENERATED-BOM-${transferId}-${index}`, woNumber, minUsage: qty, remainingUsage: qty, alreadyPicked: 'No', issuedQty: 0, grossIssuedQty: 0, consumedQty: 0, returnedQty: 0, netIssuedQty: 0, reservedQty: 0, overIssuedQty: 0, issuedDetailCount: 0, movementDetailCount: 0, issuedQtyState: 'not_issued', movementState: 'fallback', issuedQtyError: null, movementError: null, startDate: row.completionDate }); });
  if (!bom.length) throw new Error('合成製程缺少 BOM，不能宣告工令成功。');
  return { synthetic: true, woNumber, workOrder, bom };
}
export function seedOperationExamples(): void {
  if (state().transfers.length || !state().suggestions.length) return;
  const data = dataset(latestRun().id);
  const examples = state().suggestions.filter((row) => row.mrpRunId === latestRun().id && Number(row.planSequence) === 1).slice(-7);
  for (const [index, suggestion] of examples.entries()) {
    const transfer = transferRecord(suggestion);
    if (index === 6) { transfer.workOrderStatus = 'succeeded'; transfer.workOrderResponse = generatedArtifacts(transfer, data); transfer.workOrderCompletedAt = new Date().toISOString(); }
    if (index === 4) { transfer.workOrderStatus = 'failed'; transfer.workOrderError = '合成例外：製程設定待補，確認後可重試。'; }
    if (index === 5) { transfer.workOrderStatus = 'unknown'; transfer.workOrderError = '合成例外：上次處理中斷，請先確認紀錄連結。'; }
    mutate((draft) => { const row = draft.suggestions.find((item) => item.mrpRunId === suggestion.mrpRunId && item.partVersion === suggestion.partVersion && item.planSequence === 1)!; row.useManualQty = true; row.transferStatus = index === 1 || index === 2 ? 'unknown' : index === 3 ? 'failed' : index >= 4 ? 'succeeded' : 'idle'; row.transferError = index >= 1 && index <= 3 ? '合成例外：請先對帳，不盲目重送。' : null; row.isTransferred = index >= 4; if (index === 2 || index >= 4) draft.transfers.push(transfer); });
  }
}
export function outsourceReport(month: string): unknown {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DemoError('月份格式必須是 YYYY-MM。');
  const [year, value] = month.split('-').map(Number);
  const data = dataset(latestRun().id);
  const prices = data.fg.filter((row) => !row.isAggregated && row.customerCode === 'XA').flatMap((row, index) => [{ 核價種類: '委外', ERP料號: `${row.erpPartNo}-03PA`, 單價: '1.00', 生效日期: `${year - 1}/01/01`, MIS廠商簡稱: '合成供應商 A' }, { 核價種類: '委外', ERP料號: `${row.erpPartNo}-03PA`, 單價: (1 + ((index % 3) - 1) * 0.1).toFixed(2), 生效日期: `${year}/${String(value).padStart(2, '0')}/01`, MIS廠商簡稱: '合成供應商 B', linkedProducts: { '1': { 成品對應客戶料號: row.customerPartNo } } }]);
  const result = computeOutsourcePriceChanges(prices, data.source.part_versions.map((row) => ({ 客戶料號: row.customerPartNo, 客戶料號版本: row.partVersion })), year, value);
  return { month, ...result, generatedAt: new Date().toISOString(), stale: false };
}
