'use client';

import type { ReactNode } from 'react';
import type { SalesMeetingSourceTarget } from '@/lib/mrp/sales-meeting-types';

export function SalesMeetingSourceValue({ target, onOpen, children }: {
  target: SalesMeetingSourceTarget;
  onOpen: (target: SalesMeetingSourceTarget) => void;
  children: ReactNode;
}) {
  const detail = target.type === 'orders'
    ? '訂單明細'
    : target.type === 'production_plans' ? '生產計畫明細' : '計算依據';
  return <button
    type="button"
    data-no-selection
    onMouseDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onOpen(target); }}
    className="w-full cursor-pointer rounded-sm text-right text-inherit underline decoration-dotted underline-offset-2 hover:bg-blue-100/60 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
    title={`查看${target.weekLabel}的${detail}`}
  >{children}</button>;
}
