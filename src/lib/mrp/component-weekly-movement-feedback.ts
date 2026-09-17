export type ComponentWeeklyMovementInventoryFeedbackState =
  | 'in_stock'
  | 'unavailable'
  | 'reissued'
  | 'not_in_stock'
  | 'unknown';

export interface ComponentWeeklyMovementFeedbackMovement {
  ragicRecordId: string;
  workOrderNo: string;
  inventoryLotNo: string | null;
  basisType: string | null;
  movementType: string | null;
}

export interface ComponentWeeklyMovementFeedbackInventoryLot {
  ragicRecordId: string;
  lotNo: string | null;
  warehouseCode: string | null;
  qualityStatus: string | null;
  stockStatus: string | null;
  stockPc: number;
  stockKg: number;
}

export interface ComponentWeeklyMovementInventoryFeedback {
  state: ComponentWeeklyMovementInventoryFeedbackState;
  currentQty: number;
  availableQty: number;
  inventoryLots: ComponentWeeklyMovementFeedbackInventoryLot[];
  subsequentIssueWorkOrderNos: string[];
}

function identity(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function quantity(
  row: ComponentWeeklyMovementFeedbackInventoryLot,
  unit: string | null,
): number {
  return String(unit ?? '').trim().toLowerCase() === 'kg'
    ? Number(row.stockKg) || 0
    : Number(row.stockPc) || 0;
}

function isAvailable(row: ComponentWeeklyMovementFeedbackInventoryLot): boolean {
  return String(row.stockStatus ?? '').trim() === '在庫'
    && String(row.qualityStatus ?? '').trim() === '正常';
}

function isFormalReturn(row: ComponentWeeklyMovementFeedbackMovement): boolean {
  const basis = String(row.basisType ?? '').trim();
  return String(row.movementType ?? '').trim().toUpperCase() === 'IN入庫'.toUpperCase()
    && (basis === '入-製令單退料' || basis === '入-託工單退料');
}

function isIssueTransfer(row: ComponentWeeklyMovementFeedbackMovement): boolean {
  return String(row.movementType ?? '').trim().toUpperCase() === 'TRANS調撥'.toUpperCase()
    && String(row.basisType ?? '').trim() === '調-製令單領料';
}

export function resolveComponentWeeklyMovementInventoryFeedback(input: {
  movement: ComponentWeeklyMovementFeedbackMovement;
  movementIndex: number;
  movements: ComponentWeeklyMovementFeedbackMovement[];
  inventoryLots: ComponentWeeklyMovementFeedbackInventoryLot[];
  unit: string | null;
}): ComponentWeeklyMovementInventoryFeedback {
  const lotNo = identity(input.movement.inventoryLotNo);
  if (!lotNo) {
    return {
      state: 'unknown',
      currentQty: 0,
      availableQty: 0,
      inventoryLots: [],
      subsequentIssueWorkOrderNos: [],
    };
  }

  const inventoryLots = input.inventoryLots.filter((row) => identity(row.lotNo) === lotNo);
  const currentQty = inventoryLots.reduce((total, row) => total + quantity(row, input.unit), 0);
  const availableQty = inventoryLots.reduce(
    (total, row) => total + (isAvailable(row) ? quantity(row, input.unit) : 0),
    0,
  );
  const subsequentIssueWorkOrderNos = isFormalReturn(input.movement)
    ? [...new Set(
        input.movements
          .slice(input.movementIndex + 1)
          .filter((row) => identity(row.inventoryLotNo) === lotNo && isIssueTransfer(row))
          .map((row) => row.workOrderNo.trim())
          .filter(Boolean),
      )]
    : [];

  return {
    state: availableQty > 0
      ? 'in_stock'
      : currentQty > 0
        ? 'unavailable'
        : subsequentIssueWorkOrderNos.length > 0
          ? 'reissued'
          : 'not_in_stock',
    currentQty,
    availableQty,
    inventoryLots,
    subsequentIssueWorkOrderNos,
  };
}
