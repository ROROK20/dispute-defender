import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Juniper Thread Co. · Sandbox storefront',
};

interface StoreSku {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  description: string;
  size_chart_version?: string | null;
}

async function loadSkus(): Promise<{ skus: StoreSku[]; error: string | null }> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data', 'fixtures', 'store.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>).skus ?? (parsed as Record<string, unknown>).products);
    if (!Array.isArray(list)) return { skus: [], error: 'store.json has no skus array.' };
    const skus = list.filter(
      (s): s is StoreSku =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as StoreSku).sku === 'string' &&
        typeof (s as StoreSku).name === 'string' &&
        typeof (s as StoreSku).price_cents === 'number',
    );
    return { skus, error: null };
  } catch (err) {
    return { skus: [], error: err instanceof Error ? err.message : 'Could not read store.json.' };
  }
}

function price(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export default async function StorePage() {
  const { skus, error } = await loadSkus();
  const categories = [...new Set(skus.map((s) => s.category ?? 'Other'))];

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        The catalog could not be loaded: {error}. Run <code className="font-mono">npm run setup</code>.
      </div>
    );
  }

  if (skus.length === 0) {
    return <p className="py-12 text-center text-sm text-stone-600">No products yet. Run npm run seed to load the catalog.</p>;
  }

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight text-stone-900">Handmade apparel, small batches.</h1>
        <p className="mt-2 max-w-xl text-stone-600">
          Linen, cotton and wool pieces cut and sewn in our studio. Free returns within 30 days, per our returns policy.
        </p>
      </section>
      {categories.map((cat) => (
        <section key={cat} aria-label={cat}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">{cat}</h2>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {skus
              .filter((s) => (s.category ?? 'Other') === cat)
              .map((s) => (
                <li key={s.sku} className="flex flex-col rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
                  <div
                    aria-hidden
                    className="mb-3 flex aspect-[4/3] items-center justify-center rounded-md bg-gradient-to-br from-stone-100 to-stone-200 text-3xl font-semibold text-stone-400"
                  >
                    {s.name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)}
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-medium text-stone-900">{s.name}</h3>
                    <span className="tabular-nums text-stone-900">{price(s.price_cents)}</span>
                  </div>
                  <p className="font-mono text-[11px] text-stone-400">{s.sku}</p>
                  <p className="mt-2 flex-1 text-sm text-stone-600">{s.description}</p>
                  {s.size_chart_version ? (
                    <p className="mt-1 text-xs text-stone-500">Size chart {s.size_chart_version}</p>
                  ) : null}
                  <div className="mt-4 min-h-[44px]" data-paypal-sku={s.sku} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}