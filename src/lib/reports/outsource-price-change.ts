/**
 * 委外核價變動報表 — 純計算（移植自已驗證的 scripts/outsource-price-change.mjs，2026/05 重現 56 筆）。
 *
 * 變動定義（依價格歷史判斷，不靠備註——備註會漏報也假報）：
 *  1. 只看 核價種類 === '委外'（我們付外包廠的加工成本，非售價）
 *  2. 按完整 ERP料號 字串分組（含製程版本碼，每製程一筆）
 *  3. 組內找 生效日期 落在目標月的記錄 = 候選新價
 *  4. 舊價 = 同組內 生效日 < 新價生效日 中、生效日最晚那筆（含停用）
 *  5. 有舊價且單價不同 → 變動；沒舊價 → 新料號排除；單價相同 → 排除
 *  6. 對應客戶料號版本：子表 _subtable_1039503 的「成品對應客戶料號」→ join forms31/10
 *     的「客戶料號」→ 取「客戶料號版本」（一對多全列）
 *
 * Ragic API 回應用「中文顯示名」當 key（呼叫端用 ?api&v=3、不要 naming=EID）。
 * 單價是字串型，計算前移除千分位後轉數字、輸出保留原字串。
 */

/** Ragic 記錄（中文名 key），子表放在 _subtable_<id> 底下。 */
export type RagicRecord = Record<string, unknown> & {
  _subtable_1039503?: Record<string, { 成品對應客戶料號?: unknown }>;
};

export interface OutsourcePriceChange {
  erpPartNo: string;        // ERP料號
  process: string;          // 製程（尾碼抽出）
  vendor: string;           // 新廠商 MIS廠商簡稱
  oldPrice: string;         // 舊價（原字串）
  newPrice: string;         // 新價（原字串）
  changePct: string;        // 漲跌幅%（帶正負、1 位小數；無法計算為 ''）
  newEffectiveDate: string; // 新價生效日
  newStatus: string;        // 新狀態
  oldEffectiveDate: string; // 舊價生效日
  note: string;             // 備註（換行壓成空格）
  customerParts: string[];  // 對應客戶料號（子表）
  customerPartVersions: string[]; // 對應客戶料號版本（join forms31/10，一對多）
}

export interface OutsourceChangeStats {
  total: number;       // 全表
  outsource: number;   // 委外
  candidates: number;  // 當月候選新價
  excludedNew: number; // 排除：無舊價（新料號）
  excludedSame: number;// 排除：同價
  changed: number;     // 變動筆數
}

// yyyy/MM/dd -> 可比較數字 yyyymmdd；非法回 NaN
function dateKey(s: unknown): number {
  const m = String(s ?? '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return NaN;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function inMonth(s: unknown, year: number, month: number): boolean {
  const m = String(s ?? '').match(/^(\d{4})\/(\d{1,2})\//);
  return !!m && Number(m[1]) === year && Number(m[2]) === month;
}

// 製程：尾碼 -\d{2}([A-Z]{2})$（HT/EP/CH/CO/TI/LM/DA/HF/BU…）
function extractProcess(erp: string): string {
  const m = erp.match(/-\d{2}([A-Z]{2})$/);
  return m ? m[1] : '';
}

function customerPartsOf(rec: RagicRecord): string[] {
  const sub = rec._subtable_1039503;
  if (!sub || typeof sub !== 'object') return [];
  const out: string[] = [];
  for (const row of Object.values(sub)) {
    const v = row && row['成品對應客戶料號'];
    if (v != null && String(v).trim() !== '') out.push(String(v).trim());
  }
  return out;
}

function parsePrice(value: string): number {
  const normalized = value.replace(/,/g, '').trim();
  return normalized === '' ? NaN : Number(normalized);
}

/**
 * @param form44 /forms44/2 廠商料品核價 全部記錄（中文名 key）
 * @param form10 /forms31/10 客戶料號版本 全部記錄（用於 客戶料號→客戶料號版本 join）
 * @param year/month 目標月（month 1-12）
 */
export function computeOutsourcePriceChanges(
  form44: RagicRecord[],
  form10: RagicRecord[],
  year: number,
  month: number,
): { changes: OutsourcePriceChange[]; stats: OutsourceChangeStats } {
  // 客戶料號 → [客戶料號版本...]（一個客戶料號可對多版本）
  const versionMap = new Map<string, string[]>();
  for (const r of form10) {
    const cust = String(r['客戶料號'] ?? '').trim();
    const ver = String(r['客戶料號版本'] ?? '').trim();
    if (!cust || !ver) continue;
    const arr = versionMap.get(cust);
    if (arr) arr.push(ver);
    else versionMap.set(cust, [ver]);
  }

  const outsource = form44.filter((r) => r['核價種類'] === '委外');

  // 按完整 ERP料號分組
  const groups = new Map<string, RagicRecord[]>();
  for (const r of outsource) {
    const erp = String(r['ERP料號'] ?? '').trim();
    if (!erp) continue;
    const arr = groups.get(erp);
    if (arr) arr.push(r);
    else groups.set(erp, [r]);
  }

  let candidates = 0;
  let excludedNew = 0;
  let excludedSame = 0;
  const changes: OutsourcePriceChange[] = [];

  for (const [erp, list] of groups) {
    for (const cand of list.filter((r) => inMonth(r['生效日期'], year, month))) {
      candidates++;
      const candKey = dateKey(cand['生效日期']);

      // 舊價：同組內生效日 < 新價生效日，取生效日最晚那筆（含停用）
      let prev: RagicRecord | null = null;
      let prevKey = -Infinity;
      for (const r of list) {
        if (r === cand) continue;
        const k = dateKey(r['生效日期']);
        if (!Number.isNaN(k) && k < candKey && k > prevKey) {
          prevKey = k;
          prev = r;
        }
      }

      if (!prev) { excludedNew++; continue; }

      const oldPrice = String(prev['單價'] ?? '');
      const newPrice = String(cand['單價'] ?? '');
      const oldNum = parsePrice(oldPrice);
      const newNum = parsePrice(newPrice);
      const samePrice = Number.isFinite(oldNum) && Number.isFinite(newNum)
        ? oldNum === newNum
        : oldPrice.trim() === newPrice.trim();
      if (samePrice) { excludedSame++; continue; }

      let changePct = '';
      if (Number.isFinite(oldNum) && Number.isFinite(newNum) && oldNum !== 0) {
        const p = Math.round(((newNum - oldNum) / oldNum) * 1000) / 10;
        changePct = (p > 0 ? '+' : '') + p.toFixed(1);
      }

      const customerParts = customerPartsOf(cand);
      const customerPartVersions = [
        ...new Set(customerParts.flatMap((p) => versionMap.get(p) ?? [])),
      ];

      changes.push({
        erpPartNo: erp,
        process: extractProcess(erp),
        vendor: String(cand['MIS廠商簡稱'] ?? ''),
        oldPrice,
        newPrice,
        changePct,
        newEffectiveDate: String(cand['生效日期'] ?? ''),
        newStatus: String(cand['狀態'] ?? ''),
        oldEffectiveDate: String(prev['生效日期'] ?? ''),
        note: String(cand['備註'] ?? '').replace(/[\r\n]+/g, ' '),
        customerParts,
        customerPartVersions,
      });
    }
  }

  return {
    changes,
    stats: {
      total: form44.length,
      outsource: outsource.length,
      candidates,
      excludedNew,
      excludedSame,
      changed: changes.length,
    },
  };
}
