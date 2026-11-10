export interface MockModeBannerProps {
  paypal?: boolean;
  anthropic?: boolean;
}

export function MockModeBanner({
  paypal = process.env.PAYPAL_MOCK === '1',
  anthropic = process.env.ANTHROPIC_MOCK === '1',
}: MockModeBannerProps) {
  if (!paypal && !anthropic) return null;
  // Say exactly which side is mocked: with PayPal mocked and a real model, the
  // agent's output is real Claude and the banner must not say otherwise.
  let text: string;
  if (paypal && anthropic) {
    text = 'PayPal responses are fixtures and agent output is scripted. For tests and CI only. Nothing here is a real PayPal or Claude result.';
  } else if (paypal) {
    text = 'PayPal responses are fixtures. No call here reaches PayPal; the agent output is real Claude.';
  } else {
    text = 'agent output is scripted. For tests and CI only. Nothing here is a real Claude result.';
  }
  return (
    <div role="alert" className="bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white">
      MOCK MODE: {text}
    </div>
  );
}

export default MockModeBanner;