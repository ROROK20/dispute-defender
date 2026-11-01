'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer } from '@paypal/react-paypal-js';

type ApiError = { error?: { code?: string; message?: string; debug_id?: string } };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as ApiError;
    const msg = body.error?.message ?? body.error?.code ?? fallback;
    return body.error?.debug_id ? `${msg} (debug_id ${body.error.debug_id})` : msg;
  } catch {
    return `${fallback} (HTTP ${res.status})`;
  }
}

function Buttons({ sku, disabled }: { sku: string; disabled?: boolean }) {
  const router = useRouter();
  const [{ isPending, isRejected }] = usePayPalScriptReducer();
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  if (isRejected) {
    return <p className="text-xs text-red-700">PayPal checkout failed to load. Check the client id and your connection.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {isPending && <div className="h-10 animate-pulse rounded-md bg-stone-100" aria-label="Loading PayPal" />}
      {capturing && <p className="text-xs text-teal-800">Capturing payment…</p>}
      <PayPalButtons
        style={{ layout: 'vertical', shape: 'rect', label: 'paypal', height: 40 }}
        disabled={disabled || capturing}
        forceReRender={[sku]}
        createOrder={async () => {
          setError(null);
          const res = await fetch('/api/store/orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sku }),
          });
          if (!res.ok) {
            const msg = await readError(res, 'Could not create the order');
            setError(msg);
            throw new Error(msg);
          }
          const body = (await res.json()) as { id?: string };
          if (!body.id) {
            const msg = 'Order created without an id';
            setError(msg);
            throw new Error(msg);
          }
          return body.id;
        }}
        onApprove={async (data) => {
          setCapturing(true);
          try {
            const res = await fetch(`/api/store/orders/${encodeURIComponent(data.orderID)}/capture`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error(await readError(res, 'Payment capture failed'));
            const body = (await res.json()) as { order_id?: string; capture_id?: string; status?: string };
            const params = new URLSearchParams({
              order: body.order_id ?? data.orderID,
              ...(body.capture_id ? { capture: body.capture_id } : {}),
              ...(body.status ? { status: body.status } : {}),
              sku,
            });
            router.push(`/store/thank-you?${params.toString()}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Payment capture failed');
          } finally {
            setCapturing(false);
          }
        }}
        onCancel={() => setError('Checkout cancelled. No payment was taken.')}
        onError={(err) => {
          const msg = err && typeof err.message === 'string' ? err.message : 'PayPal reported an error.';
          setError((prev) => prev ?? msg);
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

type Props = {
  sku: string;
  disabled?: boolean;
  currency?: string;
};

/**
 * PayPal wallet only (card/credit/pay-later/venmo funding disabled): sandbox
 * disputes can only be opened in the Resolution Center against wallet payments.
 */
export default function Checkout({ sku, disabled, currency = 'USD' }: Props) {
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;

  if (!clientId) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Checkout is unavailable: NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set.
      </p>
    );
  }

  return (
    <PayPalScriptProvider
      options={{
        clientId,
        currency,
        intent: 'capture',
        components: 'buttons',
        disableFunding: 'card,credit,paylater,venmo',
      }}
    >
      <Buttons sku={sku} disabled={disabled} />
    </PayPalScriptProvider>
  );
}

export { Checkout };