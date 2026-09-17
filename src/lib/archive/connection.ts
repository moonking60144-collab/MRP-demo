export type ArchiveConnectionRole = 'reader' | 'loader' | 'restore';

const targets = {
  reader: { key: 'ARCHIVE_DATABASE_URL', database: 'funda_mrp_archive', user: 'archive_reader' },
  loader: { key: 'ARCHIVE_LOADER_DATABASE_URL', database: 'funda_mrp_archive', user: 'archive_loader' },
  restore: { key: 'ARCHIVE_RESTORE_DATABASE_URL', database: 'funda_mrp_restore_tmp', user: 'archive_loader' },
} as const;

export function archiveConnectionUrl(
  role: ArchiveConnectionRole,
  env: Record<string, string | undefined> = process.env,
): string {
  const target = targets[role];
  const raw = env[target.key];
  if (!raw) throw new Error(`${target.key} is not configured`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${target.key} is invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname !== `/${target.database}` || decodeURIComponent(url.username) !== target.user) {
    throw new Error(`${target.key} must use ${target.user} on ${target.database}`);
  }
  return raw;
}
