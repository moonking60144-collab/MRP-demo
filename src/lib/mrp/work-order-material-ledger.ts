export type WorkOrderLedgerUnit = 'pc' | 'kg';

export type WorkOrderLedgerError =
  | 'ledger_attribution_ambiguous'
  | 'ledger_balance_missing'
  | 'ledger_handoff_incomplete'
  | 'ledger_issue_not_found';

export interface WorkOrderIssueAllocation {
  bomRecordId: string;
  workOrderNo: string;
  bomItemKey: string | null;
  componentNo: string;
  inventoryLotNo: string;
  unit: unknown;
  issuedAt: Date | null;
}

export interface WorkOrderLedgerMovement {
  sourceRecordId: string;
  inventoryLotNo: string | null;
  componentNo: string | null;
  movementDate: Date | null;
  basisType: string | null;
  movementType: string | null;
  inputUnit: string | null;
  inputQtyPc: number | null;
  inputQtyKg: number | null;
  movementQtyPc: number | null;
  movementQtyKg: number | null;
  workOrderNo: string | null;
  bomItemKey: string | null;
}

export interface WorkOrderLedgerSummary {
  grossIssuedQty: number | null;
  matchedIssueCount: number;
  movementRecordIds: string[];
  error: WorkOrderLedgerError | null;
}

export interface WorkOrderMaterialLedgerResolution {
  summaries: Map<string, WorkOrderLedgerSummary>;
  attributedBomRecordIds: Map<string, string>;
}

interface LotBalance {
  pc: number;
  kg: number;
  pcSeen: boolean;
  kgSeen: boolean;
}

interface LotOwner {
  workOrderNo: string;
  bomItemKey: string;
  componentNo: string;
  bomRecordId: string | null;
  unit: WorkOrderLedgerUnit | null;
}

const ISSUE_TRANSFER_BASIS = '調-製令單領料';
const FORMAL_RETURN_BASES = new Set(['入-製令單退料', '入-託工單退料']);
const CONSUMPTION_BASES = new Set([
  '出-自動耗用',
  '出-耗工單耗用量',
  '出-製令單',
  '出-工單耗用',
  '出-製令單耗用量',
  '出-託工單耗用量',
]);

function identity(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function unit(value: unknown): WorkOrderLedgerUnit | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'pc' || normalized === 'kg' ? normalized : null;
}

