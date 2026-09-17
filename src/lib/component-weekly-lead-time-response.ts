interface PurchaseLeadTimeResponse {
  updated: boolean;
  purchaseLeadWeeks: number;
  purchaseLeadWeeksConfigured: boolean;
}

export async function readPurchaseLeadTimeResponse(response: Response): Promise<PurchaseLeadTimeResponse> {
  const unknownOutcome = `前置期更新結果無法確認（HTTP ${response.status}）；請先開啟 Source 原單核對，確認前不要重送。`;
  let result: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(unknownOutcome);
    result = parsed as Record<string, unknown>;
  } catch {
    throw new Error(unknownOutcome);
  }
  if (!response.ok) {
    const currentValue = result.currentConfigured === false
      ? '未設定'
      : typeof result.currentPurchaseLeadWeeks === 'number'
        ? `${result.currentPurchaseLeadWeeks} 週`
        : null;
    throw new Error(
      `${typeof result.error === 'string' ? result.error : unknownOutcome}${currentValue ? `；Source 目前為「${currentValue}」` : ''}`,
    );
  }
  if (
    typeof result.updated !== 'boolean'
    || typeof result.purchaseLeadWeeksConfigured !== 'boolean'
    || typeof result.purchaseLeadWeeks !== 'number'
    || !Number.isInteger(result.purchaseLeadWeeks)
    || result.purchaseLeadWeeks < 0
    || result.purchaseLeadWeeks > 260
  ) throw new Error(unknownOutcome);
  return {
    updated: result.updated,
    purchaseLeadWeeks: result.purchaseLeadWeeks,
    purchaseLeadWeeksConfigured: result.purchaseLeadWeeksConfigured,
  };
}
