import prisma from '@/lib/db';

const IGNORED_CUSTOMERS_KEY = 'fg_ignored_customer_codes';

// 預設忽略客戶代碼 RD（其料件非真成品，不該出現在成品月推移）。
// 一旦使用者在設定頁存過清單，存的值就取代此預設（含存成空陣列）。
const DEFAULT_IGNORED_CUSTOMERS = ['RD'];

/** 成品月推移要排除的客戶代碼清單。 */
export async function getIgnoredCustomerCodes(): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: IGNORED_CUSTOMERS_KEY } });
  if (!row) return DEFAULT_IGNORED_CUSTOMERS;
  return Array.isArray(row.value) ? (row.value as string[]) : DEFAULT_IGNORED_CUSTOMERS;
}

/** 覆寫忽略清單。回傳清理後（去空白、轉大寫、去空字串、去重）實際存入的值。 */
export async function setIgnoredCustomerCodes(codes: string[]): Promise<string[]> {
  // 轉大寫對齊 DB 的 customer_code（皆為大寫），避免大小寫不符比不中
  const clean = Array.from(new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean)));
  await prisma.appSetting.upsert({
    where: { key: IGNORED_CUSTOMERS_KEY },
    create: { key: IGNORED_CUSTOMERS_KEY, value: clean },
    update: { value: clean },
  });
  return clean;
}

const APPLY_SKIP_FG_KEY = 'apply_skip_fg_inventory';

/**
 * 執行 MRP 時是否套用「不計算成品庫存」設定 —— 把該欄位為 Yes 的料件成品庫存當 0 算。
 * 預設 false（仿照 Source：不歸零、照算真實庫存）。每次執行 MRP 由使用者勾選決定。
 */
export async function getApplySkipFgInventory(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: APPLY_SKIP_FG_KEY } });
  return row?.value === true;
}

export async function setApplySkipFgInventory(on: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: APPLY_SKIP_FG_KEY },
    create: { key: APPLY_SKIP_FG_KEY, value: on },
    update: { value: on },
  });
}

const AUTO_FOLLOW_LATEST_RUN_KEY = 'auto_follow_latest_run';

/**
 * 全域開關：有人跑完新 MRP 時，是否讓所有使用者畫面自動切換到最新 run。
 * 預設 true（未設定過視為開啟）。關掉後各人可自由停在舊 run 檢視。
 */
export async function getAutoFollowLatestRun(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_FOLLOW_LATEST_RUN_KEY } });
  return row ? row.value === true : true;
}

export async function setAutoFollowLatestRun(on: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: AUTO_FOLLOW_LATEST_RUN_KEY },
    create: { key: AUTO_FOLLOW_LATEST_RUN_KEY, value: on },
    update: { value: on },
  });
}
