'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader } from '@/components/ui/loader';
import { cachePeek, cacheSet } from '@/lib/swr-cache';
import type { OutsourcePriceChange, OutsourceChangeStats } from '@/lib/reports/outsource-price-change';

interface ApiResponse {
  month: string;
  changes: OutsourcePriceChange[];
  stats: OutsourceChangeStats;
  generatedAt: string;
  stale: boolean;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const keyOf = (month: string) => `/api/outsource-price-change?month=${month}`;

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// CSV：含逗號/引號/換行用雙引號包 + 引號 double-up
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function OutsourcePriceChangeClient() {
  const [month, setMonth] = useState(currentMonth);
  const [resp, setResp] = useState<ApiResponse | null>(() => cachePeek<ApiResponse>(keyOf(currentMonth())) ?? null);
  const [loading, setLoading] = useState(() => cachePeek(keyOf(currentMonth())) === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');

  // 月份切換後，丟棄上一個月遲到的非同步回應（避免 setResp 蓋到別月）。
  const monthRef = useRef(month);
  useEffect(() => { monthRef.current = month; }, [month]);

  // 強制重抓（POST）：手動按鈕 + GET 回 stale 時背景自動觸發。失敗保留前次資料。
  const doRefresh = useCallback(async (mo: string) => {
    const key = keyOf(mo);
    setRefreshing(true);
    setRefreshError('');
    try {
      const res = await fetch(key, { method: 'POST' });
      const json = await res.json();
      if (monthRef.current !== mo) return;
      if (!res.ok) { setRefreshError(json.error || '重新抓取失敗'); return; }
      setResp(json);
      cacheSet(key, json);
    } catch (e) {
      if (monthRef.current === mo) setRefreshError(e instanceof Error ? e.message : '重新抓取失敗，顯示前次資料');
    } finally {
      if (monthRef.current === mo) setRefreshing(false);
    }
  }, []);

  const fetchData = useCallback(async (mo: string) => {
    const key = keyOf(mo);
    const cached = cachePeek<ApiResponse>(key);
    if (cached) { setResp(cached); setLoading(false); } else { setLoading(true); }
    setError('');
    setRefreshError('');
    try {
      const res = await fetch(key); // GET：DB 有就秒回
      const json = await res.json();
      if (monthRef.current !== mo) return;
      if (!res.ok) { setError(json.error || '查詢失敗'); if (!cached) setResp(null); return; }
      setResp(json);
      cacheSet(key, json);
      if (json.stale) doRefresh(mo); // 當月超過 TTL → 背景重抓保新
    } catch (e) {
      if (monthRef.current === mo && !cached) setError(e instanceof Error ? e.message : '網路錯誤');
    } finally {
      if (monthRef.current === mo) setLoading(false);
    }
  }, [doRefresh]);

  useEffect(() => { fetchData(month); }, [month, fetchData]);

  const changes = resp?.changes ?? [];
  const stats = resp?.stats ?? null;

  const handleExport = () => {
    const header = ['ERP料號', '製程', '新廠商', '舊價', '新價', '漲跌幅%', '新價生效日', '新狀態', '舊價生效日', '對應客戶料號版本', '備註'];
    const lines = [header.map(csvCell).join(',')];
    for (const c of changes) {
      lines.push([
        c.erpPartNo, c.process, c.vendor, c.oldPrice, c.newPrice, c.changePct,
        c.newEffectiveDate, c.newStatus, c.oldEffectiveDate,
        c.customerPartVersions.join('\n'), c.note,
      ].map(csvCell).join(','));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `委外核價變動_${month.replace('-', '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-3">
        <h1 className="text-2xl font-bold text-slate-800">委外核價變動報表</h1>
        <p className="text-sm text-slate-500 mt-1">
          當月「委外加工成本」有漲跌的料號（舊價→新價）。依價格歷史判定，不靠備註。
        </p>
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <label className="text-sm text-slate-600 flex items-center gap-2">
            月份
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded text-sm"
            />
          </label>
          <button
            onClick={handleExport}
            disabled={changes.length === 0}
            className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            匯出 CSV
          </button>
          <button
            onClick={() => doRefresh(month)}
            disabled={refreshing || loading}
            className="px-3 py-1.5 border border-slate-300 text-slate-600 rounded text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="重新從 Source 抓取最新核價並更新快照"
          >
            {refreshing ? '更新中…' : '重新抓取'}
          </button>
          {resp?.generatedAt && (
            <span className="text-xs text-slate-400 flex items-center gap-1">
              資料時間 {fmtTime(resp.generatedAt)}
              {refreshing && <span className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />}
            </span>
          )}
          {refreshError && <span className="text-xs text-amber-600">{refreshError}</span>}
          {stats && (
            <span className="text-xs text-slate-500 ml-auto">
              全表 {stats.total}・委外 {stats.outsource}・當月候選 {stats.candidates}・
              排除(新料號) {stats.excludedNew}・排除(同價) {stats.excludedSame}・
              <span className="font-semibold text-slate-700">變動 {stats.changed}</span>
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 px-6 pb-6">
        <div className="h-full bg-white border border-slate-200 rounded-lg overflow-auto">
          {error ? (
            <div className="p-6 text-sm text-red-600">{error}</div>
          ) : loading ? (
            <Loader />
          ) : changes.length === 0 ? (
            <div className="p-6 text-sm text-slate-400 text-center">此月份查無委外核價變動。</div>
          ) : (
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr className="text-left text-slate-600">
                  <th className="px-2 py-2 font-semibold whitespace-nowrap" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>ERP料號</th>
                  <th className="px-2 py-2 font-semibold text-center" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>製程</th>
                  <th className="px-2 py-2 font-semibold whitespace-nowrap" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>新廠商</th>
                  <th className="px-2 py-2 font-semibold text-right" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>舊價</th>
                  <th className="px-2 py-2 font-semibold text-right" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>新價</th>
                  <th className="px-2 py-2 font-semibold text-right whitespace-nowrap" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>漲跌幅%</th>
                  <th className="px-2 py-2 font-semibold whitespace-nowrap" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>新價生效日</th>
                  <th className="px-2 py-2 font-semibold whitespace-nowrap" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>對應客戶料號版本</th>
                  <th className="px-2 py-2 font-semibold" style={{ boxShadow: 'inset 0 -1px 0 rgb(203 213 225)' }}>備註</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c, i) => {
                  const up = c.changePct.startsWith('+');
                  return (
                    <tr key={`${c.erpPartNo}-${c.newEffectiveDate}-${i}`} className="hover:bg-slate-50">
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap border-b border-slate-100">{c.erpPartNo}</td>
                      <td className="px-2 py-1.5 text-center border-b border-slate-100">{c.process}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap border-b border-slate-100">{c.vendor}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-slate-500 border-b border-slate-100">{c.oldPrice}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold border-b border-slate-100">{c.newPrice}</td>
                      <td className={`px-2 py-1.5 text-right font-mono border-b border-slate-100 ${up ? 'text-red-600' : 'text-green-600'}`}>{c.changePct}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap border-b border-slate-100">{c.newEffectiveDate}</td>
                      <td className="px-2 py-1.5 border-b border-slate-100">
                        {c.customerPartVersions.length === 0
                          ? <span className="text-slate-300">—</span>
                          : c.customerPartVersions.map((v) => <div key={v} className="font-mono whitespace-nowrap">{v}</div>)}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500 border-b border-slate-100">{c.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
