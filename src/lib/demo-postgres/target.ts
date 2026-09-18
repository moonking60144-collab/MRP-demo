export const TEST_DATABASE = 'mrp_demo_prisma_test';
export const TEST_USER = 'mrp_demo_test';
export const PURPOSE_KEY = 'demo-postgres-verification-purpose';
export const PURPOSE = 'synthetic-mrp-prisma-verification-v1';
export const WEB_DATABASE = 'mrp_demo_prisma_demo';
export const WEB_PURPOSE = 'synthetic-mrp-postgres-web-v1';

export function assertDemoPostgresWebTarget(value: string | undefined): URL {
  if (!value) throw new Error('請指定 MRP_DEMO_POSTGRES_URL；不會讀取 DATABASE_URL 或公司設定。');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || decodeURIComponent(url.pathname) !== `/${WEB_DATABASE}` || decodeURIComponent(url.username) !== TEST_USER
    || url.search || url.hash) throw new Error('只允許 loopback 的 mrp_demo_test／mrp_demo_prisma_demo，且不可附加連線參數。');
  return url;
}

export function assertDemoPostgresTarget(value: string | undefined): URL {
  if (!value) throw new Error('請指定 MRP_DEMO_TEST_DATABASE_URL；不會讀取 DATABASE_URL 或公司設定。');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || decodeURIComponent(url.pathname) !== `/${TEST_DATABASE}` || decodeURIComponent(url.username) !== TEST_USER
    || url.search || url.hash) throw new Error('只允許 loopback 的 mrp_demo_test／mrp_demo_prisma_test，且不可附加連線參數。');
  return url;
}
