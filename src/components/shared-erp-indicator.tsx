interface SharedErpProps {
  sharedErpCount?: number;
  erpPartNo: string | null;
}

export function SharedErpLegend() {
  return (
    <span
      className="inline-flex items-center rounded-[3px] border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-medium text-sky-800"
      title="同一 ERP 料號共用同一組實體庫存與生產計畫供給；各客料版本餘額依 MRP 排序順序扣用。"
    >
      同 ERP 共享庫存
    </span>
  );
}

interface SharedBalanceValueProps extends SharedErpProps {
  value: number | null;
  label: string;
  unit?: string;
  mutedZero?: boolean;
  warning?: string;
}

export function SharedBalanceValue({
  value,
  label,
  sharedErpCount = 1,
  erpPartNo,
  unit = 'pc',
  mutedZero = true,
  warning,
}: SharedBalanceValueProps) {
  const isShared = sharedErpCount > 1 && !!erpPartNo;
  const formatted = value == null ? '—' : value.toLocaleString();
  const sharedText = isShared
    ? [
        `ERP ${erpPartNo} 共享庫存`,
        `共 ${sharedErpCount} 個客料版本`,
        `${label}: ${formatted}${value == null ? '' : ` ${unit}`}`,
        '此數值是共享池快照，不可與同 ERP 其他列相加。',
      ]
    : [];
  const tooltip = [...sharedText, ...(warning ? [warning] : [])].join('\n') || undefined;

  return (
    <span
      className={`inline-flex min-h-4 items-center justify-end gap-1 whitespace-nowrap ${
        warning
          ? 'rounded-[3px] bg-amber-50 px-1 text-amber-800 ring-1 ring-inset ring-amber-400'
          : isShared
            ? 'rounded-[3px] bg-sky-50/90 px-1 ring-1 ring-inset ring-sky-400'
            : ''
      }`}
      title={tooltip}
      aria-label={tooltip}
    >
      {warning && (
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold leading-none text-white" aria-hidden="true">
          !
        </span>
      )}
      <span className={value === 0 && mutedZero ? 'text-slate-300' : undefined}>{formatted}</span>
    </span>
  );
}
