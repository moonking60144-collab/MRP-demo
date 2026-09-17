'use client';

import { useEffect, useState } from 'react';
import {
  clearBootstrapRecoveryAttempts,
  getBootstrapRecoveryAction,
  isChunkLoadError,
  readBootstrapRecoveryAttempts,
  writeBootstrapRecoveryAttempts,
} from '@/lib/bootstrap-recovery';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!isChunkLoadError(error)) return;

    const attempts = readBootstrapRecoveryAttempts();
    if (attempts !== null && getBootstrapRecoveryAction(attempts) === 'reload' && writeBootstrapRecoveryAttempts(attempts + 1)) {
      setReloading(true);
      window.location.reload();
      return;
    }

    clearBootstrapRecoveryAttempts();
  }, [error]);

  const reload = () => {
    clearBootstrapRecoveryAttempts();
    window.location.reload();
  };

  return (
    <html lang="zh-TW">
      <body style={{ margin: 0, minHeight: '100vh', background: '#f8fafc', color: '#1e293b', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: '0 24px', textAlign: 'center' }}>
          <div style={{ width: '100%', maxWidth: 448 }}>
            <div style={{ display: 'flex', width: 48, height: 48, margin: '0 auto 20px', alignItems: 'center', justifyContent: 'center', border: '1px solid #fecaca', borderRadius: '50%', background: '#fef2f2', color: '#dc2626', fontSize: 20, fontWeight: 600 }}>
              !
            </div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{reloading ? '正在重新載入系統' : '系統載入失敗'}</h1>
            <p style={{ margin: '8px 0 0', color: '#64748b', fontSize: 14, lineHeight: '24px' }}>
              {reloading ? '偵測到前端檔案載入中斷，正在自動恢復。' : '前端檔案未完整載入，請重新載入頁面。'}
            </p>
            {!reloading && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24 }}>
                <button
                  type="button"
                  onClick={reload}
                  style={{ cursor: 'pointer', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 500 }}
                >
                  重新載入
                </button>
                {!isChunkLoadError(error) && (
                  <button
                    type="button"
                    onClick={reset}
                    style={{ cursor: 'pointer', border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff', padding: '8px 16px', color: '#334155', fontSize: 14, fontWeight: 500 }}
                  >
                    再試一次
                  </button>
                )}
              </div>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
