import type { Metadata } from 'next';
import { Sidebar } from '@/components/sidebar';
import { MrpVersionProvider } from '@/lib/mrp-version-context';
import { ArchiveModeProvider } from '@/lib/archive-mode-context';
import { ArchiveWorkspace } from '@/components/archive-workspace';
import { ToastProvider } from '@/components/toast';
import { ConfirmProvider } from '@/components/confirm-dialog';
import { AppHydrationMarker } from '@/components/app-hydration-marker';
import { BOOTSTRAP_RECOVERY_SCRIPT } from '@/lib/bootstrap-recovery';
import './globals.css';

export const metadata: Metadata = {
  title: 'MRP Interview Demo',
  description: '物料需求規劃展示・全部使用合成資料',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body className="min-h-screen bg-slate-50">
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP_RECOVERY_SCRIPT }} />
        <div
          id="mrp-bootstrap-error"
          role="alert"
          className="fixed inset-0 z-[9999] hidden flex items-center justify-center bg-slate-50 px-6 text-center text-slate-800"
        >
          <div className="max-w-md">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-red-200 bg-red-50 text-xl font-semibold text-red-600">
              !
            </div>
            <h1 className="text-xl font-semibold">系統載入失敗</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">前端檔案未完整載入，請重新載入頁面。</p>
            <button
              id="mrp-bootstrap-reload"
              type="button"
              className="mt-6 rounded border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              重新載入
            </button>
          </div>
        </div>
        <ToastProvider>
          <ConfirmProvider>
            <ArchiveModeProvider><MrpVersionProvider>
              <AppHydrationMarker />
              <div className="flex h-screen">
                <Sidebar />
                {/* Main content — overflow-hidden lets pages own their scroll
                    surfaces. Pages that need to scroll should use h-full + flex
                    flex-col with an inner flex-1 min-h-0 overflow-auto region.
                    This keeps page-level chrome (toolbars, pagination) in fixed
                    slots within the viewport instead of pushing pagination off
                    screen when content grows. */}
                <main className="min-w-0 flex-1 overflow-hidden pt-11 md:pt-0">
                  <ArchiveWorkspace>{children}</ArchiveWorkspace>
                </main>
              </div>
            </MrpVersionProvider></ArchiveModeProvider>
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
