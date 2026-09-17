import Link from 'next/link';
import { dataset } from '@/lib/demo/data';
import { latestRun, state } from '@/lib/demo/store';
import { prepareDemo } from '@/lib/demo/run-control';

export default async function DemoRecord({ searchParams }: { searchParams: Promise<{ type?: string; id?: string }> }) {
  const query = await searchParams;
  await prepareDemo();
  const data = dataset(latestRun().id);
  const record = state().transfers.find((row) => row.ragicRecordId === query.id) ?? Object.values(data.source).flat().find((row) => row.ragicRecordId === query.id);
  return <section className="h-full overflow-auto p-6"><h1 className="text-xl font-bold">合成來源紀錄</h1><p className="mt-3 text-slate-600">這是展示用原單入口，不連接公司的 Ragic。</p><dl className="my-5 grid max-w-lg grid-cols-2 gap-3 rounded border bg-white p-4"><dt>資料類型</dt><dd>{query.type ?? '—'}</dd><dt>合成紀錄編號</dt><dd>{query.id ?? '—'}</dd></dl><pre className="mb-5 overflow-auto rounded border bg-white p-4 text-xs">{record ? JSON.stringify(record, null, 2) : '找不到此合成紀錄。'}</pre><Link href="/source-data" className="text-blue-600 underline">查看本機原始資料</Link></section>;
}
