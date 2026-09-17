'use client';

import type { MouseEvent } from 'react';
import {
  formatComponentWeeklyLeadTime,
  hasKnownComponentWeeklyLeadTime,
  presentComponentWeeklyPurchaseAction,
  presentComponentWeeklyShortage,
  type ComponentWeeklyDecisionSummary,
  type ComponentWeeklyDecisionTone,
} from '@/lib/mrp/component-weekly-purchase';

const TONE_CLASSES: Record<ComponentWeeklyDecisionTone, string> = {
  danger: 'border-red-200 bg-red-50 text-red-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  safe: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  muted: 'border-slate-200 bg-slate-50 text-slate-400',
};

function DecisionButton({
  label,
  detail,
  tone,
  title,
  onClick,
  compact = false,
}: {
  label: string;
  detail: string | null;
  tone: ComponentWeeklyDecisionTone;
  title: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`inline-flex max-w-full flex-col items-center justify-center rounded-sm border text-center font-semibold tabular-nums underline decoration-current decoration-dotted underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${
        compact ? 'min-h-8 px-1 py-0.5 text-[10px] leading-3' : 'min-h-9 px-1.5 py-1 text-[11px] leading-4'
      } ${TONE_CLASSES[tone]}`}
      onClick={onClick}
      title={title}
    >
      <span>{label}</span>
      {detail && <span className="max-w-full truncate text-[9px] font-normal opacity-80">{detail}</span>}
    </button>
  );
}

export function ComponentWeeklyLeadTimeButton({
  summary,
  onClick,
  compact = false,
}: {
  summary: ComponentWeeklyDecisionSummary;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
}) {
  if (summary.mrpType === 'D') {
    return (
      <DecisionButton
        label="—"
        detail={null}
        tone="muted"
        title="內製組合不使用採購前置期"
        onClick={onClick}
        compact={compact}
      />
    );
  }
  const configured = hasKnownComponentWeeklyLeadTime(summary);
  return (
    <DecisionButton
      label={formatComponentWeeklyLeadTime(summary)}
      detail={configured ? null : '請補主檔'}
      tone={configured ? 'info' : 'warning'}
      title="查看採購前置期與來源"
      onClick={onClick}
      compact={compact}
    />
  );
}

export function ComponentWeeklyShortageButton({
  summary,
  onClick,
  compact = false,
}: {
  summary: ComponentWeeklyDecisionSummary;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
}) {
  const presentation = presentComponentWeeklyShortage(summary);
  return (
    <DecisionButton
      {...presentation}
      title="查看缺貨週與缺口計算來源"
      onClick={onClick}
      compact={compact}
    />
  );
}

export function ComponentWeeklyPurchaseActionButton({
  summary,
  onClick,
  compact = false,
}: {
  summary: ComponentWeeklyDecisionSummary;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
}) {
  const presentation = presentComponentWeeklyPurchaseAction(summary);
  return (
    <DecisionButton
      {...presentation}
      title="查看最晚下單與採購未交來源"
      onClick={onClick}
      compact={compact}
    />
  );
}
