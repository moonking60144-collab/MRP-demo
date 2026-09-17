import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function inspectDumpRuns(dumpPath: string) {
  const child = spawn(process.env.ARCHIVE_PG_RESTORE_PATH || 'pg_restore', [
    '--data-only', '--table=mrp_run', '--file=-', dumpPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise<{ code: number | null; error?: Error }>(resolve => {
    child.once('error', error => resolve({ code: null, error }));
    child.once('close', code => resolve({ code }));
  });
  // Drain stderr without logging source paths or raw dump data.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let header: string[] | null = null;
  let ended = false;
  const runIds: number[] = [];
  const completedRunIds: number[] = [];
  try {
    for await (const line of lines) {
      const match = /^COPY public\.mrp_run \((.+)\) FROM stdin;$/.exec(line);
      if (match) {
        if (header) throw new Error('Duplicate mrp_run COPY section in seed');
        header = match[1].split(',').map(name => name.trim());
        if (!header.includes('id')) throw new Error('Seed mrp_run is missing its id column');
        continue;
      }
      if (!header || ended) continue;
      if (line === '\\.') { ended = true; continue; }
      const fields = line.split('\t');
      const id = fields[header.indexOf('id')];
      if (fields.length !== header.length || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
        throw new Error('Invalid mrp_run COPY row in seed');
      }
      runIds.push(Number(id));
      if (header.includes('status') && fields[header.indexOf('status')] === 'completed') completedRunIds.push(Number(id));
    }
    const result = await completion;
    if (result.error || result.code !== 0) throw new Error('pg_restore could not read seed mrp_run data');
    if (!header || !ended || runIds.length === 0 || new Set(runIds).size !== runIds.length) {
      throw new Error('Seed mrp_run inventory is incomplete');
    }
    return {
      runIds: runIds.sort((a, b) => a - b),
      completedRunIds: completedRunIds.sort((a, b) => a - b),
      hasStatus: header.includes('status'),
      hasOrderDemandContract: header.includes('order_demand_contract_version'),
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await completion;
  }
}
