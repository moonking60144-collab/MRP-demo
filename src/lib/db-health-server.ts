import prisma from './db';
import {
  findMissingDatabaseObjects,
  type DbColumnRow,
  type DbForeignKeyRow,
  type DbIndexRow,
  type DbTableRow,
} from './db-health';

export interface DatabaseHealthResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  invalidColumnNullability: string[];
  missingForeignKeys: string[];
  missing: string[];
  found: number;
  error?: string;
}

export class DatabasePreflightError extends Error {
  constructor(readonly health: DatabaseHealthResult) {
    super(
      health.error
        ? `資料庫檢查失敗：${health.error}`
        : `資料庫結構不完整，缺少 ${health.missing.length} 個必要項目。`,
    );
    this.name = 'DatabasePreflightError';
  }
}

export async function checkDatabaseHealth(): Promise<DatabaseHealthResult> {
  try {
    const [tableRows, columnRows, indexRows, foreignKeyRows] = await Promise.all([
      prisma.$queryRaw<DbTableRow[]>`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema IN ('public', 'staging', 'mrp_out')
          AND table_type = 'BASE TABLE'
      `,
      prisma.$queryRaw<DbColumnRow[]>`
        SELECT table_schema, table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema IN ('public', 'staging', 'mrp_out')
      `,
      prisma.$queryRaw<DbIndexRow[]>`
        SELECT schemaname AS table_schema,
               tablename AS table_name,
               indexname AS index_name
        FROM pg_indexes
        WHERE schemaname IN ('public', 'staging', 'mrp_out')
      `,
      prisma.$queryRaw<DbForeignKeyRow[]>`
        SELECT constraints.table_schema,
               constraints.table_name,
               columns.column_name,
               foreign_columns.table_schema AS foreign_table_schema,
               foreign_columns.table_name AS foreign_table_name,
               foreign_columns.column_name AS foreign_column_name,
               referential.delete_rule
        FROM information_schema.table_constraints AS constraints
        JOIN information_schema.key_column_usage AS columns
          ON columns.constraint_schema = constraints.constraint_schema
         AND columns.constraint_name = constraints.constraint_name
        JOIN information_schema.referential_constraints AS referential
          ON referential.constraint_schema = constraints.constraint_schema
         AND referential.constraint_name = constraints.constraint_name
        JOIN information_schema.constraint_column_usage AS foreign_columns
          ON foreign_columns.constraint_schema = referential.unique_constraint_schema
         AND foreign_columns.constraint_name = referential.unique_constraint_name
        WHERE constraints.constraint_type = 'FOREIGN KEY'
          AND constraints.table_schema IN ('public', 'staging', 'mrp_out')
      `,
    ]);
    const result = findMissingDatabaseObjects(
      tableRows,
      columnRows,
      indexRows,
      foreignKeyRows,
    );

    return {
      ok: result.missing.length === 0,
      ...result,
      found: tableRows.length,
    };
  } catch (error) {
    return {
      ok: false,
      missingTables: [],
      missingColumns: [],
      missingIndexes: [],
      invalidColumnNullability: [],
      missingForeignKeys: [],
      missing: [],
      found: 0,
      error: error instanceof Error ? error.message : 'Cannot query database',
    };
  }
}

export async function requireDatabasePreflight(): Promise<DatabaseHealthResult> {
  const health = await checkDatabaseHealth();
  if (!health.ok) throw new DatabasePreflightError(health);
  return health;
}
