'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import packageJson from '../../package.json';

const APP_VERSION = packageJson.version;

const MODE_LABELS: Record<string, string> = {
  local: '本機',
  docker: 'Docker',
  remote: '遠端',
};

export function DbStatusBadge() {
  const [mode, setMode] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [dbVersion, setDbVersion] = useState('');
  const [schemaOk, setSchemaOk] = useState(true);
  const [missingCount, setMissingCount] = useState(0);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setMode(d.dbMode);
        setConnected(d.connection?.connected ?? false);
        const full = d.connection?.dbVersion || '';
        const match = full.match(/PostgreSQL [\d.]+/);
        setDbVersion(match ? match[0] : '');
      })
      .catch(() => {});

    fetch('/api/db-health')
      .then((r) => r.json())
      .then((h) => {
        setSchemaOk(h.ok ?? true);
        setMissingCount(h.missing?.length ?? 0);
      })
      .catch(() => {});
  }, []);

  if (!mode) return null;

  const dotColor = !connected
    ? 'bg-red-500'
    : !schemaOk
      ? 'bg-amber-500'
      : 'bg-green-500';

  return (
    <Link href="/settings" className="block mt-1.5 group">
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[10px] text-slate-400 group-hover:text-slate-600 transition-colors">
          DB: {MODE_LABELS[mode] || mode}
        </span>
      </span>
      {dbVersion && (
        <span className="text-[9px] text-slate-300 ml-3 block">
          {dbVersion}
        </span>
      )}
      {!schemaOk && (
        <span className="text-[9px] text-amber-500 ml-3 block" title={`${missingCount} database object(s) missing`}>
          {missingCount} 個資料庫結構異常
        </span>
      )}
      <span className="text-[9px] text-slate-300 ml-3 block">
        App v{APP_VERSION}
      </span>
    </Link>
  );
}
