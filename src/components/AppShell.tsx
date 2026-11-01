import type { ReactNode } from 'react';
import Link from 'next/link';
import { NavTabs } from './NavTabs';
import { SandboxBadge } from './SandboxBadge';
import { MockModeBanner } from './MockModeBanner';
import { TriggerDemoButton } from './TriggerDemoButton';

export interface AppShellProps {
  children: ReactNode;
  paypalEnv?: string;
  paypalMock?: boolean;
  anthropicMock?: boolean;
  showTrigger?: boolean;
}

export function AppShell({
  children,
  paypalEnv = process.env.PAYPAL_ENV ?? 'sandbox',
  paypalMock = process.env.PAYPAL_MOCK === '1',
  anthropicMock = process.env.ANTHROPIC_MOCK === '1',
  showTrigger = true,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <MockModeBanner paypal={paypalMock} anthropic={anthropicMock} />
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-slate-900">
            <span
              aria-hidden
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-700 text-sm font-bold text-white"
            >
              D
            </span>
            DisputeDefender
          </Link>
          <SandboxBadge env={paypalEnv} />
          <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
            <NavTabs />
          </div>
          {showTrigger ? (
            <div className="ml-auto">
              <TriggerDemoButton compact />
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500">
          <span>Nothing is sent to PayPal without your approval. Every submitted sentence cites a stored source.</span>
          <span>Sandbox demo data · fictional store and buyers</span>
        </div>
      </footer>
    </div>
  );
}

export default AppShell;