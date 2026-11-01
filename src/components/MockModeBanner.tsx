export interface MockModeBannerProps {
  paypal?: boolean;
  anthropic?: boolean;
}

export function MockModeBanner({
  paypal = process.env.PAYPAL_MOCK === '1',
  anthropic = process.env.ANTHROPIC_MOCK === '1',
}: MockModeBannerProps) {
  if (!paypal && !anthropic) return null;
  const parts: string[] = [];
  if (paypal) parts.push('PayPal responses are fixtures');
  if (anthropic) parts.push('agent output is scripted');
  return (
    <div role="alert" className="bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white">
      MOCK MODE: {parts.join(' and ')}. For tests and CI only. Nothing here is a real PayPal or Claude result.
    </div>
  );
}

export default MockModeBanner;