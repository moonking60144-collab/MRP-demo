import type { MrpColumnDef } from '../types';

export const RUN_HISTORY_COLUMNS: MrpColumnDef[] = [
  { id: 'versionCode', header: '版本', filterType: 'text', mono: true },
  { id: 'status', header: '狀態', filterType: 'enum', enumValues: ['completed', 'syncing', 'calculating', 'synced', 'pending', 'error', 'stopped'] },
  { id: 'createdBy', header: '建立者', filterType: 'text' },
  { id: 'createdAt', header: '開始時間', filterType: 'date' },
  { id: 'completedAt', header: '完成時間', filterType: 'date' },
  { id: 'duration', header: '耗時', filterType: 'numeric', align: 'right', mono: true },
  { id: 'syncCounts', header: '同步筆數', sortable: false },
];
