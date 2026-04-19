import { useNavigate } from 'react-router-dom';
import { useState, FormEvent } from 'react';
import type { Locale } from '@/i18n/config';

const PLACEHOLDERS: Record<Locale, string> = {
  en: 'Search articles…',
  fa: 'جست‌وجو در مقالات…',
  tr: 'Makalelerde ara…',
};

export function KbSearchBox({ locale, initial }: { locale: Locale; initial?: string }) {
  const nav = useNavigate();
  const [q, setQ] = useState(initial || '');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    nav(`/help/${locale}/search?q=${encodeURIComponent(trimmed)}`);
  };
  return (
    <form onSubmit={onSubmit} role="search" aria-label="KB search">
      <input
        type="search"
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={PLACEHOLDERS[locale]}
        className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </form>
  );
}