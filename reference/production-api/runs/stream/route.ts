import {
  onRunCompleted,
  onRunRetentionCompleted,
} from '@/lib/mrp/run-events';
import { getLatestRun } from '@/lib/mrp/run-orchestrator';
import { getAutoFollowLatestRun } from '@/lib/app-settings';
import { ensureRunLifecycle } from '@/lib/shutdown-handler';

// SSE 端點：不可被靜態快取，必須每次建立串流。
export const dynamic = 'force-dynamic';

/**
 * GET /api/runs/stream — Server-Sent Events。
 * 連上先推一次目前 latest（讓剛連上/重連的 client 補課對齊），之後 run 跑完即推。
 * 反代 buffering 用 X-Accel-Buffering: no 關閉（nginx 會尊重此 header），免改 nginx conf。
 */
export async function GET(req: Request) {
  await ensureRunLifecycle();
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const unsubscribers: Array<() => void> = [];
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          cleanup(); // controller 已關（client 斷線）
        }
      };

      // 連上立刻推目前 latest + 設定 → client 對齊（含重連補課）
      try {
        const [latest, autoFollow] = await Promise.all([getLatestRun(), getAutoFollowLatestRun()]);
        send({ type: 'sync', latestRunId: latest?.id ?? null, versionCode: latest?.versionCode ?? null, autoFollow });
      } catch {
        // 初次同步失敗不致命，後續事件仍會推
      }

      unsubscribers.push(onRunCompleted(async (payload) => {
        let autoFollow = true;
        try { autoFollow = await getAutoFollowLatestRun(); } catch { /* 預設開 */ }
        send({ type: 'run-completed', latestRunId: payload.latestRunId, versionCode: payload.versionCode, autoFollow });
      }));

      unsubscribers.push(onRunRetentionCompleted(async ({ result }) => {
        try {
          const latest = await getLatestRun();
          send({
            type: 'run-retention-completed',
            latestRunId: latest?.id ?? null,
            versionCode: latest?.versionCode ?? null,
            deletedRunIds: result.deletedIds,
          });
        } catch {
          send({
            type: 'run-retention-completed',
            latestRunId: null,
            versionCode: null,
            deletedRunIds: result.deletedIds,
          });
        }
      }));

      // 心跳保活，穿過反代/瀏覽器的 idle timeout（註解行不觸發 onmessage）
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ka\n\n')); } catch { cleanup(); }
      }, 25000);
    },
    cancel() {
      cleanup();
    },
  });

  // client 斷線 → abort → 清理 listener/heartbeat，避免 emitter listener 洩漏
  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
