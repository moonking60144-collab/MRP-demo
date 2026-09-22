export interface StorageStatus {
  demo?: boolean;
  measuredAt: string;
  databaseMode: string;
  database: { name: string; bytes: number } | null;
  archive: { name: string; bytes: number; verifiedRuns: number } | null;
  files: { label: string; bytes: number | null; files: number | null }[];
  volumes: { label: string; totalBytes: number; freeBytes: number; warning: boolean; critical: boolean }[];
  warnings: string[];
}
