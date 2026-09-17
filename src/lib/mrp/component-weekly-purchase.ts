export type ComponentWeeklyPurchaseAction =
  | 'expedite_overdue_po'
  | 'expedite_open_po'
  | 'expedite_and_order'
  | 'lead_time_missing'
  | 'order_now'
  | 'plan_order'
  | 'covered_by_open_po'
  | 'review_overdue_po'
  | 'no_action';

export interface ComponentWeeklyPurchaseDecisionInput {
  mrpType: 'W' | 'B' | 'D';
  shortageStartWeek: number | null;
  shortageQty: number;
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean | null;
  overduePurchaseQty: number;
  overduePurchaseCount: number;
  futurePurchaseQty: number;
  latePurchaseQty: number;
  shortageStartDate: Date | null;
  nextPurchaseReceiptDate: Date | null;
}

export interface ComponentWeeklyPurchaseDecision {
  purchaseAction: ComponentWeeklyPurchaseAction | null;
  weeksUntilOrder: number | null;
}

export function isComponentWeeklyPurchaseOverdue(
  deliveryDate: Date | null | undefined,
  runDate: Date,
): boolean {
  if (!deliveryDate) return false;
  const taipeiRunDate = new Date(runDate.getTime() + 8 * 60 * 60 * 1000);
  const runCalendarDate = new Date(Date.UTC(
    taipeiRunDate.getUTCFullYear(),
    taipeiRunDate.getUTCMonth(),
    taipeiRunDate.getUTCDate(),
  ));
  return deliveryDate < runCalendarDate;
}

export type ComponentWeeklyDecisionTone = 'danger' | 'warning' | 'info' | 'safe' | 'muted';

export interface ComponentWeeklyDecisionSummary {
  mrpType: string;
  unit: string | null;
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean | null;
  shortageStartWeek: number | null;
  shortageStartDate: string | Date | null;
  shortageQty: number | string;
  weeksUntilOrder: number | null;
  orderByDate: string | Date | null;
  purchaseAction: ComponentWeeklyPurchaseAction | null;
  overduePurchaseQty: number | string;
  overduePurchaseCount: number;
  futurePurchaseQty: number | string;
  futurePurchaseCount: number;
  nextPurchaseReceiptDate: string | Date | null;
}

export interface ComponentWeeklyDecisionPresentation {
  label: string;
  detail: string | null;
  tone: ComponentWeeklyDecisionTone;
}

