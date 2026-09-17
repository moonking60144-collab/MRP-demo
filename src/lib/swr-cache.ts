/**
 * 跨頁 stale-while-revalidate 快取（module-level，刻意在 React 樹之外，切頁 unmount 不清）。
 * 用途：切回看過的列表頁時，用快取的 stale 資料「首幀就顯示」，避免換頁後的 spinner 空窗，
 * 同時背景 revalidate 取最新。
 *
 * key 一律用 fetch 的完整 URL（已含 runId + 所有 filter/sort/page）→「URL 一樣 = 資料一樣」，
 * 零額外 hash。merge 模式不進快取（呼叫端自行跳過），避免「不帶 run 維度、無從失效」的死角。
 *
 * 安全性：寫入（存計畫/轉單）後端一律寫 getLatestRun()，寫入欄位來自當下輸入而非快取列，
 * 且看舊 run 時 isLatestSelected 已 disable 編輯 → 快取的 stale 不可能造成寫錯 run。
 * 故唯讀頁吃 stale 安全；可編輯頁只快取「主列表」(瀏覽用)，展開明細不快取。
 */

interface Entry<T> {
  data: T;
  ts: number;
}

const store = new Map<string, Entry<unknown>>(); // Map 保留插入序 → 當 LRU 序用
const MAX = 256; // 全 app 總上限（7 頁 × filter 組合 × 傳統 view periods 共用，給寬避免互相擠掉）
const DEFAULT_TTL = 5 * 60_000;

/** 讀快取且不更動 LRU 序（給 useState lazy seed 用，避免 render 次數污染淘汰序）。 */
export function cachePeek<T>(key: string): T | undefined {
  return (store.get(key) as Entry<T> | undefined)?.data;
}

/** 讀快取並把它移到 LRU 尾端（最近使用）。 */
export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return undefined;
  store.delete(key);
  store.set(key, e);
  return e.data;
}

/** TTL 內視為夠新（決定要不要背景 revalidate；SWR 即使過期也先回 stale，由 get/peek 負責）。 */
export function cacheIsFresh(key: string, ttl = DEFAULT_TTL): boolean {
  const e = store.get(key);
  return !!e && Date.now() - e.ts < ttl;
}

export function cacheSet<T>(key: string, data: T): void {
  store.delete(key);
  store.set(key, { data, ts: Date.now() });
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 砍掉所有符合 predicate 的 key（寫入動作 / SSE 切 run 後失效全域 endpoint 用）。 */
export function cacheInvalidate(predicate: (key: string) => boolean): void {
  for (const k of [...store.keys()]) if (predicate(k)) store.delete(k);
}
