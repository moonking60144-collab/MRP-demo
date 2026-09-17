import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { reconnectDb, withRuntimeDbControl } from '@/lib/db';
import { getActiveRun } from '@/lib/mrp/run-orchestrator';

type DbMode = 'local' | 'docker' | 'remote';

const ENV_PATH = join(process.cwd(), '.env');

function maskUrl(url: string): string {
  if (!url) return '';
  // Mask password in postgresql://user:password@host:port/db
  return url.replace(/:([^@/]+)@/, ':****@');
}

/**
 * GET /api/settings — Read current settings
 */
export async function GET() {
  try {
    const dbMode = (process.env.DB_MODE || 'local') as DbMode;
    const urls = {
      local: process.env.DATABASE_URL_LOCAL || '',
      docker: process.env.DATABASE_URL_DOCKER || '',
      remote: process.env.DATABASE_URL_REMOTE || '',
    };

    // Test active connection (fall back to DATABASE_URL for old deployments)
    const activeUrl = urls[dbMode] || process.env.DATABASE_URL || '';
    let connected = false;
    let dbVersion = '';
    let errorMsg = '';

    if (activeUrl) {
      const testClient = new PrismaClient({
        datasources: { db: { url: activeUrl } },
        log: [],
      });
      try {
        const result = await testClient.$queryRaw<{ version: string }[]>`SELECT version()`;
        connected = true;
        dbVersion = result[0]?.version || '';
        await testClient.$disconnect();
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : 'Connection failed';
        try { await testClient.$disconnect(); } catch { /* ignore */ }
      }
    }

    return NextResponse.json({
      dbMode,
      urls: {
        local: maskUrl(urls.local),
        docker: maskUrl(urls.docker),
        remote: maskUrl(urls.remote),
      },
      urlConfigured: {
        local: !!urls.local,
        docker: !!urls.docker,
        remote: !!urls.remote,
      },
      connection: { connected, dbVersion, error: errorMsg },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/settings — Update DB_MODE in .env
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const newMode = body.dbMode as DbMode;

    if (!['local', 'docker', 'remote'].includes(newMode)) {
      return NextResponse.json({ error: 'Invalid dbMode' }, { status: 400 });
    }

    const currentMode = (process.env.DB_MODE || 'local') as DbMode;
    if (newMode === currentMode) {
      return NextResponse.json({ ok: true, dbMode: newMode });
    }

    return await withRuntimeDbControl(async () => {
      const activeRun = await getActiveRun();
      if (activeRun) {
        return NextResponse.json(
          {
            error: `MRP ${activeRun.versionCode} 正在執行（${activeRun.status}），完成後才能切換資料庫。`,
            activeRunId: activeRun.id,
          },
          { status: 409 },
        );
      }

      const urls: Record<DbMode, string> = {
        local: process.env.DATABASE_URL_LOCAL || '',
        docker: process.env.DATABASE_URL_DOCKER || '',
        remote: process.env.DATABASE_URL_REMOTE || '',
      };

      const targetUrl = urls[newMode];
      if (!targetUrl) {
        return NextResponse.json(
          { error: `No DATABASE_URL_${newMode.toUpperCase()} configured in .env` },
          { status: 400 },
        );
      }

      const testClient = new PrismaClient({
        datasources: { db: { url: targetUrl } },
        log: [],
      });
      try {
        await testClient.$queryRaw`SELECT 1`;
        await testClient.$disconnect();
      } catch (err) {
        try { await testClient.$disconnect(); } catch { /* ignore */ }
        return NextResponse.json(
          { error: `Cannot connect to ${newMode} database: ${err instanceof Error ? err.message : 'unknown'}` },
          { status: 400 },
        );
      }

      let envContent = await readFile(ENV_PATH, 'utf-8');
      envContent = envContent.replace(/^DB_MODE=.*/m, `DB_MODE=${newMode}`);
      envContent = envContent.replace(/^DATABASE_URL=.*/m, `DATABASE_URL=${targetUrl}`);
      await writeFile(ENV_PATH, envContent, 'utf-8');

      process.env.DB_MODE = newMode;
      process.env.DATABASE_URL = targetUrl;
      await reconnectDb(targetUrl, newMode);

      return NextResponse.json({ ok: true, dbMode: newMode });
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
