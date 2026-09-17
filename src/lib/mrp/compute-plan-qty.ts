/**
 * Pure self-compute of [10]生產計畫 G5 (EID 1027890) plan_qty.
 *
 * No IO, no logging, no side effects — just record-in, number-out. Kept in its
 * own file so the verify step has something cheap to unit-test (the
 * Ragic-fetch + DB-compare layer in verify-plan-qty.ts is intentionally separate).
 *
 * Ragic owns the canonical formula on [10]生產計畫.G5; we recompute it from the
 * referenced EIDs to detect when Ragic's position-based references drift.
 * See: project_ragic_formula_drift_and_fallback.md
 */
import { PLAN_QTY_EIDS as EID, PLAN_QTY_SUBTABLE_KEYS as SUB, PLAN_QTY_AC11_ROW_ANCHOR } from '../sync/plan-qty-eids';
import { parseNum } from '../sync/sync-engine';

interface SubtableRow {
  _ragicId?: string;
  _header_Y?: unknown;
  [eid: string]: unknown;
}

type FullRecord = Record<string, unknown>;

/** True iff this subtable row anchors at design row 11 (where LAST(AC11) looks). */
function isAc11Row(r: SubtableRow): boolean {
  const h = r._header_Y;
  const target = PLAN_QTY_AC11_ROW_ANCHOR;
  const targetStr = String(target);
  if (Array.isArray(h)) return h.some((v) => v === target || v === targetStr);
  return h === target || h === targetStr || h === `[${targetStr}]`;
}

function toStringField(v: unknown): string | null | undefined {
  if (v == null) return v as null | undefined;
  return String(v);
}

/**
 * Compute G5 (1027890) plan_qty from a single-record JSON.
 *
 * Original Ragic formula (snapshot-only — see verify spec for authoritative source):
 *   MAX(
 *     IF(H4.RAW!="",
 *       IF(UNIQUE(B17).length>0, H4-N17, H4),
 *       IF(UNIQUE(B17).length>0, E4-N17, E4)
 *     ) - IF(LAST(AC11)>0, LAST(AC11), 0),
 *     0
 *   )
 *
 * `LAST(AC11)` operates on rows in `_subtable_1005987` anchored at `_header_Y=[11]`,
 * sorted by `_ragicId` ascending (Ragic's insertion order).
 */
export function computePlanQty(rec: FullRecord): number {
  const h4Raw = toStringField(rec[EID.H4_QTY_OVERRIDE]);
  const h4HasValue = h4Raw != null && h4Raw.trim() !== '';

  // Split subtable (rows at design row 17)
  const splitBucket = (rec[SUB.SPLIT] as Record<string, SubtableRow> | undefined) ?? {};
  const splitRows = Object.values(splitBucket);
  const splitPlanIds = splitRows
    .map((r) => r[EID.B17_SPLIT_PLAN_ID])
    .filter((v) => v != null && v !== '');
  const splitQtySum = splitRows.reduce(
    (s, r) => s + parseNum(toStringField(r[EID.N17_SPLIT_QTY])),
    0,
  );
  const hasSplit = new Set(splitPlanIds).size > 0;

  // Work order subtable — filter to design row 11 only, sort by insertion order
  const woBucket = (rec[SUB.WORK_ORDERS] as Record<string, SubtableRow> | undefined) ?? {};
  const ac11Rows = Object.values(woBucket)
    .filter(isAc11Row)
    .sort((a, b) => Number(a._ragicId ?? 0) - Number(b._ragicId ?? 0));
  const lastAc11 = ac11Rows.length > 0
    ? parseNum(toStringField(ac11Rows[ac11Rows.length - 1][EID.AC11_ACCUMULATED_QTY]))
    : 0;

  const base = h4HasValue
    ? (hasSplit ? parseNum(h4Raw) - splitQtySum : parseNum(h4Raw))
    : (hasSplit
        ? parseNum(toStringField(rec[EID.E4_TARGET_QTY])) - splitQtySum
        : parseNum(toStringField(rec[EID.E4_TARGET_QTY])));
  const deduct = lastAc11 > 0 ? lastAc11 : 0;

  return Math.max(base - deduct, 0);
}
