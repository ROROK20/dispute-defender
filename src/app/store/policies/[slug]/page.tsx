import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLICY_FILES: Record<string, { file: string; title: string }> = {
  returns: { file: 'returns-policy.md', title: 'Returns policy' },
  shipping: { file: 'shipping-policy.md', title: 'Shipping policy' },
  'size-guide': { file: 'size-guide.md', title: 'Size guide' },
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function publishedAt(slug: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data', 'fixtures', 'store.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const index = parsed.policies ?? parsed.policy_index;
    if (Array.isArray(index)) {
      const hit = index.find((p) => typeof p === 'object' && p !== null && (p as { slug?: string }).slug === slug) as
        | { published_at?: string }
        | undefined;
      return hit?.published_at ?? null;
    }
    if (index && typeof index === 'object') {
      const hit = (index as Record<string, { published_at?: string }>)[slug];
      return hit?.published_at ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="rounded bg-stone-100 px-1 font-mono text-sm">{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(<p key={key++} className="my-3 leading-relaxed text-stone-700">{inline(para.join(' '))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      out.push(
        list.ordered ? (
          <ol key={key++} className="my-3 list-decimal space-y-1 pl-6 text-stone-700">{items}</ol>
        ) : (
          <ul key={key++} className="my-3 list-disc space-y-1 pl-6 text-stone-700">{items}</ul>
        ),
      );
      list = null;
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      const cls =
        level === 1 ? 'mt-2 text-2xl font-semibold text-stone-900' : level === 2 ? 'mt-6 text-lg font-semibold text-stone-900' : 'mt-4 font-semibold text-stone-900';
      out.push(
        level === 1 ? (
          <h1 key={key++} id={id} className={cls}>{text}</h1>
        ) : level === 2 ? (
          <h2 key={key++} id={id} className={cls}>{text}</h2>
        ) : (
          <h3 key={key++} id={id} className={cls}>{text}</h3>
        ),
      );
    } else if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out;
}

export default async function PolicyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const policy = POLICY_FILES[slug];
  if (!policy) notFound();

  let markdown: string | null = null;
  let error: string | null = null;
  try {
    markdown = await fs.readFile(path.join(process.cwd(), 'data', 'policies', policy.file), 'utf8');
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not read policy.';
  }
  const published = await publishedAt(slug);

  return (
    <article className="mx-auto max-w-2xl rounded-lg border border-stone-200 bg-white p-6">
      <Link href="/store" className="text-xs text-stone-500 hover:text-stone-900">
        ← Back to shop
      </Link>
      {published ? (
        <p className="mt-3 text-xs text-stone-500">
          Published <time dateTime={published}>{new Date(published).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })}</time>
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {policy.title} is unavailable: {error}
        </div>
      ) : (
        <div className="mt-2">{renderMarkdown(markdown ?? '')}</div>
      )}
      <nav className="mt-8 flex gap-4 border-t border-stone-100 pt-4 text-sm" aria-label="Other policies">
        {Object.entries(POLICY_FILES)
          .filter(([s]) => s !== slug)
          .map(([s, p]) => (
            <Link key={s} href={`/store/policies/${s}`} className="text-stone-600 hover:text-stone-900">
              {p.title}
            </Link>
          ))}
      </nav>
    </article>
  );
}