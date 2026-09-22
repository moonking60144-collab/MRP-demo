export interface TransferReconciliationCandidate {
  sourceRecordId: string;
  sourcePlanNo: string | null;
  suggestedQty: number;
  completionDate: string;
  createdAt: string | null;
  mrpSourceCode: string | null;
  sourceUrl: string;
}
