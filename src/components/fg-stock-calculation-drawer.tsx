'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { StockCalculationDetail } from '@/lib/mrp/fg-stock-calculation';
import { SharedBalanceValue } from './shared-erp-indicator';

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function StockCalculationValue({
  value,
  label,
  sharedErpCount,
  erpPartNo,
  onExplain,
}: {
  value: number | null;
  label: string;
  sharedErpCount: number;
  erpPartNo: string | null;
  onExplain: () => void;
}) {
  return (
    <button
      type="button"
      data-no-selection
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onExplain();
      }}
      className="inline-flex min-h-4 max-w-full items-center justify-end whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-blue-700 hover:decoration-solid focus-visible:text-blue-700 focus-visible:decoration-solid focus-visible:outline-none"
      title="查看本期剩餘庫存算式"
      aria-label={`查看 ${label} 算式`}
    >
      <SharedBalanceValue
        value={value}
        label={label}
        sharedErpCount={sharedErpCount}
        erpPartNo={erpPartNo}
      />
    </button>
  );
}

export function StockCalculationDrawer({
  detail,
  onClose,
}: {
  detail: StockCalculationDetail;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const withPlan = detail.balanceKind === 'withPlan';

  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-slate-950/25"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-calculation-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col bg-white shadow-2xl"
        data-stock-calculation-drawer
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold text-blue-700">
              {withPlan ? '含生產計畫' : '不含生產計畫'}
            </div>
            <h3 id="stock-calculation-title" className="text-base font-bold text-slate-900">
              剩餘庫存算式
            </h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">{detail.partVersion}</span>
              <span>{detail.periodLabel}</span>
              {detail.erpPartNo && <span className="font-mono">ERP {detail.erpPartNo}</span>}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            title="關閉"
            aria-label="關閉剩餘庫存算式"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-5">
          {detail.calculationMode === 'aggregated' ? (
            <section className="border border-indigo-200 bg-indigo-50 p-4">
              <div className="text-sm font-semibold text-indigo-900">主件聚合結果</div>
              <p className="mt-1 text-xs leading-5 text-indigo-800">
                此格是多個聚合成員的期末餘額合計，不是單一客料版本的加減式。請展開聚合列，再按成員列的「詳細」查看各成員算式。
              </p>
              <div className="mt-3 font-mono text-xl font-bold text-indigo-950">{formatNumber(detail.balance)}</div>
            </section>
          ) : detail.calculationMode === 'shared' ? (
            <>
              <section className="border border-sky-200 bg-sky-50 p-4">
                <div className="text-sm font-semibold text-sky-900">同 ERP 共享庫存</div>
                <p className="mt-1 text-xs leading-5 text-sky-800">
                  ERP 庫存由 {detail.sharedErpCount} 個客料版本共用，系統依需求日期、客戶代碼與客料版本順序扣用。下式顯示輪到本列時的共享池餘額。
                </p>
              </section>
              <Equation
                openingLabel={detail.openingLabel}
                opening={detail.openingBalance ?? 0}
                plannedOutput={0}
                demand={detail.demandIntegrated}
                result={detail.balance}
                withPlan={false}
              />
              <p className="mt-3 text-xs leading-5 text-slate-500">
                {withPlan
                  ? '扣用前餘額已包含共享池的可用庫存、前期與本期生產計畫供給，以及排在本列之前的其他客料需求。'
                  : '此欄完全排除生產計畫供給；扣用前餘額已包含排在本列之前的其他客料需求。'}
              </p>
            </>
          ) : (
            <>
              {detail.initialTerms.length > 0 && (
                <section className="mb-4 border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 text-xs font-semibold text-slate-700">首期期初可用量</div>
                  <div className="space-y-2 text-xs">
                    {detail.initialTerms.map((term, index) => (
                      <div key={term.label} className="flex items-center justify-between gap-4">
                        <span className="text-slate-600">{index === 0 ? '' : term.operator} {term.label}</span>
                        <span className="font-mono font-semibold text-slate-900">{formatNumber(term.value)}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-slate-300 pt-2 font-semibold">
                      <span>{detail.openingLabel}</span>
                      <span className="font-mono">{formatNumber(detail.openingBalance ?? 0)}</span>
                    </div>
                  </div>
                </section>
              )}
              <Equation
                openingLabel={detail.openingLabel}
                opening={detail.openingBalance ?? 0}
                plannedOutput={detail.plannedOutput}
                demand={detail.demandIntegrated}
                result={detail.balance}
                withPlan={withPlan}
              />
              {!detail.reconciled && (
                <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  畫面欄位與期末結果存在差異，請重新整理資料後再核對。
                </p>
              )}
            </>
          )}

          <section className="mt-5 border-t border-slate-200 pt-4">
            <div className="text-xs font-semibold text-slate-700">不參與此算式</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              不良品庫存、鍛造工令進度、計畫累計報工與計畫累計結案入庫僅供狀態監控，不會加進剩餘庫存。
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}

function Equation({
  openingLabel,
  opening,
  plannedOutput,
  demand,
  result,
  withPlan,
}: {
  openingLabel: string;
  opening: number;
  plannedOutput: number;
  demand: number;
  result: number;
  withPlan: boolean;
}) {
  const terms = [
    { label: openingLabel, operator: '', value: opening },
    ...(withPlan ? [{ label: '本期生產計畫', operator: '+', value: plannedOutput }] : []),
    { label: '本期需求整合', operator: '-', value: demand },
  ];

  return (
    <section className="border border-slate-200 p-4">
      <div className="mb-3 text-xs font-semibold text-slate-700">本期期末計算</div>
      <div className="space-y-2 text-xs">
        {terms.map((term) => (
          <div key={term.label} className="flex items-center justify-between gap-4">
            <span className="text-slate-600">{term.operator} {term.label}</span>
            <span className="font-mono font-semibold text-slate-900">{formatNumber(term.value)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t-2 border-slate-400 pt-2 text-sm font-bold text-slate-900">
          <span>= 期末剩餘庫存</span>
          <span className={`font-mono ${result < 0 ? 'text-red-700' : 'text-emerald-800'}`}>
            {formatNumber(result)}
          </span>
        </div>
      </div>
    </section>
  );
}
