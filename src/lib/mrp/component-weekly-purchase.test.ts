import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatComponentWeeklyLeadTime,
  hasKnownComponentWeeklyLeadTime,
  isComponentWeeklyPurchaseOverdue,
  presentComponentWeeklyPurchaseAction,
  presentComponentWeeklyShortage,
  resolveComponentWeeklyPurchaseDecision,
  type ComponentWeeklyDecisionSummary,
} from './component-weekly-purchase';

test('採購逾期以 Run 的台北日曆日判斷，不把同日交期誤判逾期', () => {
  const runDate = new Date('2026-08-04T07:46:00.000Z');
  assert.equal(
    isComponentWeeklyPurchaseOverdue(new Date('2026-08-03T00:00:00.000Z'), runDate),
    true,
  );
  assert.equal(
    isComponentWeeklyPurchaseOverdue(new Date('2026-08-04T00:00:00.000Z'), runDate),
    false,
  );
});

test('legacy 正數前置期維持可辨識，legacy 0 則維持未知', () => {
  assert.equal(hasKnownComponentWeeklyLeadTime({
    purchaseLeadWeeks: 12,
    purchaseLeadWeeksConfigured: null,
  }), true);
  assert.equal(formatComponentWeeklyLeadTime({
    purchaseLeadWeeks: 12,
    purchaseLeadWeeksConfigured: null,
  }), '12 週');
  assert.equal(hasKnownComponentWeeklyLeadTime({
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: null,
  }), false);
  assert.equal(formatComponentWeeklyLeadTime({
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: null,
  }), '舊 Run 未知');
});

const base = {
  mrpType: 'B' as const,
  shortageStartWeek: 5 as number | null,
  shortageQty: 100,
  purchaseLeadWeeks: 2,
  purchaseLeadWeeksConfigured: true as boolean | null,
  overduePurchaseQty: 0,
  overduePurchaseCount: 0,
  futurePurchaseQty: 0,
  latePurchaseQty: 0,
  shortageStartDate: new Date('2026-08-31T00:00:00.000Z'),
  nextPurchaseReceiptDate: null,
};

test('未來缺貨依前置期推算最晚下單週', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision(base), {
    purchaseAction: 'plan_order',
    weeksUntilOrder: 3,
  });
});

test('前期或前置期內缺料皆要求立即下單', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 0,
  }), {
    purchaseAction: 'order_now',
    weeksUntilOrder: 0,
  });
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 2,
    purchaseLeadWeeks: 12,
  }), {
    purchaseAction: 'order_now',
    weeksUntilOrder: 0,
  });
});

test('前置期未設定時不捏造下單週', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
  }), {
    purchaseAction: 'lead_time_missing',
    weeksUntilOrder: null,
  });
});

test('逾期 PO 足以覆蓋首個缺口時優先催交，不重複建議採購', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 0,
    shortageQty: 44.4,
    overduePurchaseQty: 2_250,
    overduePurchaseCount: 1,
  }), {
    purchaseAction: 'expedite_overdue_po',
    weeksUntilOrder: 0,
  });
});

test('逾期 PO 不足首個缺口時顯示催交加補單', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 0,
    shortageQty: 100,
    overduePurchaseQty: 40,
    overduePurchaseCount: 1,
  }), {
    purchaseAction: 'expedite_and_order',
    weeksUntilOrder: 0,
  });
});

test('逾期與缺貨後 PO 合計足夠時只催交既有單，不重複補單', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 0,
    shortageQty: 100,
    overduePurchaseQty: 40,
    overduePurchaseCount: 1,
    futurePurchaseQty: 60,
    latePurchaseQty: 60,
  }), {
    purchaseAction: 'expedite_open_po',
    weeksUntilOrder: 0,
  });
});

test('缺料後已有未交 PO 時優先催交，僅在數量不足時要求補單', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 0,
    shortageStartDate: null,
    shortageQty: 44.4,
    futurePurchaseQty: 2_250,
    latePurchaseQty: 2_250,
    nextPurchaseReceiptDate: new Date('2026-09-07T00:00:00.000Z'),
  }), {
    purchaseAction: 'expedite_open_po',
    weeksUntilOrder: 0,
  });
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 5,
    shortageStartDate: new Date('2026-08-31T00:00:00.000Z'),
    shortageQty: 100,
    futurePurchaseQty: 40,
    latePurchaseQty: 40,
    nextPurchaseReceiptDate: new Date('2026-09-07T00:00:00.000Z'),
  }), {
    purchaseAction: 'expedite_and_order',
    weeksUntilOrder: 0,
  });
});

test('多筆未交採購逐筆判斷缺貨後交期，不被較早到貨的一筆遮蔽', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageQty: 100,
    futurePurchaseQty: 240,
    latePurchaseQty: 140,
    nextPurchaseReceiptDate: new Date('2026-08-17T00:00:00.000Z'),
  }), {
    purchaseAction: 'expedite_open_po',
    weeksUntilOrder: 0,
  });
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageQty: 100,
    futurePurchaseQty: 140,
    latePurchaseQty: 40,
    nextPurchaseReceiptDate: new Date('2026-08-17T00:00:00.000Z'),
  }), {
    purchaseAction: 'expedite_and_order',
    weeksUntilOrder: 0,
  });
});

