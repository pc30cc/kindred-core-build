/**
 * "(3) " in front of the browser tab's title while the Inbox has unread
 * chats (useInboxUnread), so an operator whose panel is open in a background
 * tab sees that a visitor wrote, as every web mail and chat app does. Capped
 * at "(99+) ", and gone at zero.
 *
 * The title has another writer: PlatformBrandingGate sets the platform's
 * localized title whenever the branding or the language changes, and would
 * wipe the prefix. Rather than tie the two together, the prefix is put back
 * whenever the title changes (a MutationObserver on <head>); writing only
 * when the title differs from what it should be is what keeps the observer
 * from waking itself in a loop.
 *
 * In Persian the count is written with Persian digits, as every number in the
 * panel is: the digits layer (lib/persian-digits) converts the page's body
 * only, never the title.
 */
import { useEffect } from 'react';
import { toPersianDigits } from '@/lib/persian-digits';

/** Ours, in either digits (the language may change while it is up). */
const PREFIX = /^\([0-9۰-۹]+\+?\) /;

/** The title without this hook's prefix. */
export function titleBase(title: string): string {
  return title.replace(PREFIX, '');
}

/** The title as it should read with `count` unread chats. */
export function titleWithUnread(title: string, count: number, persianDigits = false): string {
  const base = titleBase(title);
  if (!(count > 0)) return base;
  const n = count > 99 ? '99+' : String(count);
  return `(${persianDigits ? toPersianDigits(n) : n}) ${base}`;
}

export function useInboxTabTitle(count: number, persianDigits = false): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = () => {
      const next = titleWithUnread(document.title, count, persianDigits);
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(apply);
    if (observer && document.head) {
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      observer?.disconnect();
      const base = titleBase(document.title);
      if (document.title !== base) document.title = base;
    };
  }, [count, persianDigits]);
}
