import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertDemoPostgresWebTarget, PURPOSE_KEY, TEST_USER, WEB_DATABASE, WEB_PURPOSE } from './target';
import { assertPostgresWebIdentity } from './web';

export async function preparePostgresWebDatabase(value: string | undefined) {
  const url = assertDemoPostgresWebTarget(value);
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const [identity] = await client.$queryRaw<{ database: string; user: string; owner: string }[]>`SELECT current_database() AS database, current_user AS "user", pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`;
    assert.equal(identity.database, WEB_DATABASE); assert.equal(identity.user, TEST_USER); assert.equal(identity.owner, TEST_USER);
    const tables = await client.$queryRaw<{ schemaname: string; tablename: string }[]>`SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`;
    if (!tables.length) {
      const cli = join(process.cwd(), 'node_modules/prisma/build/index.js');
      const sql = execFileSync(process.execPath, [cli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const directory = mkdtempSync(join(tmpdir(), 'mrp-demo-web-ddl-'));
      try {
        const file = join(directory, 'initialize.sql');
        writeFileSync(file, `BEGIN;
SELECT pg_advisory_xact_lock(87263849);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) THEN RAISE EXCEPTION 'Database is no longer empty'; END IF; END $$;
${sql}
INSERT INTO public.app_settings (key, value, updated_at) VALUES ('${PURPOSE_KEY}', '"${WEB_PURPOSE}"'::jsonb, CURRENT_TIMESTAMP);
COMMIT;`);
        execFileSync(process.execPath, [cli, 'db', 'execute', '--url', url.toString(), '--file', file], { encoding: 'utf8', stdio: 'pipe' });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    } else assert.ok(tables.some(row => row.schemaname === 'public' && row.tablename === 'app_settings'), 'POSTGRES_WEB_PURPOSE_REQUIRED');
    const verified = await assertPostgresWebIdentity(client);
    console.log(JSON.stringify({ storage: 'postgresql', database: verified.database, user: verified.user, postgres: verified.version }));
  } finally { await client.$disconnect(); }
}
