import type { RunLogEntry } from './run-logger';

export interface SequencedRunLogEntry extends RunLogEntry {
  seq: number;
}
export interface RunLogDelta {
  logs: SequencedRunLogEntry[];
  nextSeq: number;
  reset: boolean;
}

export function normalizeRunLogs(value: unknown): SequencedRunLogEntry[] {
  if (!Array.isArray(value)) return [];

  let lastSeq = 0;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<SequencedRunLogEntry>;
    if (
      typeof candidate.ts !== 'number' ||
      (candidate.level !== 'info' && candidate.level !== 'warn' && candidate.level !== 'error') ||
      typeof candidate.msg !== 'string'
    ) {
      return [];
    }

    const candidateSeq = Number(candidate.seq);
    const seq = Number.isInteger(candidateSeq) && candidateSeq > lastSeq
      ? candidateSeq
      : lastSeq + 1;
    lastSeq = seq;
    return [{
      ts: candidate.ts,
      level: candidate.level,
      msg: candidate.msg,
      seq,
    }];
  });
}

export function selectRunLogDelta(value: unknown, afterSeq: number): RunLogDelta {
  const logs = normalizeRunLogs(value);
  const normalizedAfterSeq = Number.isInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
  const firstSeq = logs[0]?.seq ?? 0;
  const nextSeq = logs.at(-1)?.seq ?? 0;
  const reset = normalizedAfterSeq > 0 && (
    logs.length === 0 ||
    normalizedAfterSeq > nextSeq ||
    firstSeq > normalizedAfterSeq + 1
  );

  return {
    logs: reset || normalizedAfterSeq === 0
      ? logs
      : logs.filter((entry) => entry.seq > normalizedAfterSeq),
    nextSeq,
    reset,
  };
}
