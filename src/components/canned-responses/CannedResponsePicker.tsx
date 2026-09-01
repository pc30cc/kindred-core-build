/**
 * Phase 6 — Canned response picker for the Inbox composer.
 *
 * Two activation modes share this component:
 *  - Slash-trigger: detected by the parent on the textarea value (`/foo`
 *    at line start or after whitespace). Parent passes the live `query`
 *    plus the absolute `position` of the trigger so we can render anchored.
 *  - Toolbar button: parent opens with `query=''` and lets the user search
 *    inside the picker via its own search field.
 *
 * Keyboard contract:
 *  - ArrowUp / ArrowDown move highlight (wraps).
 *  - Enter / Tab inserts the highlighted row.
 *  - Esc dismisses.
 *  - The parent owns these key events on the textarea while the picker is
 *    open and forwards them via a ref.
 *
 * track-use:
 *  - This component NEVER calls track-use. Insertion happens in the parent
 *    composer; parent fires track-use only on actual send.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { useCannedResponses } from '@/hooks/useCannedResponses';
import type { CannedLocale, CannedResponse } from '@/lib/canned-responses-api';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Loader2, Search } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export interface CannedPickerHandle {
  /** Move highlight; returns true if handled. */
  moveHighlight: (delta: 1 | -1) => boolean;
  /** Insert currently highlighted row; returns true if a row was inserted. */
  commit: () => boolean;
}

interface Props {
  workspaceId: string | undefined;
  locale: CannedLocale;
  /** Live query (without leading '/' for slash mode). */
  query: string;
  /** Whether the picker should render results. */
  open: boolean;
  /** True when activated by slash trigger; hides the in-picker search box. */
  slashMode: boolean;
  onSelect: (row: CannedResponse) => void;
  onQueryChange?: (q: string) => void;
  onClose: () => void;
}

export const CannedResponsePicker = forwardRef<CannedPickerHandle, Props>(function CannedResponsePicker(
  { workspaceId, locale, query, open, slashMode, onSelect, onQueryChange, onClose },
  ref,
) {
  const { t } = useTranslation();
  const list = useCannedResponses({
    workspaceId,
    locale,
    q: query,
    limit: 8,
    enabled: open,
  });

  const items = useMemo(() => list.data?.items.filter((i) => i.is_active) ?? [], [list.data]);
  const [highlight, setHighlight] = useState(0);
  const itemsRef = useRef<(HTMLLIElement | null)[]>([]);

  // Reset highlight when results change.
  useEffect(() => {
    setHighlight(0);
  }, [items.length, query, locale]);

  // Keep highlighted item in view.
  useEffect(() => {
    itemsRef.current[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  useImperativeHandle(
    ref,
    () => ({
      moveHighlight: (delta) => {
        if (!open || items.length === 0) return false;
        setHighlight((h) => (h + delta + items.length) % items.length);
        return true;
      },
      commit: () => {
        if (!open || items.length === 0) return false;
        const row = items[highlight];
        if (!row) return false;
        onSelect(row);
        return true;
      },
    }),
    [open, items, highlight, onSelect],
  );

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label={t('canned.picker.ariaLabel')}
      className="absolute bottom-full mb-2 inset-x-2 z-30 rounded-lg border border-border bg-popover shadow-lg overflow-hidden text-popover-foreground"
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
    >
      {!slashMode && (
        <div className="relative border-b border-border/60">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            placeholder={t('canned.picker.searchPlaceholder')}
            className="ps-8 h-9 border-0 rounded-none bg-transparent focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % Math.max(1, items.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + items.length) % Math.max(1, items.length)); }
              else if (e.key === 'Enter' || e.key === 'Tab') {
                if (items[highlight]) { e.preventDefault(); onSelect(items[highlight]); }
              }
            }}
          />
        </div>
      )}

      <div className="max-h-72 overflow-y-auto">
        {list.isLoading ? (
          <div className="p-4 flex items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin me-2" /> {t('canned.picker.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {query ? t('canned.picker.noMatches', { query }) : t('canned.picker.empty')}
          </div>
        ) : (
          <ul>
            {items.map((row, idx) => {
              const isFallback = row.locale !== locale;
              const active = idx === highlight;
              return (
                <li
                  key={row.id}
                  ref={(el) => (itemsRef.current[idx] = el)}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => onSelect(row)}
                  className={cn(
                    'px-3 py-2 cursor-pointer flex items-start gap-3 border-b border-border/40 last:border-b-0',
                    active ? 'bg-accent/60' : 'hover:bg-accent/30',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-foreground font-mono">
                        /{row.shortcut}
                      </code>
                      <span className="text-sm font-medium text-foreground truncate">{row.title}</span>
                      {isFallback && (
                        <Badge variant="secondary" className="text-[10px] uppercase">{row.locale}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 whitespace-pre-wrap">
                      {row.body}
                    </p>
                  </div>
                  <div className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                    {row.usage_count > 0 ? `${row.usage_count}×` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-border/60 bg-muted/30 text-[10px] text-muted-foreground flex items-center justify-between">
        <span>{t('canned.picker.hint')}</span>
        <span>{items.length > 0 ? `${highlight + 1}/${items.length}` : ''}</span>
      </div>
    </div>
  );
});
