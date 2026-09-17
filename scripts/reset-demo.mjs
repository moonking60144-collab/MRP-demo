import { existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [join(root, 'demo-data'), join(root, '.next', 'standalone', 'demo-data')].filter(existsSync);
const reader = createInterface({ input: process.stdin, output: process.stdout });
console.log('Stop the demo server first. Only these synthetic state folders will be moved:');
console.log(targets.join('\n'));
const answer = await reader.question('Reset synthetic state? Type RESET: ');
reader.close();
if (answer !== 'RESET') { console.log('Cancelled.'); process.exit(0); }
for (const folder of targets) { const backup = `${folder}-backup-${Date.now()}`; renameSync(folder, backup); console.log(`Recoverable backup: ${backup}`); }
console.log('Next start generates fresh synthetic data. Browser presets remain in localStorage.');
