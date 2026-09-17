import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'app', 'api');
const reference = join(root, 'reference', 'production-api');
if (existsSync(reference)) throw new Error('原 API 已保留；拒絕重複覆寫。');
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name === 'route.ts') {
      const text = readFileSync(file, 'utf8');
      const methods = [...text.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]);
      if (!methods.length) throw new Error(`未辨識方法：${file}`);
      files.push({ path: relative(source, file), methods });
    } else throw new Error(`API 目錄有未預期檔案：${file}`);
  }
}
walk(source);
mkdirSync(dirname(reference), { recursive: true });
renameSync(source, reference);
for (const { path, methods } of files) {
  const route = dirname(path).split('\\').join('/');
  const target = join(source, path);
  mkdirSync(dirname(target), { recursive: true });
  const names = [...route.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const context = names.length ? `, context: { params: Promise<{ ${names.map((name) => `${name}: string`).join('; ')} }> }` : '';
  const text = "import type { NextRequest } from 'next/server';\nimport { forwardDemo } from '@/lib/demo/forward';\n\nexport const runtime = 'nodejs';\nexport const dynamic = 'force-dynamic';\n" + methods.map((method) => `\nexport function ${method}(request: NextRequest${context}) {\n  return forwardDemo('${method}', '${route}', request${names.length ? ', context' : ''});\n}\n`).join('');
  writeFileSync(target, text);
}
console.log(`已保留 ${files.length} 個原 API，並建立固定 demo 入口；不刪除原程式。`);
