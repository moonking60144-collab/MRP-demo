import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'mrp-synthetic-test-'));
globalThis.demoStateDirectory = directory;
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
