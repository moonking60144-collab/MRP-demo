/**
 * 委外核價變動報表 — 月快照存取層（DB cache）。
 *
 * 即時讀 Ragic（forms44/2 ~6千 + forms31/10 ~5千）每次約 1 秒，改存月快照後開頁秒回。
 *  - 一月一筆 upsert，保留歷史月份。
 *  - 歷史月份快照永不過期；當月快照超過 TTL 標記 stale，由前端觸發背景重抓。
 *  - in-flight 去重：同月同時多人觸發只實際打一次 Ragic。
 */
import prisma from '@/lib/db';
import { config } from '@/lib/config';
import {
  computeOutsourcePriceChanges,
  type RagicRecord,
  type OutsourcePriceChange,
  type OutsourceChangeStats,
} from './outsource-price-change';

// 全表現況 forms44/2 ~6262、forms31/10 ~4650；limit 給寬，逼近就告警（資料會長大）。
const FETCH_LIMIT = 20000;

// 當月快照超過此時間視為過期，下次開頁由前端背景重抓（歷史月份不適用）。
export const CURRENT_MONTH_TTL_MS = 30 * 60 * 1000;

export interface Snapshot {
  month: string; // YYYY-MM
  changes: OutsourcePriceChange[];
  stats: OutsourceChangeStats;
  generatedAt: string; // ISO，前端顯示「資料時間」
  stale: boolean; // 當月且超過 TTL → 前端據此背景重抓
}

/**
 * 直接打 Ragic（中文顯示名當 key——不要 naming=EID，演算法用中文欄位名）。
 * 沿用服務帳戶 RAGIC_API_KEY（已授權 forms44/2 + forms31/10 讀取）。
 */
async function ragicListChinese(path: string): Promise<RagicRecord[]> {
  const url = `${config.ragicBaseUrl}/default${path}?api&v=3&limit=${FETCH_LIMIT}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Basic ${config.ragicApiKey}` },
    cache: 'no-store',
  });
  const text = await res.text();
  // Ragic 權限不足/錯誤是 HTTP 200 + {"status":"ERROR",...}
  if (/"status"\s*:\s*"ERROR"|access right protected/i.test(text.slice(0, 300))) {
    throw new Error(`Ragic ${path} 讀取被拒（服務帳戶權限？）`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Ragic ${path} 回應非 JSON`);
  }
  const records = Object.values(json) as RagicRecord[];
  if (records.length >= FETCH_LIMIT) {
    console.warn(`[委外核價變動] ${path} 回 ${records.length} 筆已達 limit ${FETCH_LIMIT}，可能被截斷，請調高 FETCH_LIMIT`);
  }
  return records;
}

/** 'YYYY-MM' → 是否為當前月。歷史月份的快照永遠視為 fresh。 */
function isCurrentMonth(month: string): boolean {
  const d = new Date();
  const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return month === cur;
}

function computeStale(month: string, generatedAt: Date): boolean {
  if (!isCurrentMonth(month)) return false;
  return Date.now() - generatedAt.getTime() > CURRENT_MONTH_TTL_MS;
}

function toSnapshot(month: string, changes: unknown, stats: unknown, generatedAt: Date): Snapshot {
  return {
    month,
    changes: (changes ?? []) as OutsourcePriceChange[],
    stats: stats as OutsourceChangeStats,
    generatedAt: generatedAt.toISOString(),
    stale: computeStale(month, generatedAt),
  };
}

// 同月同時間多請求 → 只實際打一次 Ragic（單一持久 process，pm2 fork），其餘共用同一 Promise。
const inFlight = new Map<string, Promise<Snapshot>>();

/** 強制重抓：打 Ragic 重算 + upsert DB。手動按鈕與前端 stale 背景重抓都走這裡。 */
export function refreshSnapshot(month: string): Promise<Snapshot> {
  const existing = inFlight.get(month);
  if (existing) return existing;

  const p = (async (): Promise<Snapshot> => {
    const [year, mo] = month.split('-').map(Number);
    const [form44, form10] = await Promise.all([
      ragicListChinese('/forms44/2'),
      ragicListChinese('/forms31/10'),
    ]);
    const { changes, stats } = computeOutsourcePriceChanges(form44, form10, year, mo);
    const row = await prisma.outsourcePriceChangeSnapshot.upsert({
      where: { month },
      // Prisma Json 欄位吃 unknown，用 as 對齊型別
      create: { month, changes: changes as object[], stats: stats as object },
      update: { changes: changes as object[], stats: stats as object, generatedAt: new Date() },
    });
    return toSnapshot(month, row.changes, row.stats, row.generatedAt);
  })();

  inFlight.set(month, p);
  return p.finally(() => inFlight.delete(month));
}

/** 讀快照：DB 有就回（附 stale 旗標）；沒有就同步算一筆（唯一的慢路徑，首次查該月才會走）。 */
export async function getOrCreateSnapshot(month: string): Promise<Snapshot> {
  const row = await prisma.outsourcePriceChangeSnapshot.findUnique({ where: { month } });
  if (row) return toSnapshot(month, row.changes, row.stats, row.generatedAt);
  return refreshSnapshot(month);
}
