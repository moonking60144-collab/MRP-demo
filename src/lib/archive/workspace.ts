import { Prisma, PrismaClient } from '.prisma/archive-client';
import { randomUUID } from 'node:crypto';

export type ArchiveWorkspaceKind = 'automatic-staging' | 'backup-verification';
const targets = {
  'automatic-staging': { database: 'funda_mrp_archive_auto_tmp', key: 'ARCHIVE_AUTO_RESTORE_DATABASE_URL', schemas: ['public', 'staging', 'mrp_out', 'archive_restore'] },
  'backup-verification': { database: 'funda_mrp_archive_verify_tmp', key: 'ARCHIVE_VERIFY_DATABASE_URL', schemas: ['public', 'archive_meta', 'archive_data'] },
} as const;
const WORKSPACE_LOCK = 74928317;
const active = new WeakSet<LockedArchiveWorkspace>();
export interface LockedArchiveWorkspace { kind: ArchiveWorkspaceKind; client: PrismaClient; url: string; operationId: string }

export function workspaceConnectionUrl(kind: ArchiveWorkspaceKind, env = process.env) {
  const target = targets[kind];
  let url: URL;
  try { url = new URL(env[target.key]!); } catch { throw new Error(`${target.key} is not configured or invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== `/${target.database}` ||
      decodeURIComponent(url.username) !== 'archive_loader') throw new Error('Archive workspace URL target is not allowed');
  url.searchParams.set('connection_limit', '1');
  // A session advisory lock must survive long work performed on another connection.
  url.searchParams.set('max_idle_connection_lifetime', '0');
  url.searchParams.set('max_connection_lifetime', '0');
  return url.toString();
}

async function assertIdentity(client: Prisma.TransactionClient, kind: ArchiveWorkspaceKind) {
  const [identity] = await client.$queryRaw<Array<{ database: string; role: string }>>`
    SELECT current_database() AS database, current_user AS role
  `;
  if (identity?.database !== targets[kind].database || identity.role !== 'archive_loader') {
    throw new Error('Archive workspace actual identity is not allowed');
  }
  const markers = await client.$queryRaw<Array<{ database: string; purpose: string; version: number; mutable: boolean }>>`
    SELECT database_name AS database, purpose, contract_version AS version,
      (has_table_privilege(current_user, 'archive_workspace.identity', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_schema_privilege(current_user, 'archive_workspace', 'CREATE')
        OR (SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          FROM pg_class WHERE oid = 'archive_workspace.identity'::regclass)) AS mutable
    FROM archive_workspace.identity
  `;
  if (markers.length !== 1 || markers[0].database !== identity.database || markers[0].purpose !== kind ||
      markers[0].version !== 1 || markers[0].mutable) throw new Error('Archive workspace marker or permissions are invalid');
}

export async function assertLockedWorkspace(workspace: LockedArchiveWorkspace) {
  return assertWorkspaceTransaction(workspace, workspace.client);
}

export async function assertWorkspaceTransaction(workspace: LockedArchiveWorkspace, client: Prisma.TransactionClient) {
  if (!active.has(workspace)) throw new Error('Archive workspace lease is not active');
  await assertIdentity(client, workspace.kind);
  const [lock] = await client.$queryRaw<Array<{ held: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
      AND classid = 0 AND objid = ${WORKSPACE_LOCK}::oid AND objsubid = 1 AND granted) AS held
  `;
  if (!lock.held) throw new Error('Archive workspace lock was lost');
  const [operation] = await client.$queryRaw<Array<{ valid: boolean }>>`
    SELECT active AND operation_id = ${workspace.operationId} AS valid FROM archive_workspace.operation WHERE id = 1
  `;
  if (!operation?.valid) throw new Error('Archive workspace operation ownership was lost');
}

export async function withArchiveWorkspace<T>(kind: ArchiveWorkspaceKind, action: (workspace: LockedArchiveWorkspace) => Promise<T>) {
  const url = workspaceConnectionUrl(kind);
  const client = new PrismaClient({ datasourceUrl: url });
  const workspace = Object.freeze({ kind, client, url, operationId: randomUUID() });
  let locked = false;
  let claimed = false;
  try {
    await assertIdentity(client, kind);
    const [lock] = await client.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(${WORKSPACE_LOCK}) AS acquired`;
    if (!lock.acquired) throw new Error('Archive workspace is busy');
    locked = true;
    const claim = await client.$executeRaw`
      UPDATE archive_workspace.operation SET active = true, operation_id = ${workspace.operationId}, started_at = now()
      WHERE id = 1 AND active = false
    `;
    if (claim !== 1) throw new Error('Archive workspace has an unresolved previous operation; inspect before recovery');
    claimed = true;
    active.add(workspace);
    await assertLockedWorkspace(workspace);
    return await action(workspace);
  } finally {
    if (claimed) {
      try {
        await assertLockedWorkspace(workspace);
        await client.$transaction(async tx => {
          await assertWorkspaceTransaction(workspace, tx);
          await tx.$executeRaw`UPDATE archive_workspace.operation SET active = false WHERE id = 1 AND operation_id = ${workspace.operationId}`;
        });
      } catch { /* An unknown owner/child outcome must remain blocked, not silently reset on restart. */ }
    }
    active.delete(workspace);
    if (locked) await client.$queryRaw`SELECT pg_advisory_unlock(${WORKSPACE_LOCK})`.catch(() => undefined);
    await client.$disconnect();
  }
}

export async function resetArchiveWorkspace(workspace: LockedArchiveWorkspace) {
  await assertLockedWorkspace(workspace);
  await workspace.client.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await assertWorkspaceTransaction(workspace, tx);
    const schemas = await tx.$queryRaw<Array<{ name: string; owned: boolean }>>`
      SELECT nspname AS name, nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned
      FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'archive_workspace')
    `;
    const allowed: readonly string[] = targets[workspace.kind].schemas;
    if (schemas.some(schema => !allowed.includes(schema.name) || !schema.owned)) {
      throw new Error('Archive workspace contains unknown or foreign-owned schemas');
    }
    const protectedConstraints = await tx.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace = 'archive_workspace'::regnamespace ORDER BY conname
    `;
    for (const schema of schemas) await tx.$executeRawUnsafe(`DROP SCHEMA "${schema.name}" CASCADE`);
    await tx.$executeRawUnsafe('CREATE SCHEMA public');
    await tx.$executeRawUnsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    // Cross-schema dependencies must not silently remove or alter the protected marker.
    await assertWorkspaceTransaction(workspace, tx);
    const constraintsAfter = await tx.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace = 'archive_workspace'::regnamespace ORDER BY conname
    `;
    if (JSON.stringify(constraintsAfter) !== JSON.stringify(protectedConstraints)) {
      throw new Error('Reset would modify protected workspace constraints');
    }
  }, { timeout: 60_000 });
}
