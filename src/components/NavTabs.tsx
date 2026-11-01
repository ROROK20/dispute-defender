'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

export interface NavTab {
  href: string;
  label: string;
}

export const DEFAULT_TABS: NavTab[] = [
  { href: '/', label: 'Inbox' },
  { href: '/patterns', label: 'Patterns' },
  { href: '/activity', label: 'Activity' },
  { href: '/store', label: 'Storefront' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/disputes');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavTabs({ tabs = DEFAULT_TABS }: { tabs?: NavTab[] }) {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Main" className="-mb-px flex gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const active = isActive(pathname, tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default NavTabs;