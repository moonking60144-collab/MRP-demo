/**
 * 把轉單後端/網路錯誤轉成非工程師看得懂的訊息。
 * 已是中文且可讀的既有訊息（如「此規劃已轉單」）原樣保留；
 * 只重寫技術性字樣（Source API 原文、HTTP 碼、fetch 失敗）。未知錯誤保留原文，不吞資訊。
 */
export function friendlyTransferError(raw: string | null | undefined): string {
  const msg = (raw || '').trim();
  if (!msg) return '轉單失敗（原因不明），請稍後重試。';
  if (/結果待確認|可能已建單|鎖定重試|正在轉單/.test(msg)) return msg;
  if (msg.includes('已轉單')) return '此規劃已轉單，請勿重複轉。';
  if (msg.includes('找不到規劃建議')) return '找不到規劃建議，請先儲存規劃再轉單。';
  if (/502|Source API/i.test(msg)) return 'Source 系統忙線或回應失敗，請稍後重試。';
  if (/HTTP 5\d\d|\b50[0-9]\b/.test(msg)) return '伺服器錯誤，請稍後重試。';
  if (/failed to fetch|networkerror|load failed|網路/i.test(msg)) return '網路連線異常，請檢查網路後重試。';
  return msg;
}
