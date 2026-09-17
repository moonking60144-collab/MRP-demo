import type { PrismaClient } from '.prisma/archive-client';

type ArchiveReader = PrismaClient;

export async function openArchiveReader(): Promise<ArchiveReader> {
  throw new Error('展示環境只使用合成封存資料，不連接 Archive PostgreSQL。');
}

export function withSharedArchiveReader<T>(callback: (client: ArchiveReader) => Promise<T>) {
  void callback;
  return Promise.reject<T>(new Error('展示環境只使用合成封存資料。'));
}
