import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDemoPostgresTarget, assertDemoPostgresWebTarget } from '../demo-postgres/target';

test('Prisma 展示驗證只接受獨立本機測試庫，不會接管公司 DATABASE_URL', () => {
  assert.equal(assertDemoPostgresTarget('postgresql://mrp_demo_test@127.0.0.1:55437/mrp_demo_prisma_test').hostname, '127.0.0.1');
  for (const url of [undefined, 'postgresql://postgres@127.0.0.1/demo_mrp',
    'postgresql://mrp_demo_test@company.example/mrp_demo_prisma_test',
    'postgresql://postgres@localhost/mrp_demo_prisma_test',
    'postgresql://mrp_demo_test@127.0.0.1/mrp_demo_prisma_test?host=company.example',
    'postgresql://mrp_demo_test@127.0.0.1/mrp_demo_prisma_test?schema=production',
    'https://mrp_demo_test@localhost/mrp_demo_prisma_test']) assert.throws(() => assertDemoPostgresTarget(url), 'POSTGRES_TARGET_REQUIRED');
});

test('PostgreSQL 網站展示使用不同專用庫，不接受測試庫或公司連線', () => {
  assert.equal(assertDemoPostgresWebTarget('postgresql://mrp_demo_test@127.0.0.1:55437/mrp_demo_prisma_demo').hostname, '127.0.0.1');
  for (const value of [undefined, 'postgresql://mrp_demo_test@127.0.0.1/mrp_demo_prisma_test',
    'postgresql://postgres@127.0.0.1/mrp_demo_prisma_demo', 'postgresql://mrp_demo_test@company.example/mrp_demo_prisma_demo',
    'postgresql://mrp_demo_test@localhost/mrp_demo_prisma_demo?host=company.example']) assert.throws(() => assertDemoPostgresWebTarget(value));
});
