export type SyntheticPriceRecord = Record<string, unknown> & {
  linkedProducts?: Record<string, { 成品對應客戶料號?: unknown }>;
};

export interface OutsourcePriceChange {
  erpPartNo: string;
  process: string;
  vendor: string;
  oldPrice: string;
  newPrice: string;
  changePct: string;
  newEffectiveDate: string;
  newStatus: string;
  oldEffectiveDate: string;
  note: string;
  customerParts: string[];
  customerPartVersions: string[];
}

export interface OutsourceChangeStats {
  total: number;
  outsource: number;
  candidates: number;
  excludedNew: number;
  excludedSame: number;
  changed: number;
}

function dateKey(value: unknown): number {
  const match = String(value ?? '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}

function inMonth(value: unknown, year: number, month: number): boolean {
  const match = String(value ?? '').match(/^(\d{4})\/(\d{1,2})\//);
  return !!match && Number(match[1]) === year && Number(match[2]) === month;
}

function extractProcess(erpPartNo: string): string {
  return erpPartNo.match(/-\d{2}([A-Z]{2})$/)?.[1] ?? '';
}

function customerPartsOf(record: SyntheticPriceRecord): string[] {
  if (!record.linkedProducts || typeof record.linkedProducts !== 'object') return [];
  return Object.values(record.linkedProducts)
    .map((row) => String(row?.成品對應客戶料號 ?? '').trim())
    .filter(Boolean);
}

function parsePrice(value: string): number {
  const normalized = value.replace(/,/g, '').trim();
  return normalized ? Number(normalized) : Number.NaN;
}

export function computeOutsourcePriceChanges(
  prices: SyntheticPriceRecord[],
  products: SyntheticPriceRecord[],
  year: number,
  month: number,
): { changes: OutsourcePriceChange[]; stats: OutsourceChangeStats } {
  const versions = new Map<string, string[]>();
  for (const product of products) {
    const customerPart = String(product['客戶料號'] ?? '').trim();
    const version = String(product['客戶料號版本'] ?? '').trim();
    if (!customerPart || !version) continue;
    versions.set(customerPart, [...(versions.get(customerPart) ?? []), version]);
  }

  const outsource = prices.filter((record) => record['核價種類'] === '委外');
  const groups = new Map<string, SyntheticPriceRecord[]>();
  for (const record of outsource) {
    const erpPartNo = String(record['ERP料號'] ?? '').trim();
    if (erpPartNo) groups.set(erpPartNo, [...(groups.get(erpPartNo) ?? []), record]);
  }

  let candidates = 0;
  let excludedNew = 0;
  let excludedSame = 0;
  const changes: OutsourcePriceChange[] = [];
  for (const [erpPartNo, records] of groups) {
    for (const candidate of records.filter((record) => inMonth(record['生效日期'], year, month))) {
      candidates++;
      const candidateDate = dateKey(candidate['生效日期']);
      let previous: SyntheticPriceRecord | null = null;
      let previousDate = -Infinity;
      for (const record of records) {
        if (record === candidate) continue;
        const value = dateKey(record['生效日期']);
        if (!Number.isNaN(value) && value < candidateDate && value > previousDate) {
          previous = record;
          previousDate = value;
        }
      }
      if (!previous) { excludedNew++; continue; }

      const oldPrice = String(previous['單價'] ?? '');
      const newPrice = String(candidate['單價'] ?? '');
      const oldNumber = parsePrice(oldPrice);
      const newNumber = parsePrice(newPrice);
      const samePrice = Number.isFinite(oldNumber) && Number.isFinite(newNumber)
        ? oldNumber === newNumber
        : oldPrice.trim() === newPrice.trim();
      if (samePrice) { excludedSame++; continue; }

      const percentage = Number.isFinite(oldNumber) && Number.isFinite(newNumber) && oldNumber !== 0
        ? Math.round(((newNumber - oldNumber) / oldNumber) * 1000) / 10
        : null;
      const customerParts = customerPartsOf(candidate);
      changes.push({
        erpPartNo,
        process: extractProcess(erpPartNo),
        vendor: String(candidate['MIS廠商簡稱'] ?? ''),
        oldPrice,
        newPrice,
        changePct: percentage === null ? '' : `${percentage > 0 ? '+' : ''}${percentage.toFixed(1)}`,
        newEffectiveDate: String(candidate['生效日期'] ?? ''),
        newStatus: String(candidate['狀態'] ?? ''),
        oldEffectiveDate: String(previous['生效日期'] ?? ''),
        note: String(candidate['備註'] ?? '').replace(/[\r\n]+/g, ' '),
        customerParts,
        customerPartVersions: [...new Set(customerParts.flatMap((part) => versions.get(part) ?? []))],
      });
    }
  }

  return { changes, stats: { total: prices.length, outsource: outsource.length, candidates, excludedNew, excludedSame, changed: changes.length } };
}
