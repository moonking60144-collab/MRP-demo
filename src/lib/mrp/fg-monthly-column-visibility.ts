export const FG_MONTHLY_COLUMN_VISIBILITY_KEY = 'mrp_colvis_fg_v4';
const PREVIOUS_FG_MONTHLY_COLUMN_VISIBILITY_KEYS = ['mrp_colvis_fg_v3', 'mrp_colvis_fg_v2', 'mrp_colvis_fg'];

interface ColumnVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function migrateFgMonthlyColumnVisibility(storage: ColumnVisibilityStorage): boolean {
  try {
    if (storage.getItem(FG_MONTHLY_COLUMN_VISIBILITY_KEY) !== null) return false;

    const previousRaw = PREVIOUS_FG_MONTHLY_COLUMN_VISIBILITY_KEYS
      .map((key) => storage.getItem(key))
      .find((value) => value !== null) ?? null;
    if (previousRaw === null) return false;

    const parsed = JSON.parse(previousRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

    const previousSystemHidden = new Set(['badStockPc', 'planReportedQty', 'planClosedQty']);
    const migrated = Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => value === false && !previousSystemHidden.has(key)),
    );
    storage.setItem(FG_MONTHLY_COLUMN_VISIBILITY_KEY, JSON.stringify(migrated));
    return true;
  } catch {
    return false;
  }
}
