'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';

interface Target {
  el: HTMLElement;
  sku: string;
}

interface OrderResponse {
  id?: string;
  error?: { message?: string; debug_id?: string };
}

interface CaptureResponse {
  order_id?: string;
  capture_id?: string;
  status?: string;
  error?: { message?: string; debug_id?: string };
}

function BuyButton({ sku }: { sku: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <PayPalButtons
        style={{ layout: 'horizontal', height: 40, tagline: false, label: 'pay' }}
        forceReRender={[sku]}
        createOrder={async () => {
          setError(null);
          const res = await fetch('/api/store/orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sku }),
          });
          const json = (await res.json().catch(() => null)) as OrderResponse | null;
          if (!res.ok || !json?.id) {
            const msg = json?.error?.message ?? `Could not create order (HTTP ${res.status})`;
            setError(json?.error?.debug_id ? `${msg} · debug ${json.error.debug_id}` : msg);
            throw new Error(msg);
          }
          return json.id;
        }}
        onApprove={async (data) => {
          const res = await fetch(`/api/store/orders/${encodeURIComponent(data.orderID)}/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const json = (await res.json().catch(() => null)) as CaptureResponse | null;
          if (!res.ok || !json) {
            const msg = json?.error?.message ?? `Capture failed (HTTP ${res.status})`;
            setError(json?.error?.debug_id ? `${msg} · debug ${json.error.debug_id}` : msg);
            return;
          }
          const params = new URLSearchParams({ order: json.order_id ?? data.orderID, sku });
          if (json.capture_id) params.set('capture', json.capture_id);
          if (json.status) params.set('status', json.status);
          router.push(`/store/thank-you?${params.toString()}`);
        }}
        onCancel={() => setError('Checkout cancelled.')}
        onError={(err) => {
          setError(err instanceof Error ? err.message : 'PayPal checkout failed.');
        }}
      />
      {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

export default function StoreLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [targets, setTargets] = useState<Target[]>([]);
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? '';

  const scan = useCallback(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-paypal-sku]'));
    setTargets(nodes.map((el) => ({ el, sku: el.dataset.paypalSku ?? '' })).filter((t) => t.sku));
  }, []);

  useEffect(() => {
    const id = window.requestAnimationFrame(scan);
    return () => window.cancelAnimationFrame(id);
  }, [pathname, scan]);

  return (
    <div className="-mx-4 -my-6 min-h-full bg-[#faf8f4] px-4 py-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-4">
          <Link href="/store" className="flex items-center gap-2">
            <span aria-hidden className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-stone-800 text-sm font-semibold text-white">
              J
            </span>
            <span className="text-lg font-semibold tracking-tight text-stone-900">Juniper Thread Co.</span>
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm text-stone-600" aria-label="Store policies">
            <Link href="/store/policies/returns" className="hover:text-stone-900">
              Returns
            </Link>
            <Link href="/store/policies/shipping" className="hover:text-stone-900">
              Shipping
            </Link>
            <Link href="/store/policies/size-guide" className="hover:text-stone-900">
              Size guide
            </Link>
          </nav>
        </header>
        <p className="mb-6 rounded-md border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
          Fictional demo storefront on the PayPal sandbox. Pay with a sandbox buyer account; no real money moves.
        </p>
        {children}
        {clientId ? (
          <PayPalScriptProvider options={{ clientId, currency: 'USD', intent: 'capture' }}>
            {targets.map((t) => createPortal(<BuyButton sku={t.sku} />, t.el, t.sku))}
          </PayPalScriptProvider>
        ) : (
          targets.map((t) =>
            createPortal(
              <p className="text-xs text-amber-800">Checkout disabled: set NEXT_PUBLIC_PAYPAL_CLIENT_ID.</p>,
              t.el,
              t.sku,
            ),
          )
        )}
      </div>
    </div>
  );
}