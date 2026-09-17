import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'src/lib/demo')).filter((name) => name.endsWith('.test.ts')).map((name) => `src/lib/demo/${name}`);
const pure = ['compute-plan-qty', 'fg-plan-suggestion', 'fg-plan-input', 'fg-monthly-filters', 'component-weekly-usage', 'component-weekly-purchase', 'work-order-bom-usage', 'work-order-material-anomaly', 'work-order-material-ledger', 'order-demand-contract', 'fg-monthly-source-detail', 'shared-erp-pool', 'shared-erp-display', 'fg-monthly-totals', 'fg-row-groups', 'warehouse-stock', 'fg-stock-calculation', 'fg-monthly-engine'];
files.push(...pure.map((name) => `src/lib/mrp/${name}.test.ts`), 'src/lib/data-table-server-filters.test.ts', 'src/lib/table-presets.test.ts', 'src/lib/archive/fg-report-adapter.test.ts', 'src/lib/archive/weekly-report-adapter.test.ts');
const child = spawn(process.execPath, ['--import', './scripts/test-environment.mjs', '--import', 'tsx', '--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' });
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
