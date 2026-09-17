import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import prisma from './db';
import { GET } from '../app/api/runs/[id]/route';

type LifecycleGlobal = {
  __mrpShutdownInstalled?: boolean;
  __mrpStartupHeal?: Promise<void>;
};

const lifecycleGlobal = globalThis as unknown as LifecycleGlobal;
const mutableEnv = process.env as Record<string, string | undefined>;
const originalNodeEnv = process.env.NODE_ENV;
const originalInstalled = lifecycleGlobal.__mrpShutdownInstalled;
const originalStartupHeal = lifecycleGlobal.__mrpStartupHeal;
const runDelegate = prisma.mrpRun as unknown as {
  updateMany: (args: unknown) => Promise<{ count: number }>;
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
};
const originalUpdateMany = runDelegate.updateMany;
const originalFindUnique = runDelegate.findUnique;

afterEach(() => {
  mutableEnv.NODE_ENV = originalNodeEnv;
  lifecycleGlobal.__mrpShutdownInstalled = originalInstalled;
  lifecycleGlobal.__mrpStartupHeal = originalStartupHeal;
  runDelegate.updateMany = originalUpdateMany;
  runDelegate.findUnique = originalFindUnique;
});

test('cold process 第一個 request 是 run detail 時，先 self-heal 再回傳 error run', async () => {
  mutableEnv.NODE_ENV = 'production';
  lifecycleGlobal.__mrpShutdownInstalled = true;
  lifecycleGlobal.__mrpStartupHeal = undefined;
  const order: string[] = [];

  runDelegate.updateMany = async () => {
    order.push('self-heal');
    return { count: 1 };
  };
  runDelegate.findUnique = async () => {
    order.push('read-run');
    return { id: 7, status: 'error', errorMessage: 'orphaned by restart' };
  };

  const response = await GET(
    new NextRequest('http://localhost/api/runs/7'),
    { params: Promise.resolve({ id: '7' }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(order, ['self-heal', 'read-run']);
  assert.equal(body.run.status, 'error');
});
