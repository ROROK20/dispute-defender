import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import AppShell from '@/components/AppShell';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'DisputeDefender',
  description:
    'A PayPal dispute agent for small sellers: evidence scored against a published rubric, every sentence cited, nothing sent without your approval.',
  openGraph: {
    title: 'DisputeDefender',
    description: 'Answer PayPal disputes in minutes, with every sentence traced to its source.',
    images: ['/og-image.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f766e',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-canvas font-sans text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}