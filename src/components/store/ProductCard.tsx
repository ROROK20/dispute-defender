'use client';

import clsx from 'clsx';
import Checkout from './Checkout';
import { formatCents } from '../grid/AmountCell';

export type StoreProduct = {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  description: string;
  size_chart_version?: string | null;
};

type Props = {
  product: StoreProduct;
  className?: string;
  showCheckout?: boolean;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

export default function ProductCard({ product, className, showCheckout = true }: Props) {
  return (
    <article className={clsx('flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm', className)}>
      <div
        aria-hidden
        className="flex aspect-[4/3] items-center justify-center bg-gradient-to-br from-stone-100 via-stone-50 to-teal-50"
      >
        <span className="text-3xl font-semibold tracking-tight text-stone-400">{initials(product.name)}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-500">{product.category}</p>
            <h3 className="text-base font-semibold leading-snug text-stone-900">{product.name}</h3>
            <p className="font-mono text-[11px] text-stone-400">{product.sku}</p>
          </div>
          <span className="shrink-0 text-base font-semibold tabular-nums text-stone-900">{formatCents(product.price_cents)}</span>
        </div>
        <p className="line-clamp-3 text-sm text-stone-600">{product.description}</p>
        {product.size_chart_version && (
          <p className="text-xs text-stone-500">
            Size chart <span className="font-mono">{product.size_chart_version}</span>
          </p>
        )}
        {showCheckout && (
          <div className="mt-auto pt-1">
            <Checkout sku={product.sku} />
          </div>
        )}
      </div>
    </article>
  );
}

export { ProductCard };