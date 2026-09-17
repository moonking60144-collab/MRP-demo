export interface SharedErpRow {
  erpPartNo: string | null;
}

export interface SharedErpMember extends SharedErpRow {
  partVersion: string;
}

export interface SharedErpPlan extends SharedErpRow {
  partVersion: string | null;
}

export interface SharedErpDisplayMember extends SharedErpMember {
  customerCode: string | null;
}

function erpKey(erpPartNo: string | null | undefined): string | null {
  const key = erpPartNo?.trim();
  return key || null;
}

export function buildSharedErpCountMap(rows: readonly SharedErpRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = erpKey(row.erpPartNo);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function attachSharedErpCounts<T extends SharedErpRow>(
  rows: readonly T[],
  population: readonly SharedErpRow[] = rows,
): Array<T & { sharedErpCount: number }> {
  const counts = buildSharedErpCountMap(population);
  return rows.map((row) => {
    const key = erpKey(row.erpPartNo);
    return {
      ...row,
      sharedErpCount: key ? counts.get(key) ?? 1 : 1,
    };
  });
}

export function buildSharedErpPoolUsageSet(
  members: readonly SharedErpMember[],
  plans: readonly SharedErpPlan[],
): Set<string> {
  const membersByErp = new Map<string, Set<string>>();
  const erpByPartVersion = new Map<string, string>();

  for (const member of members) {
    const key = erpKey(member.erpPartNo);
    const partVersion = member.partVersion.trim();
    if (!key || !partVersion) continue;
    const memberKeys = membersByErp.get(key) ?? new Set<string>();
    memberKeys.add(partVersion);
    membersByErp.set(key, memberKeys);
    erpByPartVersion.set(partVersion, key);
  }

  const sharedErps = new Set<string>();
  for (const [key, memberKeys] of membersByErp) {
    if (memberKeys.size > 1) sharedErps.add(key);
  }

  for (const plan of plans) {
    const partVersion = plan.partVersion?.trim() || null;
    const key = erpKey(plan.erpPartNo)
      ?? (partVersion ? erpByPartVersion.get(partVersion) ?? null : null);
    if (!key) continue;
    const memberKeys = membersByErp.get(key);
    if (memberKeys && (!partVersion || !memberKeys.has(partVersion))) {
      sharedErps.add(key);
    }
  }

  return sharedErps;
}

export function selectSharedErpDisplayOwner<T extends SharedErpDisplayMember>(
  members: readonly T[],
): T | null {
  let owner: T | null = null;
  for (const member of members) {
    const memberPartVersion = member.partVersion.trim();
    if (!memberPartVersion) continue;
    const ownerPartVersion = owner?.partVersion.trim() ?? '';
    if (
      owner === null
      || (member.customerCode ?? '') < (owner.customerCode ?? '')
      || (
        (member.customerCode ?? '') === (owner.customerCode ?? '')
        && memberPartVersion < ownerPartVersion
      )
    ) {
      owner = member;
    }
  }
  return owner;
}

export function resolveSharedErpPlanDisplayMember<T extends SharedErpDisplayMember>(
  plan: SharedErpPlan,
  members: readonly T[],
  usesSharedErpPool: boolean,
): T | null {
  const assignedPartVersion = plan.partVersion?.trim();
  if (assignedPartVersion) {
    const assignedMember = members.find(
      (member) => member.partVersion.trim() === assignedPartVersion,
    );
    if (assignedMember) return assignedMember;
  }
  return usesSharedErpPool ? selectSharedErpDisplayOwner(members) : null;
}

export function attachSharedErpPoolInfo<T extends SharedErpMember>(
  rows: readonly T[],
  population: readonly SharedErpMember[],
  plans: readonly SharedErpPlan[],
): Array<T & { sharedErpCount: number; usesSharedErpPool: boolean }> {
  const counts = buildSharedErpCountMap(population);
  const sharedErps = buildSharedErpPoolUsageSet(population, plans);
  return rows.map((row) => {
    const key = erpKey(row.erpPartNo);
    return {
      ...row,
      sharedErpCount: key ? counts.get(key) ?? 1 : 1,
      usesSharedErpPool: key ? sharedErps.has(key) : false,
    };
  });
}

export function sumPhysicalInventoryByErp<T extends SharedErpRow & {
  partVersion: string;
  currentStockPc: unknown;
  mainStockPc: unknown;
  auxStockPc: unknown;
  badStockPc: unknown;
}>(rows: readonly T[]): {
  currentStockPc: number;
  mainStockPc: number;
  auxStockPc: number;
  badStockPc: number;
} {
  const stocks = new Map<string, {
    currentStockPc: number;
    mainStockPc: number;
    auxStockPc: number;
    badStockPc: number;
  }>();
  for (const row of rows) {
    const key = erpKey(row.erpPartNo) ?? `part:${row.partVersion}`;
    if (stocks.has(key)) continue;
    stocks.set(key, {
      currentStockPc: Number(row.currentStockPc) || 0,
      mainStockPc: Number(row.mainStockPc) || 0,
      auxStockPc: Number(row.auxStockPc) || 0,
      badStockPc: Number(row.badStockPc) || 0,
    });
  }
  return [...stocks.values()].reduce(
    (total, stock) => ({
      currentStockPc: total.currentStockPc + stock.currentStockPc,
      mainStockPc: total.mainStockPc + stock.mainStockPc,
      auxStockPc: total.auxStockPc + stock.auxStockPc,
      badStockPc: total.badStockPc + stock.badStockPc,
    }),
    { currentStockPc: 0, mainStockPc: 0, auxStockPc: 0, badStockPc: 0 },
  );
}
