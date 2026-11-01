import Link from 'next/link';

export const dynamic = 'force-dynamic';

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function ThankYouPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const order = first(sp.order);
  const capture = first(sp.capture);
  const sku = first(sp.sku);
  const status = first(sp.status);

  return (
    <div className="mx-auto max-w-xl rounded-lg border border-stone-200 bg-white p-6 text-center">
      <div aria-hidden className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-2xl text-green-700">
        ✓
      </div>
      <h1 className="text-2xl font-semibold text-stone-900">Thank you for your order</h1>
      <p className="mt-2 text-stone-600">
        {status === 'COMPLETED' || !status
          ? 'Payment captured. Your item ships within 2 business days and tracking is attached in PayPal.'
          : `Payment status: ${status}.`}
      </p>
      {order || capture ? (
        <dl className="mx-auto mt-5 max-w-sm space-y-1 rounded-md bg-stone-50 p-3 text-left font-mono text-xs text-stone-700">
          {sku ? (
            <div className="flex justify-between gap-2">
              <dt className="text-stone-400">SKU</dt>
              <dd>{sku}</dd>
            </div>
          ) : null}
          {order ? (
            <div className="flex justify-between gap-2">
              <dt className="text-stone-400">PayPal order</dt>
              <dd className="break-all">{order}</dd>
            </div>
          ) : null}
          {capture ? (
            <div className="flex justify-between gap-2">
              <dt className="text-stone-400">Capture (transaction)</dt>
              <dd className="break-all">{capture}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="mt-4 text-sm text-amber-800">No order details were passed to this page.</p>
      )}
      <div className="mt-6 rounded-md border border-dashed border-stone-300 p-3 text-left text-xs text-stone-600">
        <p className="font-semibold text-stone-800">Staging a dispute for the demo</p>
        <p className="mt-1">
          Sign in to the sandbox buyer account at sandbox.paypal.com, open the Resolution Center, and report a problem with this
          transaction. Disputes cannot be created through the API. Full steps are in docs/sandbox-staging.md.
        </p>
      </div>
      <div className="mt-6 flex justify-center gap-4 text-sm">
        <Link href="/store" className="text-stone-700 underline-offset-2 hover:underline">
          Keep shopping
        </Link>
        <Link href="/" className="text-teal-700 underline-offset-2 hover:underline">
          Seller inbox
        </Link>
      </div>
    </div>
  );
}