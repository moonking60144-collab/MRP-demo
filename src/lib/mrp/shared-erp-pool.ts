import { ceilPlanQty } from './fg-plan-suggestion';

export interface SharedPoolDemand {
  quantity: number;
  priorityAt?: Date | null;
}

export interface SharedPoolMember {
  key: string;
  customerCode: string | null;
  partVersion: string;
  priorDemand: SharedPoolDemand;
  periodDemands: SharedPoolDemand[];
}

export interface SharedPoolDemandEvent {
  memberKey: string;
  periodIndex: number;
  quantity: number;
  beforeStock: number;
  remainingStock: number;
  beforeNoPlan: number;
  remainingNoPlan: number;
}

export interface SharedPoolMemberResult {
  priorRemainingStock: number;
  priorRemainingNoPlan: number;
  remainingStock: number[];
  remainingNoPlan: number[];
  shortageStartPeriod: number | null;
  shortageStartPeriodNoPlan: number | null;
}

export interface SharedPoolResult {
  members: Map<string, SharedPoolMemberResult>;
  demandEvents: SharedPoolDemandEvent[];
  endingStock: number;
  endingNoPlan: number;
}

export interface SharedPoolSuggestion {
  memberKey: string;
  sequence: number;
  targetStartPeriod: number;
  fulfillToPeriod: number;
  suggestedQty: number;
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? '';
  const right = b ?? '';
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareDemand(
  a: { member: SharedPoolMember; demand: SharedPoolDemand },
  b: { member: SharedPoolMember; demand: SharedPoolDemand },
): number {
  const aTime = a.demand.priorityAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bTime = b.demand.priorityAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;

  const customerOrder = compareText(a.member.customerCode, b.member.customerCode);
  if (customerOrder !== 0) return customerOrder;

  const versionOrder = compareText(a.member.partVersion, b.member.partVersion);
  if (versionOrder !== 0) return versionOrder;

  return compareText(a.member.key, b.member.key);
}

function finiteNonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

export function allocateSharedErpPool(input: {
  initialStock: number;
  priorSupply?: number;
  periodSupply: number[];
  members: SharedPoolMember[];
}): SharedPoolResult {
  const periodCount = input.periodSupply.length;
  const members = new Map<string, SharedPoolMemberResult>();

  for (const member of input.members) {
    if (members.has(member.key)) {
      throw new Error(`共享池 member key 重複: ${member.key}`);
    }
    members.set(member.key, {
      priorRemainingStock: 0,
      priorRemainingNoPlan: 0,
      remainingStock: Array(periodCount).fill(0),
      remainingNoPlan: Array(periodCount).fill(0),
      shortageStartPeriod: null,
      shortageStartPeriodNoPlan: null,
    });
  }

  let runningStock = finiteNonNegative(input.initialStock) + finiteNonNegative(input.priorSupply);
  let runningNoPlan = finiteNonNegative(input.initialStock);
  const demandEvents: SharedPoolDemandEvent[] = [];

  const processPeriod = (periodIndex: number) => {
    const demands = input.members
      .map((member) => ({
        member,
        demand: periodIndex < 0
          ? member.priorDemand
          : member.periodDemands[periodIndex] ?? { quantity: 0, priorityAt: null },
      }))
      .filter(({ demand }) => finiteNonNegative(demand.quantity) > 0)
      .sort(compareDemand);

    for (const { member, demand } of demands) {
      const quantity = finiteNonNegative(demand.quantity);
      const beforeStock = runningStock;
      const beforeNoPlan = runningNoPlan;
      runningStock -= quantity;
      runningNoPlan -= quantity;

      const result = members.get(member.key)!;
      if (periodIndex < 0) {
        result.priorRemainingStock = runningStock;
        result.priorRemainingNoPlan = runningNoPlan;
        if (runningStock < 0) result.shortageStartPeriod = 0;
        if (runningNoPlan < 0) result.shortageStartPeriodNoPlan = 0;
      } else {
        result.remainingStock[periodIndex] = runningStock;
        result.remainingNoPlan[periodIndex] = runningNoPlan;
        if (runningStock < 0 && result.shortageStartPeriod === null) {
          result.shortageStartPeriod = periodIndex;
        }
        if (runningNoPlan < 0 && result.shortageStartPeriodNoPlan === null) {
          result.shortageStartPeriodNoPlan = periodIndex;
        }
      }

      demandEvents.push({
        memberKey: member.key,
        periodIndex,
        quantity,
        beforeStock,
        remainingStock: runningStock,
        beforeNoPlan,
        remainingNoPlan: runningNoPlan,
      });
    }

    for (const member of input.members) {
      const demand = periodIndex < 0
        ? member.priorDemand
        : member.periodDemands[periodIndex] ?? { quantity: 0 };
      if (finiteNonNegative(demand.quantity) > 0) continue;
      const result = members.get(member.key)!;
      if (periodIndex < 0) {
        result.priorRemainingStock = runningStock;
        result.priorRemainingNoPlan = runningNoPlan;
      } else {
        result.remainingStock[periodIndex] = runningStock;
        result.remainingNoPlan[periodIndex] = runningNoPlan;
      }
    }
  };

  processPeriod(-1);

  for (let periodIndex = 0; periodIndex < periodCount; periodIndex++) {
    runningStock += finiteNonNegative(input.periodSupply[periodIndex]);
    processPeriod(periodIndex);
  }

  return {
    members,
    demandEvents,
    endingStock: runningStock,
    endingNoPlan: runningNoPlan,
  };
}

export function suggestSharedErpPoolSupply(input: {
  initialStock: number;
  priorSupply?: number;
  periodSupply: number[];
  members: Array<SharedPoolMember & { targetPeriods: number }>;
  bufferPct: number;
  maxSuggestions?: number;
}): SharedPoolSuggestion[] {
  const allocation = allocateSharedErpPool(input);
  const memberByKey = new Map(input.members.map((member) => [member.key, member]));
  const sequenceByMember = new Map<string, number>();
  const suggestions: SharedPoolSuggestion[] = [];
  const maxSuggestions = input.maxSuggestions ?? 3;

  let simulatedStock = finiteNonNegative(input.initialStock) + finiteNonNegative(input.priorSupply);

  const processEvents = (periodIndex: number) => {
    for (const event of allocation.demandEvents) {
      if (event.periodIndex !== periodIndex) continue;
      simulatedStock -= event.quantity;
      if (simulatedStock >= 0 || suggestions.length >= maxSuggestions) continue;

      const member = memberByKey.get(event.memberKey);
      if (!member) continue;
      const targetStartPeriod = Math.max(0, periodIndex);
      const targetPeriods = Math.max(0, Math.floor(member.targetPeriods));
      if (targetPeriods === 0 || targetStartPeriod >= targetPeriods) continue;

      const endPeriod = Math.min(targetStartPeriod + targetPeriods, input.periodSupply.length);
      let horizonDemand = 0;
      for (const target of input.members) {
        for (let i = targetStartPeriod; i < endPeriod; i++) {
          horizonDemand += finiteNonNegative(target.periodDemands[i]?.quantity);
        }
      }

      const suggestedQty = ceilPlanQty(Math.abs(simulatedStock) + horizonDemand * input.bufferPct);
      if (suggestedQty <= 0) continue;

      const sequence = (sequenceByMember.get(member.key) ?? 0) + 1;
      sequenceByMember.set(member.key, sequence);
      suggestions.push({
        memberKey: member.key,
        sequence,
        targetStartPeriod,
        fulfillToPeriod: endPeriod - 1 + 0.5,
        suggestedQty,
      });
      simulatedStock += suggestedQty;
    }
  };

  processEvents(-1);
  for (let periodIndex = 0; periodIndex < input.periodSupply.length; periodIndex++) {
    simulatedStock += finiteNonNegative(input.periodSupply[periodIndex]);
    processEvents(periodIndex);
  }

  return suggestions;
}
