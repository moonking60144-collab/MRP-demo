'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePersistedState } from './ui/use-persisted-state';
import { FullLoader } from './ui/loader';
import { MergeToggle } from './ui/merge-toggle';
import { cacheInvalidate } from '@/lib/swr-cache';

type DbMode = 'local' | 'docker' | 'remote';

interface SettingsData {
  dbMode: DbMode;
  storage?: 'memory' | 'postgresql';
  urls: Record<DbMode, string>;
  urlConfigured: Record<DbMode, boolean>;
  connection: {
    connected: boolean;
    dbVersion: string;
    error: string;
  };
}

const DB_OPTIONS: { value: DbMode; label: string; description: string }[] = [
  {
    value: 'local',
    label: '合成來源 A（local）',
    description: '本機合成資料，沒有 PostgreSQL 連線',
  },
  {
    value: 'docker',
    label: '合成來源 B（docker）',
    description: '展示資料來源切換，不啟動 Docker',
  },
  {
    value: 'remote',
    label: '合成來源 C（remote）',
    description: '展示多來源標記，不連接遠端服務',
  },
];

export function SettingsClient() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [ignoredCodes, setIgnoredCodes] = useState('');
  const [savingIgnore, setSavingIgnore] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [savingAutoFollow, setSavingAutoFollow] = useState(false);
  const [mergeDb, setMergeDb] = usePersistedState('mrp_mergeDb', false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('載入設定失敗');
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入設定失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    fetch('/api/fg-monthly/ignored-customers')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d.codes)) setIgnoredCodes(d.codes.join(', ')); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings/auto-follow')
      .then((r) => r.json())
      .then((d) => { if (typeof d.autoFollow === 'boolean') setAutoFollow(d.autoFollow); })
      .catch(() => {});
  }, []);

  const handleToggleAutoFollow = async () => {
    const next = !autoFollow;
    setSavingAutoFollow(true);
    setAutoFollow(next); // 樂觀更新
    try {
      const res = await fetch('/api/settings/auto-follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoFollow: next }),
      });
      const data = await res.json();
      if (typeof data.autoFollow === 'boolean') setAutoFollow(data.autoFollow);
    } catch {
      setAutoFollow(!next); // 失敗回滾
    } finally {
      setSavingAutoFollow(false);
    }
  };

  const handleSaveIgnored = async () => {
    setSavingIgnore(true);
    setError('');
    setSuccess('');
    try {
      const codes = ignoredCodes.split(',').map((c) => c.trim()).filter(Boolean);
      const res = await fetch('/api/fg-monthly/ignored-customers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '儲存失敗');
        return;
      }
      setIgnoredCodes((data.codes || []).join(', '));
      cacheInvalidate(key => key.startsWith('/api/fg-monthly'));
      setSuccess('已更新成品忽略清單。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSavingIgnore(false);
    }
  };

  const handleSwitch = async (mode: DbMode) => {
    if (!settings || mode === settings.dbMode) return;
    if (!settings.urlConfigured[mode]) {
      setError(`「${mode}」尚未設定連線網址，請編輯 .env 新增 DATABASE_URL_${mode.toUpperCase()}。`);
      return;
    }

    setSwitching(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbMode: mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '切換失敗');
        return;
      }
      setSuccess(`已切換至「${mode}」資料庫，已即時生效。`);
      // Run IDs are database-local; discard mounted state and module caches together.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '切換失敗');
    } finally {
      setSwitching(false);
    }
  };

  if (loading) {
    return <FullLoader />;
  }

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">設定</h1>
      <p className="text-sm text-slate-500 mb-6">設定資料庫連線與應用程式設定</p>

      {/* Messages */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Database Section */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">資料庫連線</h2>
          <p className="text-xs text-slate-500 mt-0.5">{settings?.storage === 'postgresql' ? 'PostgreSQL 合成展示：報表與原始資料實際讀取 SQL；規劃操作仍存於本機。' : '選擇離線合成資料來源'}</p>
        </div>

        <div className="p-5 space-y-3">
          {DB_OPTIONS.filter(opt => settings?.storage !== 'postgresql' || opt.value === 'local').map((opt) => {
            const isActive = settings?.dbMode === opt.value;
            const isConfigured = settings?.urlConfigured[opt.value] ?? false;
            const maskedUrl = settings?.urls[opt.value] || '';

            return (
              <button
                key={opt.value}
                onClick={() => handleSwitch(opt.value)}
                disabled={switching || isActive}
                className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                  isActive
                    ? 'border-blue-500 bg-blue-50/50'
                    : isConfigured
                    ? 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'
                    : 'border-dashed border-slate-300 opacity-60'
                } ${switching ? 'cursor-wait' : isActive ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Radio indicator */}
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        isActive ? 'border-blue-500' : 'border-slate-300'
                      }`}
                    >
                      {isActive && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                    </div>
                    <div>
                      <div className="font-medium text-slate-800 text-sm">
                        {settings?.storage === 'postgresql' ? 'PostgreSQL 合成資料' : opt.label}
                        {isActive && (
                          <span className="ml-2 text-xs text-blue-600 font-normal">使用中</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">{settings?.storage === 'postgresql' ? '專用 loopback 展示庫，不連公司資料庫或 Ragic' : opt.description}</div>
                    </div>
                  </div>
                  {!isConfigured && (
                    <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                      未設定
                    </span>
                  )}
                </div>
                {maskedUrl && (
                  <div className="mt-2 ml-7 text-xs font-mono text-slate-400 truncate">
                    {maskedUrl}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* 資料合併 */}
      {settings?.storage !== 'postgresql' && <section className="mt-4 bg-white border border-slate-200 rounded-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">資料合併</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            開啟後，月推移 / 週推移 / 產銷會議改為合併查詢所有已設定的資料庫（切換後重新進入該頁生效）
          </p>
        </div>
        <div className="p-5">
          <MergeToggle enabled={mergeDb} onChange={setMergeDb} />
        </div>
      </section>}

      {/* Connection Status */}
      {settings?.connection && (
        <section className="mt-4 bg-white border border-slate-200 rounded-lg">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800">連線狀態</h2>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  settings.connection.connected ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className="text-sm font-medium text-slate-700">
                {settings.connection.connected ? '已連線' : '未連線'}
              </span>
            </div>
            {settings.connection.connected && settings.connection.dbVersion && (
              <div className="text-xs font-mono text-slate-500 bg-slate-50 p-3 rounded">
                {settings.connection.dbVersion}
              </div>
            )}
            {settings.connection.error && (
              <div className="text-xs text-red-600 bg-red-50 p-3 rounded">
                {settings.connection.error}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 成品忽略清單 */}
      <section className="mt-4 bg-white border border-slate-200 rounded-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">成品忽略清單</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            這些客戶代碼的料件不會出現在成品月推移（可在該頁工具列「顯示被忽略」暫時顯示）
          </p>
        </div>
        <div className="p-5">
          <label className="block text-xs text-slate-500 mb-1">客戶代碼（以逗號分隔）</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ignoredCodes}
              onChange={(e) => setIgnoredCodes(e.target.value)}
              placeholder="例：RD"
              className="flex-1 px-3 py-1.5 border border-slate-300 rounded text-sm font-mono"
            />
            <button
              onClick={handleSaveIgnored}
              disabled={savingIgnore}
              className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {savingIgnore ? '儲存中…' : '儲存'}
            </button>
          </div>
        </div>
      </section>

      {/* MRP 版本同步 */}
      <section className="mt-4 bg-white border border-slate-200 rounded-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">MRP 版本同步</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            開啟後，只要有人跑完新的 MRP，所有使用者的畫面會自動切換到最新版本（編輯／轉單進行中會等完成再切）。關閉後各人可自由停在舊版本檢視。
          </p>
        </div>
        <div className="p-5">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-sm text-slate-700">自動切換到最新 MRP（全域，影響所有使用者）</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoFollow}
              onClick={handleToggleAutoFollow}
              disabled={savingAutoFollow}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${autoFollow ? 'bg-blue-600' : 'bg-slate-300'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoFollow ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </label>
        </div>
      </section>

      {/* Env Reference */}
      <section className="mt-4 bg-white border border-slate-200 rounded-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">環境變數參考</h2>
        </div>
        <div className="p-5">
          <p className="text-xs text-slate-500 mb-3">
            {settings?.storage === 'postgresql' ? '目前使用專用 PostgreSQL 合成庫；歷史資料、規劃、轉單及維運仍為本機展示，不連公司或雲端服務。停止後清除專用連線變數，再用 npm start 切回免資料庫模式。' : 'Demo 不需要 .env；三個來源皆使用本機合成資料，不連接資料庫、Docker 或雲端服務。'}
          </p>
          <div className="text-xs font-mono text-slate-600 bg-slate-50 p-3 rounded space-y-1">
            <div>DEMO_STORAGE={settings?.storage || 'memory'}</div>
            {settings?.storage === 'postgresql' ? <div>MRP_DEMO_POSTGRES_URL=專用 loopback 合成庫（不顯示帳密）</div> : <div>啟動方式：npm start（免資料庫）</div>}
          </div>
        </div>
      </section>
    </div>
    </div>
  );
}
