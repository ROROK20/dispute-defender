import clsx from 'clsx';

export interface SubmissionResultProps {
  action: string;
  ok: boolean;
  statusCode?: number | null;
  debugId?: string | null;
  elapsedMs?: number | null;
  message?: string | null;
  decisionId?: string | null;
  className?: string;
}

const ACTION_TEXT: Record<string, string> = {
  submit_evidence: 'Evidence submitted to PayPal',
  accept_claim: 'Claim accepted, refund issued',
  make_offer: 'Offer sent to buyer',
  send_message: 'Message sent to buyer',
};

export function SubmissionResult({
  action,
  ok,
  statusCode,
  debugId,
  elapsedMs,
  message,
  decisionId,
  className,
}: SubmissionResultProps) {
  return (
    <div
      role="status"
      className={clsx(
        'rounded-lg border p-4 text-sm',
        ok ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900',
        className,
      )}
    >
      <p className="font-semibold">
        {ok ? (ACTION_TEXT[action] ?? `${action.replace(/_/g, ' ')} succeeded`) : `PayPal rejected ${action.replace(/_/g, ' ')}`}
      </p>
      {message ? <p className="mt-1 break-words">{message}</p> : null}
      <dl className="mt-2 grid grid-cols-1 gap-1 font-mono text-xs sm:grid-cols-2">
        {typeof statusCode === 'number' ? (
          <div>
            <dt className="inline text-slate-500">HTTP </dt>
            <dd className="inline font-semibold">{statusCode}</dd>
          </div>
        ) : null}
        {debugId ? (
          <div className="break-all">
            <dt className="inline text-slate-500">paypal-debug-id </dt>
            <dd className="inline">{debugId}</dd>
          </div>
        ) : null}
        {typeof elapsedMs === 'number' ? (
          <div>
            <dt className="inline text-slate-500">measured, event → 2xx </dt>
            <dd className="inline font-semibold">{(elapsedMs / 1000).toFixed(1)} s</dd>
          </div>
        ) : null}
        {decisionId ? (
          <div className="break-all">
            <dt className="inline text-slate-500">decision </dt>
            <dd className="inline">{decisionId}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export default SubmissionResult;