/**
 * ADMIN — STORAGE section shell.
 *
 * Storage now holds two INDEPENDENT topologies, so the one "Storage" entry
 * in Providers opens onto two tabs rather than one panel:
 *
 *   Storage pool      — the general primary + mirrors that serve attachments,
 *                       avatars, recordings and workspace files.
 *   Analytics Storage — the Parquet lake under `analytics/`, with its own
 *                       primary and its own replicas.
 *
 * They live next to each other because they share vendor CREDENTIALS and an
 * operator configures those once. They are separate tabs, not one merged
 * screen, because everything else about them is independent: changing a
 * primary on one tab has no effect on the other, and mixing the two states
 * into a single view is exactly how an operator would come to believe
 * otherwise.
 */

import { useState } from 'react';
import { BarChart3, HardDrive } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { AdminStorageProvidersPanel } from './AdminStorageProvidersPanel';
import { AdminAnalyticsStoragePanel } from './AdminAnalyticsStoragePanel';

type StorageTab = 'pool' | 'analytics';

export function AdminStorageSection() {
  const { t } = useI18n();
  const [tab, setTab] = useState<StorageTab>('pool');

  const tabs: { key: StorageTab; label: string; icon: typeof HardDrive }[] = [
    { key: 'pool', label: t('analyticsStorage.tabs.pool'), icon: HardDrive },
    { key: 'analytics', label: t('analyticsStorage.tabs.analytics'), icon: BarChart3 },
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={t('analyticsStorage.tabs.label')}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/20 p-1"
      >
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              tab === key
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'pool' ? <AdminStorageProvidersPanel /> : <AdminAnalyticsStoragePanel />}
    </div>
  );
}
