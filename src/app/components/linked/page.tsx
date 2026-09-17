import { LinkedComponentWeekly } from '@/components/linked-component-weekly';

export default async function LinkedComponentWeeklyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const input = await searchParams;
  const params = new URLSearchParams();
  for (const key of ['runId', 'archiveId', 'dbSource', 'material', 'mrpType']) {
    if (typeof input[key] === 'string') params.set(key, input[key]);
  }
  return <LinkedComponentWeekly key={params.toString()} query={params.toString()} />;
}
