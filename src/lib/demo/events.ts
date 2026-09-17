import { EventEmitter } from 'node:events';
import { latestRun, state } from './store';

const root = globalThis as typeof globalThis & { demoEvents?: EventEmitter };
export const events = root.demoEvents ??= new EventEmitter();
events.setMaxListeners(100);
export function demoStream(request: Request, channel: 'runs' | 'plans'): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval>;
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); events.off(channel, send); request.signal.removeEventListener('abort', close); try { controller.close(); } catch {} };
      const send = (value: unknown) => { if (!closed) try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { close(); } };
      unsubscribe = close;
      events.on(channel, send);
      const run = latestRun();
      send(channel === 'runs' ? { type: 'sync', latestRunId: run.id, versionCode: run.versionCode, autoFollow: state().autoFollow } : { type: 'sync', statuses: state().transfers.map((item) => ({ ...item, transferId: item.id })) });
      heartbeat = setInterval(() => { if (!closed) try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { close(); } }, 15000);
      request.signal.addEventListener('abort', close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() { unsubscribe(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-MRP-Data': 'synthetic' } });
}
