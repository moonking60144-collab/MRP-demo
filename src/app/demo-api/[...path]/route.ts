import { NextRequest, NextResponse } from 'next/server';
import { dataset, demoPreferences, runs } from '@/lib/demo/data';
import { summarizeMaterialReminder } from '@/lib/mrp/material-reminder';
import { fgMonthlyTotals, filterReportRows, paginateReportRows, reportFilterFields, usageWarnings } from '@/lib/demo/reports';
import { latestRun, mutate, state } from '@/lib/demo/store';
import { DemoError, prepareDemo, startRun, stopRun, pauseRun } from '@/lib/demo/run-control';
import { demoStream } from '@/lib/demo/events';
import { archiveDataset, archiveGet, archiveRun, archiveWeeklyReport } from '@/lib/demo/archive';
import { planItems, reconcile, saveSuggestion, suggestions, workOrderCommand, outsourceReport, requireLatest } from '@/lib/demo/operations';
import { sourceDetails, updateLeadTime, usageDetail, warehouseDetail } from '@/lib/demo/details';
import { groupSalesMeetingRows, type SalesMeetingGroupableRow } from '@/lib/mrp/sales-meeting-display';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-MRP-Data': 'synthetic' } });

export async function GET(request: NextRequest, context: Context) {
  try {
    await prepareDemo();
    const path = (await context.params).path;
    const key = path.join('/');
    const params = request.nextUrl.searchParams;
    if (params.has('dbSource') && !['local', 'docker', 'remote'].includes(params.get('dbSource')!)) throw new DemoError('dbSource 無效。');
    if (path[0] === 'archive') return json(archiveGet(path, params));
    if (key === 'runs') return json({ runs: runs() });
    if (key === 'runs/selection') { const id = Number(params.get('runId')); const selected = runs().find((run) => run.id === id && run.status === 'completed') ?? latestRun(); return json({ run: selected, requestedRunId: id || null, fallback: id > 0 && id !== selected.id }); }
    if (key === 'runs/active') { const run = runs().find((item) => ['pending', 'syncing', 'synced', 'calculating'].includes(item.status)); return json(run ? { active: true, runId: run.id, versionCode: run.versionCode, status: run.status, run, activeRun: run } : { active: false, run: null, activeRun: null }); }
    if (key === 'runs/stream' || key === 'production-plans/stream') return demoStream(request, key === 'runs/stream' ? 'runs' : 'plans');
    if (key === 'db-health') return json({ connected: true, healthy: true, dbMode: 'local', demo: true });
    if (key === 'settings') return json({ dbMode: state().dbMode, urls: { local: '合成資料 A（無連線）', docker: '合成資料 B（無連線）', remote: '合成資料 C（無連線）' }, urlConfigured: { local: true, docker: true, remote: true }, connection: { connected: true, dbVersion: 'Demo・不連資料庫', error: '' } });
    if (key === 'maintenance-status') return json({ ragic: null, backup: { enabled: false, ready: false, due: false, activeRun: false, intervalHours: 24, retentionDays: 30, minimumBackups: 3, lastAutomaticResult: null, latestBackup: null }, retention: { enabled: false, activeRun: false, retentionDays: 30, minimumCompletedRuns: 30, batchSize: 10, completedRunCount: runs().length, eligibleRunCount: 0, blockedRunCount: 0, nextEligibleRunId: null, nextCoverageReadyRunId: null, archiveGate: { enabled: false, coverageReady: false, reason: 'gate-disabled' }, lastAutomaticResult: null }, demo: true });
    if (key === 'storage-status') return json({ demo: true, measuredAt: new Date().toISOString(), databaseMode: 'demo（合成容量）', database: { name: 'demo_live', bytes: 2 * 1024 ** 3 }, archive: { name: 'demo_archive', bytes: 12 * 1024 ** 3, verifiedRuns: 64 }, files: [], volumes: [{ label: '模擬資料磁碟', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, warning: false, critical: false }, { label: '模擬封存磁碟', totalBytes: 2 * 1024 ** 4, freeBytes: 1.4 * 1024 ** 4, warning: false, critical: false }], warnings: [] });
    if (key === 'settings/auto-follow') return json({ autoFollow: state().autoFollow });
    if (key === 'fg-monthly/ignored-customers') return json({ codes: state().ignored });
    if (key === 'table-presets') return json({ presets: (demoPreferences.demoPresets ?? []).filter((item) => item.tableId === params.get('tableId')) });
    if (path[0] === 'runs' && /^\d+$/.test(path[1])) { const run = runs().find((item) => item.id === Number(path[1])); if (!run) throw new DemoError('找不到合成版本。', 404); const logs = run.logs.filter((item) => Number(item.seq) > Number(params.get('afterLogSeq') ?? 0)); return json({ run, logs, logCursor: run.logs.length, logsReset: false }); }
    const archiveId = params.get('archiveId');
    const runId = Number(params.get('runId') ?? latestRun().id);
    if (!Number.isInteger(runId) || runId < 1) throw new DemoError('runId 無效。');
    if (archiveId && archiveRun(archiveId).sourceRunId !== runId) throw new DemoError('歷史版本身分不一致。', 409);
    const data = archiveId ? archiveDataset(archiveId) : dataset(runId);
    if (data.run.status !== 'completed') throw new DemoError('版本尚未計算完成。', 409);
    if (key === 'plan-management') return json({ items: planItems(runId), total: planItems(runId).length, runId, runVersionCode: data.run.versionCode, runDate: data.run.runDate });
    if (key === 'production-plans') return json({ transfers: state().transfers.filter((row) => row.mrpRunId === runId) });
    if (path[0] === 'production-plans' && path[2] === 'work-orders') { const row = state().transfers.find((item) => item.id === Number(path[1])); if (!row) throw new DemoError('找不到合成生產計畫。', 404); return json(row); }
    if (key === 'outsource-price-change') return json(outsourceReport(params.get('month') ?? new Date().toISOString().slice(0, 7)));
    if (key === 'fg-monthly/warehouse-stock') return json(warehouseDetail(data, params));
    if (key === 'fg-monthly/warehouse-stock/recheck') { const row = data.source.inventory_lots.find((item) => item.ragicRecordId === params.get('recordId')); if (!row) throw new DemoError('找不到合成庫存批號。', 404); const stock = { stockPc: row.stockPc, stockKg: row.stockKg, unitWeightG: null, expectedStockPc: row.stockPc, stockPcDiff: 0, stockPcDiffPct: 0, quantityAnomaly: false }; return json({ recordId: row.ragicRecordId, ragicUrl: `/demo-record?type=inventory_lot&id=${row.ragicRecordId}`, snapshot: stock, live: stock, ragicCorrected: false, mrpRunNeedsRefresh: false }); }
    if (path[0] === 'fg-monthly' && ['sources', 'source-records'].includes(path[2])) return json(sourceDetails(data, path[1], params, false, path[2] === 'sources'));
    if (path[0] === 'sales-meeting' && path[2] === 'source-records') return json(sourceDetails(data, path[1], params, true));
    if (path[0] === 'component-weekly' && path[2] === 'usage-details') return json(usageDetail(data, path[1], params));
    if (key === 'fg-material-reminders/weekly') {
      const material = params.get('material') ?? '', mrpType = params.get('mrpType') ?? 'W';
      if (archiveId) return json({ archive: archiveWeeklyReport(archiveId, new URLSearchParams({ kind: 'component', material, mrpType })), runId, archiveId, dbSource: null, material, mrpType });
      return json({ items: data.cw.filter((row) => row.materialPartNo === material && row.mrpType === mrpType), periods: data.cwPeriods[material] ?? [], versionCode: data.run.versionCode, runId, archiveId: null, dbSource: params.get('dbSource'), material, mrpType });
    }
    if (key === 'fg-material-reminders') {
      const targets: { partVersion: string; aggregated: boolean }[] = JSON.parse(params.get('targets') ?? '[]');
      if (!Array.isArray(targets) || targets.length > 50 || targets.some((target) => typeof target.partVersion !== 'string' || typeof target.aggregated !== 'boolean')) return json({ error: '材料查詢條件無效' }, 400);
      return json({ runId, archiveId, dbSource: params.get('dbSource'), items: targets.map((target) => {
        const fg = data.fg.find((row) => row.partVersion === target.partVersion && row.isAggregated === target.aggregated);
        const members = fg?.isAggregated ? fg.aggregatedMembers as string[] : [target.partVersion];
        const jobs = data.source.work_orders.filter((row) => members.includes(String(row.partVersion))).map((row) => String(row.woNumber));
        const rows = data.source.work_order_bom.filter((row) => jobs.includes(String(row.woNumber))).map((row) => {
          const material = data.cw.find((item) => item.materialPartNo === row.componentNo);
          return { partVersion: target.partVersion, woNumber: String(row.woNumber), materialPartNo: String(row.componentNo), mrpType: material ? String(material.mrpType) : null, unit: String(row.unit), reportUnit: material ? String(material.unit) : null, demandDate: String(row.startDate), remainingUsage: row.remainingUsage == null ? null : String(row.remainingUsage), issuedQtyState: String(row.issuedQtyState), movementState: String(row.movementState), shortageStartWeek: material?.shortageStartWeek == null ? null : Number(material.shortageStartWeek), shortageStartDate: material?.shortageStartDate == null ? null : String(material.shortageStartDate) };
        });
        return { ...target, reminder: summarizeMaterialReminder(rows, rows.length > 0) };
      }) });
    }
    if (key === 'dashboard') { const rows = data.fg.filter((item) => !item.isAggregated); const shortage = rows.filter((item) => item.shouldPlanProduction).length; return json({ dbMode: state().dbMode, latestRun: latestRun(), summary: { totalParts: rows.length, shortageParts: shortage, partsWithPlans: new Set(suggestions(runId).map((item) => item.partVersion)).size, healthPct: Math.round((rows.length - shortage) / rows.length * 100) }, recentRuns: runs() }); }
    if (key === 'fg-monthly/machines') return json({ machines: ['M1', 'M2', 'M3'] });
    if (key === 'filter-options/customer-codes') return json({ runId, values: ['XA', 'XB'] });
    if (['fg-monthly', 'component-weekly', 'sales-meeting', 'source-data'].includes(key)) {
      let items = key === 'fg-monthly' ? data.fg.filter((item) => item.isAggregated === (params.get('aggregated') === 'true')) : key === 'component-weekly' ? data.cw.filter((item) => item.mrpType === (params.get('mrpType') ?? 'W')) : key === 'sales-meeting' ? data.sales : data.source[params.get('table') ?? 'part_versions'];
      if (!items) return json({ error: '未知來源資料表' }, 400);
      if (key === 'sales-meeting') items = groupSalesMeetingRows(items.map((row) => ({ ...row, customerPartNo: data.source.part_versions.find((part) => part.partVersion === row.partVersion)?.customerPartNo ?? null })) as SalesMeetingGroupableRow[]);
      if (params.get('merge') === 'true' && params.has('dbSource')) return json({ error: 'merge and dbSource cannot be combined' }, 400);
      if (key === 'fg-monthly' && params.get('includeIgnored') !== 'true' && params.get('aggregated') !== 'true') items = items.filter((item) => !(demoPreferences.demoIgnored ?? state().ignored).includes(String(item.customerCode)));
      items = items.map((item) => ({ ...item, sharedErpCount: key === 'fg-monthly' || key === 'sales-meeting' ? data.source.part_versions.filter((part) => part.erpPartNo === item.erpPartNo).length : undefined, usesSharedErpPool: key === 'fg-monthly' && !item.isAggregated, inventoryValidationAvailable: true, inventoryAnomalyCount: 0, wfgInventoryAnomalyCount: 0, ye1InventoryAnomalyCount: 0, inventoryAnomalyDiffPc: 0, inventoryAnomalyErpPartNos: [] }));
      // The three synthetic sources intentionally share natural keys; the original merge keeps the first tied source.
      if (params.get('merge') === 'true') items = items.map((item) => ({ ...item, dbSource: 'local' }));
      else if (params.has('dbSource')) items = items.map((item) => ({ ...item, dbSource: params.get('dbSource') }));
      const { rows, facet } = filterReportRows(items, params, reportFilterFields(key, params.get('table') ?? 'part_versions'));
      if (facet) return json({ ...facet, merge: params.get('merge') === 'true', runId, dbSource: params.get('dbSource') });
      const fgMap = params.get('aggregated') === 'true' ? Object.fromEntries(Object.entries(data.fgPeriods).filter(([key]) => key.endsWith(':aggregate')).map(([key, value]) => [key.slice(0, -10), value])) : data.fgPeriods;
      if (key === 'fg-monthly' && params.get('totals') === 'true') return json({ items: [], total: rows.length, totals: params.get('merge') === 'true' ? null : fgMonthlyTotals({ ...data, fgPeriods: fgMap }, rows), runId, runVersionCode: data.run.versionCode, runDate: data.run.runDate.slice(0, 10), dbSource: params.get('dbSource'), page: 1, limit: 0 });
      const page = paginateReportRows(rows, params);
      const identity = key === 'component-weekly' ? 'materialPartNo' : 'partVersion';
      const periodMap = key === 'fg-monthly' ? fgMap : key === 'component-weekly' ? data.cwPeriods : data.salesPeriods;
      return json({ ...page, runId, runVersionCode: data.run.versionCode, runDate: data.run.runDate.slice(0, 10), dbSource: params.get('dbSource'), sources: params.get('merge') === 'true' ? ['local', 'docker', 'remote'].map((mode) => ({ mode, runId, runVersionCode: data.run.versionCode })) : [], periods: params.get('includePeriods') === '1' ? Object.fromEntries(page.items.map((item) => [String(item[identity]), periodMap[String(item[identity])] ?? []])) : undefined, filterOptions: { customerCode: ['XA', 'XB'] }, usageWarnings: key === 'component-weekly' ? usageWarnings(data, params.get('mrpType') ?? 'W') : { count: 0, blockingCount: 0, reviewCount: 0, items: [] }, totals: null });
    }
    if (path.at(-1) === 'periods' && ['fg-monthly', 'component-weekly', 'sales-meeting'].includes(path[0])) {
      const map = path[0] === 'fg-monthly' ? data.fgPeriods : path[0] === 'component-weekly' ? data.cwPeriods : data.salesPeriods;
      const periods = map[path[1] + (path[0] === 'fg-monthly' && params.get('aggregated') === 'true' ? ':aggregate' : '')];
      if (!periods) throw new DemoError('找不到合成期間資料。', 404);
      return json({ periods, suggestions: suggestions(runId, path[1]), members: data.fg.filter((item) => !item.isAggregated && item.partVersion === path[1]), runId, dbSource: params.get('dbSource') });
    }
    if (['diag', 'debug-ragic'].includes(key)) return json({ demo: true, synthetic: true, databaseConnections: 0, ragicConnections: 0, revision: state().revision, message: '僅本機合成資料，正式維運程式保留在 reference，不會執行。' });
    return json({ error: `未知 Demo 介面：${key}` }, 404);
  } catch (error) { return json({ error: error instanceof Error ? error.message : '展示資料錯誤' }, error instanceof DemoError ? error.status : 400); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    await prepareDemo();
    const path = (await context.params).path;
    const key = path.join('/');
    const text = await request.text();
    const body = text ? JSON.parse(text) : {};
    if (path[0] === 'archive' || request.nextUrl.searchParams.has('archiveId') || body.archiveId) throw new DemoError('歷史版本唯讀。', 405);
    if (key === 'runs') return json({ runId: startRun(undefined, body.applySkipFgInventory === true).id, status: 'calculating' }, 202);
    if (key === 'runs/reset') { const run = stopRun(); return json({ ok: true, run }); }
    if (path[0] === 'runs' && path[2] === 'resume') return json({ runId: startRun(Number(path[1])).id, status: 'calculating' }, 202);
    if (path[0] === 'runs' && path[2] === 'signal') { if (!['stop', 'pause', 'resume'].includes(body.action)) throw new DemoError('執行訊號無效。'); if (body.action === 'stop') stopRun(Number(path[1])); else pauseRun(Number(path[1]), body.action === 'pause'); return json({ ok: true, runId: Number(path[1]), action: body.action }); }
    if (key === 'settings') { if (!['local', 'docker', 'remote'].includes(body.dbMode)) throw new DemoError('模式無效。'); mutate((draft) => { draft.dbMode = body.dbMode; }); return json({ ok: true, dbMode: body.dbMode, synthetic: true }); }
    if (key === 'outsource-price-change') return json(outsourceReport(request.nextUrl.searchParams.get('month') ?? new Date().toISOString().slice(0, 7)));
    if (path[0] === 'fg-monthly' && path[2] === 'suggestions' && path[3] === 'reconcile') return json(reconcile(path[1], body));
    if (path[0] === 'production-plans' && ['record-link', 'work-orders'].includes(path[2])) return json(workOrderCommand(Number(path[1]), path[2], body), path[2] === 'work-orders' ? 202 : 200);
    if (key === 'plan-management/batch-transfer') { requireLatest(body.runId); if (!Array.isArray(body.plans) || !body.plans.length || body.plans.length > 144) throw new DemoError('plans 無效。'); const results = body.plans.map((plan: { partVersion: string; planSequence: number }) => { try { const row = saveSuggestion(plan.partVersion, { runId: body.runId, planSequence: plan.planSequence, isTransferred: true }); return { ...plan, success: true, ragicPlanNo: row.ragicPlanNo, ragicUrl: row.ragicUrl }; } catch (error) { return { ...plan, success: false, error: error instanceof Error ? error.message : String(error) }; } }); return json({ results, succeeded: results.filter((row: { success: boolean }) => row.success).length, failed: results.filter((row: { success: boolean }) => !row.success).length }); }
    if (key.endsWith('/batch-periods')) {
      const runId = Number(body.runId ?? latestRun().id); const data = dataset(runId);
      const ids: string[] = body.partVersions ?? body.materialPartNos ?? body.groups?.map((group: { partVersion: string }) => group.partVersion) ?? [];
      const map = path[0] === 'fg-monthly' && body.aggregated ? Object.fromEntries(Object.entries(data.fgPeriods).filter(([key]) => key.endsWith(':aggregate')).map(([key, value]) => [key.slice(0, -10), value])) : path[0] === 'fg-monthly' ? data.fgPeriods : path[0] === 'component-weekly' ? data.cwPeriods : data.salesPeriods;
      return json({ periods: Object.fromEntries(ids.map((id) => [id, map[id] ?? []])), runId, dbSource: body.dbSource ?? null });
    }
    if (key === 'settings/auto-follow') { if (typeof body.autoFollow !== 'boolean') throw new DemoError('autoFollow 必須是 boolean。'); mutate((draft) => { draft.autoFollow = body.autoFollow; }); return json({ autoFollow: state().autoFollow, ok: true }); }
    return json({ error: `未知 Demo 操作：${key}` }, 404);
  } catch (error) { return json({ error: error instanceof Error ? error.message : '展示操作錯誤' }, error instanceof DemoError ? error.status : 400); }
}

