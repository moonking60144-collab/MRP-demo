/**
 * Single source of truth for the EID set that the [10]生產計畫 G5 (1027890)
 * plan_qty formula references. Used by both:
 *
 *   - sync (writes 1027890 → staging.production_plans.plan_qty), and
 *   - verify (recomputes G5 from H4/E4/B17/N17/AC11 to detect Ragic formula drift)
 *
 * If Ragic ever renames or re-numbers any of these EIDs, this is the only place
 * to change. SOURCE_FIELD_MAP_PRODUCTION_PLANS in field-maps.ts continues to map
 * 1027890 → 'plan_qty' for sync; this file documents the dependencies that go
 * INTO that value.
 */
export const PLAN_QTY_EIDS = {
  /** [初版]目標數量 (d4/10 main table position E4). */
  E4_TARGET_QTY: '1014062',
  /** 數量修正 (d4/10 main table position H4). Listing-mode omits this — needs full-record fetch. */
  H4_QTY_OVERRIDE: '1028252',
  /** Ragic-computed [最新]預計完工數量 (d4/10 main table position G5, the value being verified). */
  G5_PLAN_QTY: '1027890',
  /** 拆單子表 生產計劃編號 (B17), used for UNIQUE(...).length>0 split-detection. */
  B17_SPLIT_PLAN_ID: '1006542',
  /** 拆單子表 [拆單估算用]計畫數量 (N17), subtracted from base when split. */
  N17_SPLIT_QTY: '1035260',
  /** 工令單子表 [實際]累計入庫量pc (AC11), source for LAST(AC11). */
  AC11_ACCUMULATED_QTY: '1006866',
} as const;

/**
 * JSON keys that hold the relevant subtables in a single-record fetch
 * (`fetchRagicRecord('/default/d4/10', recordId)`).
 *
 * Empty subtables don't appear in the JSON — callers must default to `{}`.
 */
export const PLAN_QTY_SUBTABLE_KEYS = {
  /** 拆單子表 — rows belong to design row 17. */
  SPLIT: '_subtable_1006545',
  /** 工令單子表 — rows belong to design row 11 (filter on `_header_Y=[11]`). */
  WORK_ORDERS: '_subtable_1005987',
} as const;

/**
 * Subtable rows the formula `LAST(AC11)` references live at design row 11.
 * The same `_subtable_1005987` JSON bucket also contains rows at row 31
 * (a different subtable area in the d4/10 view), so we MUST filter on
 * `_header_Y` before taking the last.
 */
export const PLAN_QTY_AC11_ROW_ANCHOR = 11;