function formatMonthDay(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatQuantity(value: number | string, unit: string | null): string {
  const numericValue = Number(value);
  const quantity = Number.isFinite(numericValue)
    ? numericValue.toLocaleString('zh-TW', { maximumFractionDigits: 3 })
    : '—';
  return `${quantity}${unit ? ` ${unit}` : ''}`;
}

export function hasKnownComponentWeeklyLeadTime(
  input: Pick<ComponentWeeklyDecisionSummary, 'purchaseLeadWeeks' | 'purchaseLeadWeeksConfigured'>,
): boolean {
  return input.purchaseLeadWeeksConfigured === true
    || (
      input.purchaseLeadWeeksConfigured === null
      && Number(input.purchaseLeadWeeks) > 0
    );
}

export function formatComponentWeeklyLeadTime(
  input: Pick<ComponentWeeklyDecisionSummary, 'purchaseLeadWeeks' | 'purchaseLeadWeeksConfigured'>
    & Partial<Pick<ComponentWeeklyDecisionSummary, 'mrpType'>>,
): string {
  if (input.mrpType === 'D') return '—';
  if (!hasKnownComponentWeeklyLeadTime(input)) {
    return input.purchaseLeadWeeksConfigured === null ? '舊 Run 未知' : '未設定';
  }
  return `${input.purchaseLeadWeeks.toLocaleString('zh-TW', { maximumFractionDigits: 3 })} 週`;
}

export function presentComponentWeeklyShortage(
  input: ComponentWeeklyDecisionSummary,
): ComponentWeeklyDecisionPresentation {
  const shortageQty = Number(input.shortageQty);
  if (input.shortageStartWeek === null) {
    return { label: '28週內無缺貨', detail: null, tone: 'safe' };
  }
  if (input.shortageStartWeek === 0) {
    return {
      label: '已缺料／前期',
      detail: shortageQty > 0
        ? `缺口 ${formatQuantity(input.shortageQty, input.unit)}`
        : null,
      tone: 'danger',
    };
  }
  const date = formatMonthDay(input.shortageStartDate);
  return {
    label: `W${String(input.shortageStartWeek).padStart(2, '0')}${date ? ` ${date}` : ''}`,
    detail: shortageQty > 0
      ? `缺口 ${formatQuantity(input.shortageQty, input.unit)}`
      : null,
    tone: 'warning',
  };
}

export function presentComponentWeeklyPurchaseAction(
  input: ComponentWeeklyDecisionSummary,
): ComponentWeeklyDecisionPresentation {
  if (input.mrpType === 'D') {
    return { label: '—', detail: null, tone: 'muted' };
  }
  if (input.purchaseAction === null) {
    return { label: '舊 Run 未計算', detail: '請以新版 Run 判讀', tone: 'muted' };
  }
  if (input.purchaseAction === 'expedite_overdue_po') {
    return {
      label: '催交逾期 PO',
      detail: `${input.overduePurchaseCount} 筆／${formatQuantity(input.overduePurchaseQty, input.unit)}`,
      tone: 'danger',
    };
  }
  if (input.purchaseAction === 'expedite_open_po') {
    return {
      label: '催交既有 PO',
      detail: '交期晚於缺貨點',
      tone: 'danger',
    };
  }
  if (input.purchaseAction === 'expedite_and_order') {
    return {
      label: '催交＋補單',
      detail: '既有未交仍不足首個缺口',
      tone: 'danger',
    };
  }
  if (input.purchaseAction === 'lead_time_missing') {
    return {
      label: input.shortageStartWeek === 0 ? '立即處理' : '無法推算',
      detail: '前置期未設定',
      tone: 'warning',
    };
  }
  if (input.purchaseAction === 'order_now') {
    return { label: '立即下單', detail: '已進前置期', tone: 'danger' };
  }
  if (input.purchaseAction === 'plan_order') {
    const date = formatMonthDay(input.orderByDate);
    return {
      label: `W${String(input.weeksUntilOrder).padStart(2, '0')}${date ? ` ${date}` : ''}`,
      detail: '最晚下單',
      tone: 'warning',
    };
  }
  if (input.purchaseAction === 'covered_by_open_po') {
    const date = formatMonthDay(input.nextPurchaseReceiptDate);
    return {
      label: '已有未交採購',
      detail: date ? `下批 ${date}` : `${input.futurePurchaseCount} 筆`,
      tone: 'info',
    };
  }
  if (input.purchaseAction === 'review_overdue_po') {
    return {
      label: '催交逾期 PO',
      detail: `目前未缺料／${input.overduePurchaseCount} 筆`,
      tone: 'warning',
    };
  }
  return { label: '暫不需下單', detail: null, tone: 'safe' };
}

export function resolveComponentWeeklyPurchaseDecision(
  input: ComponentWeeklyPurchaseDecisionInput,
): ComponentWeeklyPurchaseDecision {
  if (input.mrpType === 'D') {
    return { purchaseAction: null, weeksUntilOrder: null };
  }

  if (input.shortageStartWeek === null) {
    if (input.overduePurchaseCount > 0) {
      return { purchaseAction: 'review_overdue_po', weeksUntilOrder: null };
    }
    if (input.futurePurchaseQty > 0) {
      return { purchaseAction: 'covered_by_open_po', weeksUntilOrder: null };
    }
    return { purchaseAction: 'no_action', weeksUntilOrder: null };
  }

  if (input.overduePurchaseCount > 0) {
    if (input.overduePurchaseQty >= input.shortageQty) {
      return { purchaseAction: 'expedite_overdue_po', weeksUntilOrder: 0 };
    }
    return {
      purchaseAction: input.overduePurchaseQty + input.latePurchaseQty >= input.shortageQty
        ? 'expedite_open_po'
        : 'expedite_and_order',
      weeksUntilOrder: 0,
    };
  }

  if (input.latePurchaseQty > 0) {
    return {
      purchaseAction: input.overduePurchaseQty + input.latePurchaseQty >= input.shortageQty
        ? 'expedite_open_po'
        : 'expedite_and_order',
      weeksUntilOrder: 0,
    };
  }

  if (input.purchaseLeadWeeksConfigured !== true) {
    return { purchaseAction: 'lead_time_missing', weeksUntilOrder: null };
  }

  const weeksUntilOrder = Math.max(
    0,
    input.shortageStartWeek - input.purchaseLeadWeeks,
  );
  return {
    purchaseAction: weeksUntilOrder === 0 ? 'order_now' : 'plan_order',
    weeksUntilOrder,
  };
}
