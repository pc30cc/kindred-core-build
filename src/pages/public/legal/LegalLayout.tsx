import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { LEGAL_CHROME } from './legalDocuments';

/**
 * The frame of the public English pages — the privacy policy, the terms of
 * use and the contact page: the brand above, the three links below, and the
 * page in one readable column between. Laid out as the site's own pages are.
 */
export function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div
      dir="ltr"
      lang="en"
      // The app turns every digit Persian while its own language is Persian
      // (lib/persian-digits); these pages keep "September 1, 2026".
      data-latin-digits=""
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-5 py-4">
          <BrandLogo className="h-8 w-8 rounded-lg" alt={LEGAL_CHROME.brand} />
          <span className="text-base font-bold text-foreground">{LEGAL_CHROME.brand}</span>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-5 py-16 text-start sm:py-24">{children}</div>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-5 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>{LEGAL_CHROME.copyright}</span>
          <nav className="flex items-center gap-4">
            <Link to="/contact" className="hover:text-foreground">
              {LEGAL_CHROME.contact}
            </Link>
            <Link to="/terms" className="hover:text-foreground">
              {LEGAL_CHROME.terms}
            </Link>
            <Link to="/privacy" className="hover:text-foreground">
              {LEGAL_CHROME.privacy}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