function quantity(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrder(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function movementTime(value: Date | null): number {
  const timestamp = value?.getTime();
  return Number.isFinite(timestamp) ? timestamp! : 0;
}

function orderedMovements(
  movements: readonly WorkOrderLedgerMovement[],
): WorkOrderLedgerMovement[] {
  return [...movements].sort((left, right) => {
    const dateDiff = movementTime(left.movementDate) - movementTime(right.movementDate);
    if (dateDiff !== 0) return dateDiff;
    const idDiff = recordOrder(left.sourceRecordId) - recordOrder(right.sourceRecordId);
    return idDiff !== 0
      ? idDiff
      : left.sourceRecordId.localeCompare(right.sourceRecordId);
  });
}

function createSummary(): WorkOrderLedgerSummary {
  return {
    grossIssuedQty: 0,
    matchedIssueCount: 0,
    movementRecordIds: [],
    error: null,
  };
}

function allocationCandidates(
  allocations: readonly WorkOrderIssueAllocation[],
  movement: WorkOrderLedgerMovement,
): WorkOrderIssueAllocation[] {
  const movementWorkOrder = identity(movement.workOrderNo);
  const movementLot = identity(movement.inventoryLotNo);
  if (!movementWorkOrder || !movementLot) return [];

  let candidates = allocations.filter(
    (allocation) =>
      identity(allocation.workOrderNo) === movementWorkOrder
      && identity(allocation.inventoryLotNo) === movementLot,
  );

  const movementBomItemKey = identity(movement.bomItemKey);
  if (movementBomItemKey) {
    candidates = candidates.filter(
      (allocation) => identity(allocation.bomItemKey) === movementBomItemKey,
    );
  } else {
    const movementComponent = identity(movement.componentNo);
    if (movementComponent) {
      candidates = candidates.filter(
        (allocation) => identity(allocation.componentNo) === movementComponent,
      );
    }
  }

  return [...new Map(
    candidates.map((allocation) => [allocation.bomRecordId, allocation]),
  ).values()];
}

function ownerFromMovement(
  movement: WorkOrderLedgerMovement,
  allocation: WorkOrderIssueAllocation | null,
): LotOwner {
  return {
    workOrderNo: identity(movement.workOrderNo),
    bomItemKey: identity(movement.bomItemKey),
    componentNo: identity(movement.componentNo),
    bomRecordId: allocation?.bomRecordId ?? null,
    unit: unit(allocation?.unit ?? movement.inputUnit),
  };
}

function isIssueTransfer(movement: WorkOrderLedgerMovement): boolean {
  return identity(movement.movementType) === identity('TRANS調撥')
    && String(movement.basisType ?? '').trim() === ISSUE_TRANSFER_BASIS;
}

function isFormalReturn(movement: WorkOrderLedgerMovement): boolean {
  return identity(movement.movementType) === identity('IN入庫')
    && FORMAL_RETURN_BASES.has(String(movement.basisType ?? '').trim());
}

function isConsumption(movement: WorkOrderLedgerMovement): boolean {
  return identity(movement.movementType) === identity('OUT出庫')
    && CONSUMPTION_BASES.has(String(movement.basisType ?? '').trim());
}

function updateBalance(balance: LotBalance, movement: WorkOrderLedgerMovement): void {
  const pc = quantity(movement.movementQtyPc);
  if (pc !== null) {
    balance.pc += pc;
    balance.pcSeen = true;
    if (Math.abs(balance.pc) < 0.000001) balance.pc = 0;
  }

  const kg = quantity(movement.movementQtyKg);
  if (kg !== null) {
    balance.kg += kg;
    balance.kgSeen = true;
    if (Math.abs(balance.kg) < 0.000001) balance.kg = 0;
  }
}

export function resolveWorkOrderMaterialLedgers(input: {
  allocations: readonly WorkOrderIssueAllocation[];
  movements: readonly WorkOrderLedgerMovement[];
}): WorkOrderMaterialLedgerResolution {
  const summaries = new Map<string, WorkOrderLedgerSummary>();
  for (const allocation of input.allocations) {
    if (!summaries.has(allocation.bomRecordId)) {
      summaries.set(allocation.bomRecordId, createSummary());
    }
  }

  const attributedBomRecordIds = new Map<string, string>();
  const allocationsByLot = new Map<string, WorkOrderIssueAllocation[]>();
  for (const allocation of input.allocations) {
    const lot = identity(allocation.inventoryLotNo);
    if (!lot) continue;
    const rows = allocationsByLot.get(lot) ?? [];
    rows.push(allocation);
    allocationsByLot.set(lot, rows);
  }

  const movementsByLot = new Map<string, WorkOrderLedgerMovement[]>();
  for (const movement of input.movements) {
    const lot = identity(movement.inventoryLotNo);
    if (!lot || !allocationsByLot.has(lot)) continue;
    const rows = movementsByLot.get(lot) ?? [];
    rows.push(movement);
    movementsByLot.set(lot, rows);
  }

  const attribute = (movement: WorkOrderLedgerMovement, bomRecordId: string) => {
    attributedBomRecordIds.set(movement.sourceRecordId, bomRecordId);
    const summary = summaries.get(bomRecordId)!;
    if (!summary.movementRecordIds.includes(movement.sourceRecordId)) {
      summary.movementRecordIds.push(movement.sourceRecordId);
    }
  };

  const markAmbiguous = (candidates: readonly WorkOrderIssueAllocation[]) => {
    for (const candidate of candidates) {
      const summary = summaries.get(candidate.bomRecordId)!;
      summary.grossIssuedQty = null;
      summary.error = 'ledger_attribution_ambiguous';
    }
  };

  const markHandoffIncomplete = (bomRecordId: string | null) => {
    if (!bomRecordId) return;
    const summary = summaries.get(bomRecordId);
    if (!summary) return;
    summary.grossIssuedQty = null;
    summary.error = 'ledger_handoff_incomplete';
  };

  for (const [lot, allocations] of allocationsByLot) {
    const balance: LotBalance = {
      pc: 0,
      kg: 0,
      pcSeen: false,
      kgSeen: false,
    };
    let owner: LotOwner | null = null;
    let ownerReleased = false;

    for (const movement of orderedMovements(movementsByLot.get(lot) ?? [])) {
      const candidates = allocationCandidates(allocations, movement);
      const explicitAllocation = candidates.length === 1 ? candidates[0] : null;
      if (candidates.length > 1) markAmbiguous(candidates);

      if (isIssueTransfer(movement)) {
        const nextOwner = ownerFromMovement(movement, explicitAllocation);
        if (explicitAllocation) {
          const summary = summaries.get(explicitAllocation.bomRecordId)!;
          const allocationUnit = unit(explicitAllocation.unit);
          const balanceSeen = allocationUnit === 'pc' ? balance.pcSeen : balance.kgSeen;
          const issuedQty = allocationUnit === 'pc' ? balance.pc : balance.kg;
          const crossesWorkOrders = !!owner?.workOrderNo
            && !!nextOwner.workOrderNo
            && owner.workOrderNo !== nextOwner.workOrderNo;
          const handoffIncomplete = crossesWorkOrders
            && balanceSeen
            && issuedQty > 0.000001
            && !ownerReleased;
          if (handoffIncomplete) {
            markHandoffIncomplete(owner?.bomRecordId ?? null);
            markHandoffIncomplete(explicitAllocation.bomRecordId);
            summary.matchedIssueCount += 1;
          } else if (!allocationUnit || !balanceSeen || issuedQty < -0.000001) {
            summary.grossIssuedQty = null;
            summary.error = 'ledger_balance_missing';
          } else if (summary.error === null) {
            summary.grossIssuedQty = (summary.grossIssuedQty ?? 0) + Math.max(issuedQty, 0);
            summary.matchedIssueCount += 1;
          }
          attribute(movement, explicitAllocation.bomRecordId);
        }
        owner = nextOwner;
        ownerReleased = false;
      } else {
        const ownerAllocation = !movement.workOrderNo && owner?.bomRecordId
          ? allocations.find((allocation) => allocation.bomRecordId === owner!.bomRecordId) ?? null
          : null;
        const resolvedAllocation = explicitAllocation
          ?? ((isConsumption(movement) || isFormalReturn(movement)) ? ownerAllocation : null);
        if (resolvedAllocation) attribute(movement, resolvedAllocation.bomRecordId);
        if (isFormalReturn(movement) && owner) {
          const movementWorkOrder = identity(movement.workOrderNo);
          const belongsToOwner = !movementWorkOrder || movementWorkOrder === owner.workOrderNo;
          const ownerBalance = owner.unit === 'pc' ? balance.pc : balance.kg;
          const ownerBalanceSeen = owner.unit === 'pc' ? balance.pcSeen : balance.kgSeen;
          const returnedQty = owner.unit === 'pc'
            ? quantity(movement.movementQtyPc)
            : quantity(movement.movementQtyKg);
          if (
            belongsToOwner
            && ownerBalanceSeen
            && Math.abs(ownerBalance) <= 0.000001
            && returnedQty !== null
            && returnedQty > 0.000001
          ) {
            ownerReleased = true;
          }
        }
      }

      updateBalance(balance, movement);
    }
  }

  for (const summary of summaries.values()) {
    if (summary.matchedIssueCount === 0 && summary.error === null) {
      summary.grossIssuedQty = null;
      summary.error = 'ledger_issue_not_found';
    }
  }

  return { summaries, attributedBomRecordIds };
}
