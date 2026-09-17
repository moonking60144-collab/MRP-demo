'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  BadgeDollarSign,
  Boxes,
  ClipboardList,
  Database,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Menu,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
import { DbStatusBadge } from './db-status-badge';
import { useMrpVersion } from '@/lib/mrp-version-context';
import { useArchiveMode } from '@/lib/archive-mode-context';
import { usePersistedState } from './ui/use-persisted-state';

const NAV_ITEMS: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/', label: '儀表板', icon: LayoutDashboard },
  { href: '/fg-monthly', label: '成品月推移', icon: PackageOpen },
  { href: '/components', label: '元件週推移', icon: Boxes },
  { href: '/sales-meeting', label: '產銷會議表', icon: ClipboardList },
  { href: '/plan-management', label: '開單規劃', icon: FolderKanban },
  { href: '/production-plans', label: '相關生產計劃', icon: ListChecks },
  { href: '/outsource-price-change', label: '委外核價變動', icon: BadgeDollarSign },
  { href: '/source-data', label: '原始資料', icon: Database },
  { href: '/settings', label: '設定', icon: Settings },
];

export function Sidebar() {
  // `open`      — mobile drawer (< md). `collapsed` — desktop narrow rail (>= md).
  // collapsed effects are all md:-scoped so the mobile drawer always shows full content.
  const [open, setOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [collapsed, setCollapsed] = usePersistedState('mrp_sidebarCollapsed', false);
  const pathname = usePathname();
  const { run: archiveRun, restoring: archiveRestoring, error: archiveError } = useArchiveMode();
  const { selectedRunId, runs, setSelectedRunId, isLoading: versionLoading, selectionError, retrySelection, isLatestSelected } = useMrpVersion();

  useEffect(() => {
    setPendingHref(null);
    setOpen(false);
  }, [pathname]);

  const handleNav = (href: string) => {
    if (pathname !== href) setPendingHref(href);
    setOpen(false);
  };

  // Close drawer on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** md:-only hidden when collapsed (mobile drawer keeps showing it). */
  const hideOnCollapse = collapsed ? 'md:hidden' : '';

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-11 bg-white border-b border-slate-200 px-2 flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="grid h-11 w-11 place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          aria-label={open ? '關閉選單' : '開啟選單'}
        >
          {open ? <X size={19} strokeWidth={2} /> : <Menu size={19} strokeWidth={2} />}
        </button>
        <span className="text-sm font-bold text-slate-800">MRP Demo</span>
      </div>

      {/* Overlay (mobile only) */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/30"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={`
          fixed md:static z-50 top-0 left-0 h-full
          w-44 ${collapsed ? 'md:w-12' : 'md:w-44'}
          bg-slate-50 border-r border-slate-200 flex flex-col
          transition-all duration-200 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0
        `}
      >
        {/* Header — title + desktop collapse toggle */}
        <div className="flex min-h-[74px] items-start justify-between gap-1 border-b border-slate-200 bg-white px-3 py-3">
          <div className={hideOnCollapse}>
            <h1 className="text-base font-bold text-slate-800">MRP Demo</h1>
            <p className="text-[10px] text-slate-400 mt-0.5">物料需求規劃</p>
            <DbStatusBadge />
          </div>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden md:grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title={collapsed ? '展開側欄' : '收合側欄'}
            aria-label={collapsed ? '展開側欄' : '收合側欄'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 md:hidden"
            aria-label="關閉選單"
          >
            <X size={19} strokeWidth={2} />
          </button>
        </div>

        {/* Global MRP version selector */}
        <div className={`border-b border-slate-200 bg-white px-2 py-2 ${hideOnCollapse}`}>
          {archiveRun ? <div className="space-y-1 text-[11px] text-amber-800"><p className="font-semibold">歷史唯讀・Run {archiveRun.sourceRunId}</p><p className="break-all">{archiveRun.versionCode}</p><p>{archiveRun.runDate}</p></div> : <>
          <label className="block text-[10px] text-slate-400 mb-1">MRP 版本</label>
          <select
            value={selectedRunId ?? ''}
            onChange={(e) => setSelectedRunId(parseInt(e.target.value, 10))}
            disabled={(versionLoading && !selectionError) || runs.length === 0 || archiveRestoring || Boolean(archiveError)}
            className={`w-full px-1.5 py-1 text-[11px] border rounded bg-white text-slate-700 truncate disabled:opacity-50 ${
              !isLatestSelected && runs.length > 0 ? 'border-amber-400 ring-1 ring-amber-200' : 'border-slate-300'
            }`}
          >
            {selectedRunId === null && <option value="" disabled>請選擇版本</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.versionCode} ({r.runDate})
              </option>
            ))}
          </select>
          {selectionError && <div role="alert" className="mt-1 text-xs text-red-700">
            <p>{selectionError}</p>
            <button type="button" className="mt-1 underline" onClick={retrySelection}>重試版本查詢</button>
          </div>}
          {!isLatestSelected && runs.length > 0 && (
            <p className="mt-1 flex items-start gap-1 text-[10px] leading-tight text-amber-700">
              <TriangleAlert size={11} className="mt-px shrink-0" />
              <span>唯讀（非最新版本，無法編輯/轉單）</span>
            </p>
          )}
          </>}
        </div>

        <div className={`mx-3 mb-2 rounded bg-blue-50 px-2 py-2 text-[10px] text-blue-700 ${hideOnCollapse}`}>Demo · 全合成資料 · 不連外部系統</div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2.5" aria-label="主要導覽">
          {NAV_ITEMS.map((item) => {
            const active = item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const pending = pendingHref === item.href;
            const showActive = active && pendingHref == null;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => handleNav(item.href)}
                title={collapsed ? item.label : undefined}
                aria-current={active ? 'page' : undefined}
                aria-busy={pending || undefined}
                className={`relative flex min-h-11 items-center gap-2.5 rounded-md border px-2.5 text-sm transition-[color,background-color,border-color,box-shadow] duration-150 md:min-h-9 ${
                  pending
                    ? 'border-blue-400 bg-blue-50 font-semibold text-blue-800 shadow-[inset_3px_0_0_#2563eb]'
                    : showActive
                    ? 'border-blue-300 bg-blue-50 font-semibold text-blue-800 shadow-[inset_3px_0_0_#2563eb]'
                    : 'border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900'
                } ${collapsed ? 'md:justify-center md:gap-0 md:px-1' : ''}`}
              >
                {pending ? (
                  <LoaderCircle size={17} className="shrink-0 animate-spin text-blue-700" aria-hidden="true" />
                ) : (
                  <Icon
                    size={17}
                    strokeWidth={showActive ? 2.25 : 1.8}
                    className={`shrink-0 ${showActive ? 'text-blue-700' : 'text-slate-500'}`}
                    aria-hidden="true"
                  />
                )}
                <span className={hideOnCollapse}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
