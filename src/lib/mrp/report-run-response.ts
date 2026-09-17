import { NextResponse } from 'next/server';
import { MRP_RUN_STATUS } from './run-status';

export function getIncompleteReportRunResponse(status: string) {
  if (status === MRP_RUN_STATUS.COMPLETED) return null;
  return NextResponse.json({
    error: '此 MRP 版本尚未完成計算，無法檢視完整報表，請選擇已完成版本。',
    code: 'MRP_RUN_NOT_COMPLETED',
    runStatus: status,
  }, { status: 409 });
}
