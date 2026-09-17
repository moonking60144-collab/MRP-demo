const demoGlobal = globalThis as typeof globalThis & { demoIsolationInstalled?: boolean };

export function registerDemoIsolation() {
  if (demoGlobal.demoIsolationInstalled) return;
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE_URL|SOURCE_|SMTP_|AUTH_MODE$|DB_MODE$|BASE_PATH$|NOTIFY_EMAILS$|ARCHIVE_|MRP_ARCHIVE_|MRP_BACKUP_)/.test(key)) delete process.env[key];
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['3000', '3142'].includes(url.port)) {
      throw new Error('展示環境禁止對外 HTTP 呼叫。');
    }
    return original(input, init);
  };
  demoGlobal.demoIsolationInstalled = true;
}
