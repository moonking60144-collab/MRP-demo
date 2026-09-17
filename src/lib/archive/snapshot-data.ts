import { createHash } from 'node:crypto';
import type { Prisma } from '.prisma/archive-client';
import definitions from './schema-generations.json';
import { ARCHIVE_RUN_TABLES } from './coverage';
import type { ArchiveSchemaGeneration } from './seed-manifest';

export type ArchiveRunTable = typeof ARCHIVE_RUN_TABLES[number];
export interface SourceColumn { name: string; type: string; notNull: boolean }
export interface SnapshotDigest { rows: string; digest: string }
export type RunFingerprints = Record<string, Record<ArchiveRunTable, SnapshotDigest | null>>;
const schemas = definitions as Record<ArchiveSchemaGeneration, Record<ArchiveRunTable, SourceColumn[] | null>>;

export const RESTORE_LOCK = 74928316;
export const ARCHIVE_IMPORT_VERSION = 'archive-import-v1';

export function columnsFor(generation: ArchiveSchemaGeneration, table: ArchiveRunTable) {
  return schemas[generation][table];
}

export function quotedTable(table: ArchiveRunTable, destination = false) {
  if (!ARCHIVE_RUN_TABLES.includes(table)) throw new Error('Unknown Archive snapshot table');
  const [schema, name] = table.split('.');
  return destination ? `"archive_data"."${schema}_${name}"` : `"${schema}"."${name}"`;
}

export function missingColumns(generation: ArchiveSchemaGeneration, table: ArchiveRunTable) {
  const available = new Set(columnsFor(generation, table)?.map(column => column.name));
  return columnsFor('G4', table)!.filter(column => !available.has(column.name)).map(column => column.name);
}

export async function assertSourceSchema(client: Prisma.TransactionClient, generation: ArchiveSchemaGeneration) {
  const rows = await client.$queryRaw<Array<SourceColumn & { table: string }>>`
    SELECT n.nspname || '.' || c.relname AS "table", a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull"
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'staging', 'mrp_out') AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
  `;
  const sort = (columns: SourceColumn[]) => columns.map(({ name, type, notNull }) => ({ name, type, notNull }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const table of ARCHIVE_RUN_TABLES) {
    const actual = sort(rows.filter(row => row.table === table));
    const expected = sort(columnsFor(generation, table) ?? []);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Archive source schema mismatch: ${table}`);
  }
  return createHash('sha256').update(JSON.stringify(ARCHIVE_RUN_TABLES.map(table => ({
    table, columns: sort(columnsFor(generation, table) ?? []),
  })))).digest('hex');
}

export async function streamSnapshot(
  client: Prisma.TransactionClient,
  table: ArchiveRunTable,
  generation: ArchiveSchemaGeneration,
  identity: { sourceRunId: number } | { archiveRunId: string },
  onBatch?: (rows: string[]) => Promise<void>,
): Promise<SnapshotDigest> {
  const destination = 'archiveRunId' in identity;
  const relation = quotedTable(table, destination);
  const key = destination ? 'archive_run_id' : table === 'public.mrp_run' ? 'id' : 'mrp_run_id';
  const value = destination ? identity.archiveRunId : identity.sourceRunId;
  const parameter = destination ? '$1::uuid' : '$1::integer';
  const additions = Object.fromEntries(missingColumns(generation, table).map(name => [name,
    table === 'public.mrp_run' && name === 'order_demand_contract_version' ? 'order-demand-v1' : null,
  ]));
  const projection = destination ? "(to_jsonb(t) - 'archive_run_id')::text" : '(to_jsonb(t) || $3::jsonb)::text';
  const [count] = await client.$queryRawUnsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count FROM ${relation} WHERE "${key}" = ${parameter}`, value,
  );
  const digest = createHash('sha256');
  let cursor: number | null = null;
  let total = BigInt(0);
  while (true) {
    const args: Array<string | number | null> = destination ? [value, cursor] : [value, cursor, JSON.stringify(additions)];
    const rows: Array<{ id: number; payload: string }> = await client.$queryRawUnsafe<Array<{ id: number; payload: string }>>(
      `SELECT id, ${projection} AS payload FROM ${relation} t
       WHERE "${key}" = ${parameter} AND ($2::integer IS NULL OR id > $2) ORDER BY id LIMIT 500`, ...args,
    );
    if (!rows.length) break;
    for (const row of rows) {
      if (cursor !== null && row.id <= cursor) throw new Error(`Duplicate or unordered source row: ${table}`);
      cursor = row.id;
      digest.update(row.payload).update('\n');
      total += BigInt(1);
    }
    if (onBatch) await onBatch(rows.map(row => row.payload));
  }
  if (total.toString() !== count.count) throw new Error(`Snapshot row count changed: ${table}`);
  return { rows: total.toString(), digest: digest.digest('hex') };
}

export async function insertSnapshotBatch(
  client: Prisma.TransactionClient, table: ArchiveRunTable, archiveRunId: string, payloads: string[],
) {
  const target = quotedTable(table, true);
  const columns = columnsFor('G4', table)!.map(column => `"${column.name}"`).join(', ');
  // JSON stays as PostgreSQL text end-to-end, preserving NUMERIC precision and timestamp fractions.
  await client.$executeRawUnsafe(
    `INSERT INTO ${target} (archive_run_id, ${columns})
     SELECT $1::uuid, ${columns} FROM jsonb_populate_recordset(NULL::${target}, $2::jsonb)`,
    archiveRunId, `[${payloads.join(',')}]`,
  );
}