test('缺貨週前已納入的未交 PO 不會被誤判為可催交解法', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: 5,
    shortageStartDate: new Date('2026-08-31T00:00:00.000Z'),
    shortageQty: 100,
    futurePurchaseQty: 40,
    nextPurchaseReceiptDate: new Date('2026-08-17T00:00:00.000Z'),
  }), {
    purchaseAction: 'plan_order',
    weeksUntilOrder: 3,
  });
});

test('無缺貨時區分已有未交採購、逾期待確認與暫不下單', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: null,
    futurePurchaseQty: 200,
  }), {
    purchaseAction: 'covered_by_open_po',
    weeksUntilOrder: null,
  });
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: null,
    overduePurchaseQty: 200,
    overduePurchaseCount: 1,
  }), {
    purchaseAction: 'review_overdue_po',
    weeksUntilOrder: null,
  });
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    shortageStartWeek: null,
  }), {
    purchaseAction: 'no_action',
    weeksUntilOrder: null,
  });
});

test('D 內製組合不產生採購動作', () => {
  assert.deepEqual(resolveComponentWeeklyPurchaseDecision({
    ...base,
    mrpType: 'D',
  }), {
    purchaseAction: null,
    weeksUntilOrder: null,
  });
  assert.equal(formatComponentWeeklyLeadTime({
    mrpType: 'D',
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
  }), '—');
});

test('清單與明細共用前期缺料、下單行動與前置期文案', () => {
  const summary: ComponentWeeklyDecisionSummary = {
    mrpType: 'B',
    unit: 'pc',
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: false,
    shortageStartWeek: 0,
    shortageStartDate: null,
    shortageQty: 58_000,
    weeksUntilOrder: null,
    orderByDate: null,
    purchaseAction: 'lead_time_missing',
    overduePurchaseQty: 0,
    overduePurchaseCount: 0,
    futurePurchaseQty: 0,
    futurePurchaseCount: 0,
    nextPurchaseReceiptDate: null,
  };

  assert.deepEqual(presentComponentWeeklyShortage(summary), {
    label: '已缺料／前期',
    detail: '缺口 58,000 pc',
    tone: 'danger',
  });
  assert.deepEqual(presentComponentWeeklyPurchaseAction(summary), {
    label: '立即處理',
    detail: '前置期未設定',
    tone: 'warning',
  });
  assert.equal(formatComponentWeeklyLeadTime(summary), '未設定');
  assert.equal(formatComponentWeeklyLeadTime({
    purchaseLeadWeeks: 0,
    purchaseLeadWeeksConfigured: true,
  }), '0 週');
});

test('清單與明細將缺料後的既有未交 PO 顯示為催交而非重複下單', () => {
  const summary: ComponentWeeklyDecisionSummary = {
    mrpType: 'W',
    unit: 'kg',
    purchaseLeadWeeks: 8,
    purchaseLeadWeeksConfigured: true,
    shortageStartWeek: 0,
    shortageStartDate: null,
    shortageQty: 44.4,
    weeksUntilOrder: 0,
    orderByDate: null,
    purchaseAction: 'expedite_open_po',
    overduePurchaseQty: 0,
    overduePurchaseCount: 0,
    futurePurchaseQty: 2_250,
    futurePurchaseCount: 1,
    nextPurchaseReceiptDate: '2026-09-07T00:00:00.000Z',
  };

  assert.deepEqual(presentComponentWeeklyPurchaseAction(summary), {
    label: '催交既有 PO',
    detail: '交期晚於缺貨點',
    tone: 'danger',
  });
});

test('清單將 Prisma Decimal 字串數量格式化為與明細一致的三位小數', () => {
  const summary: ComponentWeeklyDecisionSummary = {
    mrpType: 'W',
    unit: 'kg',
    purchaseLeadWeeks: 12,
    purchaseLeadWeeksConfigured: true,
    shortageStartWeek: 10,
    shortageStartDate: '2026-10-05T00:00:00.000Z',
    shortageQty: '0.8500000000000227',
    weeksUntilOrder: 0,
    orderByDate: null,
    purchaseAction: 'order_now',
    overduePurchaseQty: '0',
    overduePurchaseCount: 0,
    futurePurchaseQty: '0',
    futurePurchaseCount: 0,
    nextPurchaseReceiptDate: null,
  };

  assert.deepEqual(presentComponentWeeklyShortage(summary), {
    label: 'W10 10/05',
    detail: '缺口 0.85 kg',
    tone: 'warning',
  });
});

test('舊 Run 沒保存缺口量時只顯示缺貨週，不捏造零缺口', () => {
  const legacySummary: ComponentWeeklyDecisionSummary = {
    mrpType: 'W',
    unit: 'kg',
    purchaseLeadWeeks: 12,
    purchaseLeadWeeksConfigured: null,
    shortageStartWeek: 10,
    shortageStartDate: null,
    shortageQty: 0,
    weeksUntilOrder: null,
    orderByDate: null,
    purchaseAction: null,
    overduePurchaseQty: 0,
    overduePurchaseCount: 0,
    futurePurchaseQty: 0,
    futurePurchaseCount: 0,
    nextPurchaseReceiptDate: null,
  };
  assert.deepEqual(presentComponentWeeklyShortage(legacySummary), {
    label: 'W10',
    detail: null,
    tone: 'warning',
  });
  assert.deepEqual(presentComponentWeeklyPurchaseAction(legacySummary), {
    label: '舊 Run 未計算',
    detail: '請以新版 Run 判讀',
    tone: 'muted',
  });
});
