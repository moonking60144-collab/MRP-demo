'use client';

const SOURCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  local: { bg: 'bg-green-50', text: 'text-green-700', label: '本機' },
  docker: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Docker' },
  remote: { bg: 'bg-purple-50', text: 'text-purple-700', label: '遠端' },
};

interface DbSourceBadgeProps {
  source: string;
}

export function DbSourceBadge({ source }: DbSourceBadgeProps) {
  const style = SOURCE_STYLES[source] || { bg: 'bg-slate-50', text: 'text-slate-600', label: source };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

export function getSourceLabel(source: string): string {
  return SOURCE_STYLES[source]?.label || source;
}