export async function PUT(request: NextRequest, context: Context) {
  try { const path = (await context.params).path; if (path.join('/') !== 'fg-monthly/ignored-customers') throw new DemoError('此介面不支援 PUT。', 405); const body = await request.json(); if (!Array.isArray(body.codes) || body.codes.some((code: unknown) => typeof code !== 'string')) throw new DemoError('codes 必須是字串陣列。'); const codes = [...new Set<string>(body.codes.map((code: string) => code.trim().toUpperCase()).filter(Boolean))]; mutate((draft) => { draft.ignored = codes; }); demoPreferences.demoIgnored = undefined; return json({ codes }); } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof DemoError ? error.status : 400); }
}
export async function DELETE(request: NextRequest, context: Context) {
  try { const path = (await context.params).path; if (path[0] !== 'runs' || path.length !== 2) throw new DemoError('此介面唯讀或不支援 DELETE。', 405); const id = Number(path[1]); const run = runs().find((item) => item.id === id); if (!run) throw new DemoError('找不到合成版本。', 404); if (run.status !== 'error' || run.isLatest) throw new DemoError('只能刪除失敗的 Demo 版本。', 409); mutate((draft) => { draft.runs = draft.runs.filter((item) => item.id !== id); delete draft.snapshots[String(id)]; draft.suggestions = draft.suggestions.filter((row) => row.mrpRunId !== id); }); return json({ message: '已刪除本機失敗版本。' }); } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof DemoError ? error.status : 400); }
}
export async function PATCH(request: NextRequest, context: Context) {
  try { await prepareDemo(); const path = (await context.params).path; const params = request.nextUrl.searchParams; const body = await request.json(); if (path[0] === 'archive' || params.has('archiveId') || body.archiveId) throw new DemoError('歷史版本唯讀。', 405); if (path[0] === 'fg-monthly' && path[2] === 'suggestions') return json(saveSuggestion(path[1], body)); if (path[0] === 'component-weekly' && path[2] === 'purchase-lead-time') return json(updateLeadTime(dataset(Number(params.get('runId'))), path[1], params, body)); throw new DemoError('不支援此 Demo 修改。', 405); } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof DemoError ? error.status : 400); }
}
