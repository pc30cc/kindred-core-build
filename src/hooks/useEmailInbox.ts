/**
 * React Query hooks for the Email Inbox feature (Gmail today, Yahoo Mail
 * planned) — mirrors useSeo.ts's shape.
 */
import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime/types';
import {
  asLeader,
  clearEmailCache,
  clearWorkspaceEmailCache,
  coordinatedFetch,
  cursorKey,
  dropEntries,
  dropLists,
  listKey,
  onEmailCacheMessage,
  readEntry,
  threadKey,
  writeEntry,
} from '@/lib/emailCache';
import {
  EmailInboxApiError,
  listEmailThreads,
  getEmailThread,
  getEmailChanges,
  type EmailThreadPage,
  type EmailThreadSummary,
  setEmailThreadRead,
  setEmailThreadStarred,
  sendEmail,
  getGmailConnection,
  startGmailOAuth,
  disconnectGmail,
  getYahooConnection,
  startYahooOAuth,
  disconnectYahoo,
  type SendEmailInput,
} from '@/lib/emailInbox-api';

type ThreadFilter = { unread?: boolean; starred?: boolean; q?: string };
type ThreadDetail = Awaited<ReturnType<typeof getEmailThread>>;

const LIST_FRESH_MS = 15_000;
const THREAD_FRESH_MS = 60_000;

function filterKeyOf(opts: ThreadFilter): string {
  return `${opts.unread ? 'u' : ''}${opts.starred ? 's' : ''}|${opts.q ?? ''}`;
}

/**
 * A thread body's cache version. Bodies never change once sent; only new or
 * deleted messages change what a thread shows, so read/star label changes do
 * not force a re-download.
 */
export function threadBodyVersion(thread: Pick<EmailThreadSummary, 'messageCount' | 'lastMessageAt'>): string | null {
  return thread.messageCount != null ? `${thread.messageCount}|${thread.lastMessageAt ?? ''}` : null;
}

/** The server says this mailbox is gone (disconnected / revoked): drop what this device kept. */
function forgetOnRevoked(err: unknown, scope: string | null): void {
  if (scope && err instanceof EmailInboxApiError && err.code === 'email_not_connected') void clearEmailCache(scope);
}

/**
 * Inbox pages: the device cache is shown first (placeholder), then Gmail's
 * current page replaces it. Pages are fetched on demand ("load more"); there
 * is no polling — realtime `email_mailbox_changed` events drive refreshes
 * (useEmailMailboxSync).
 */
export function useEmailThreads(workspaceId: string | undefined, scope: string | null, opts: ThreadFilter = {}) {
  const filter = filterKeyOf(opts);
  const firstKey = scope ? listKey(scope, `${filter}|`) : null;

  const cached = useQuery({
    queryKey: ['email-inbox-threads-cache', firstKey],
    queryFn: async () => (firstKey ? (await readEntry<EmailThreadPage>(firstKey))?.value ?? null : null),
    enabled: !!firstKey,
    staleTime: Infinity,
    gcTime: 60_000,
  });

  return useInfiniteQuery({
    queryKey: ['email-inbox-threads', workspaceId, filter, scope],
    initialPageParam: '',
    queryFn: async ({ pageParam }) => {
      const fetchPage = async () => {
        const page = await listEmailThreads(workspaceId!, { ...opts, pageToken: pageParam || undefined });
        return { value: page, version: page.historyId ?? null };
      };
      try {
        if (!scope) return (await fetchPage()).value;
        const page = await coordinatedFetch(scope, listKey(scope, `${filter}|${pageParam}`), fetchPage, { freshMs: LIST_FRESH_MS });
        if (!pageParam && page.historyId) {
          const current = await readEntry<string>(cursorKey(scope));
          if (!current) await writeEntry(scope, cursorKey(scope), page.historyId, page.historyId);
        }
        return page;
      } catch (err) {
        forgetOnRevoked(err, scope);
        throw err;
      }
    },
    getNextPageParam: (last) => last.nextPageToken || undefined,
    enabled: !!workspaceId,
    staleTime: 30_000,
    placeholderData: cached.data
      ? ({ pages: [cached.data], pageParams: [''] } as InfiniteData<EmailThreadPage, string>)
      : undefined,
  });
}

/**
 * One thread. A body cached on this device is reused without a request while
 * its version (see threadBodyVersion) matches the list row's.
 */
export function useEmailThread(
  workspaceId: string | undefined,
  scope: string | null,
  threadId: string | undefined,
  expectVersion: string | null = null,
) {
  const key = scope && threadId ? threadKey(scope, threadId) : null;
  const cached = useQuery({
    queryKey: ['email-inbox-thread-cache', key],
    queryFn: async () => (key ? (await readEntry<ThreadDetail>(key))?.value ?? null : null),
    enabled: !!key,
    staleTime: Infinity,
    gcTime: 60_000,
  });

  return useQuery({
    queryKey: ['email-inbox-thread', workspaceId, threadId, scope],
    queryFn: async () => {
      const fetchThread = async () => {
        const detail = await getEmailThread(workspaceId!, threadId!);
        return { value: detail, version: threadBodyVersion(detail.thread) };
      };
      try {
        if (!scope) return (await fetchThread()).value;
        return await coordinatedFetch(scope, threadKey(scope, threadId!), fetchThread, {
          freshMs: THREAD_FRESH_MS,
          expectVersion,
        });
      } catch (err) {
        forgetOnRevoked(err, scope);
        throw err;
      }
    },
    enabled: !!workspaceId && !!threadId,
    staleTime: Infinity,
    placeholderData: cached.data ?? undefined,
  });
}

/**
 * Keeps an open inbox current without polling: one realtime subscription
 * (the workspace inbox channel already used by the app) carries
 * `email_mailbox_changed` — a cursor, never content. One tab (the Web Lock
 * leader) asks `/changes` since the stored cursor; if anything changed, list
 * pages are dropped and every tab re-reads page one, the others getting the
 * leader's copy from IndexedDB instead of the network.
 */
export function useEmailMailboxSync(workspaceId: string | undefined, scope: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId || !scope) return;
    const refreshLists = () => void qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });

    const offCache = onEmailCacheMessage((msg) => {
      if (msg.type === 'stored') return;
      if (msg.scope === null || msg.scope === scope) {
        refreshLists();
        if (msg.type === 'cleared') void qc.invalidateQueries({ queryKey: ['email-inbox-thread', workspaceId] });
      }
    });

    let cancelled = false;
    let subscription: RealtimeSubscription | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const onChanged = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void asLeader(scope, async () => {
          const cursor = (await readEntry<string>(cursorKey(scope)))?.value;
          if (!cursor) {
            await dropLists(scope);
            refreshLists();
            return;
          }
          try {
            const changes = await getEmailChanges(workspaceId, cursor);
            if (changes.historyId) await writeEntry(scope, cursorKey(scope), changes.historyId, changes.historyId);
            if (changes.reset || changes.threadIds.length) {
              await dropLists(scope);
              refreshLists();
            }
          } catch (err) {
            forgetOnRevoked(err, scope);
          }
        });
      }, 1_500);
    };

    void (async () => {
      const provider = await resolveClientRealtimeProvider(workspaceId);
      if (cancelled) return;
      const sub = await provider.subscribe(`ws:${workspaceId}:inbox`, {
        onEvent: (payload) => {
          if (payload?.kind === 'email_mailbox_changed' && payload.workspace_id === workspaceId) onChanged();
        },
      });
      if (cancelled) sub.unsubscribe();
      else subscription = sub;
    })().catch(() => { /* no realtime: the list still refreshes on focus and on demand */ });

    return () => {
      cancelled = true;
      offCache();
      if (debounce) clearTimeout(debounce);
      subscription?.unsubscribe();
    };
  }, [workspaceId, scope, qc]);
}

/** Applies a label change to the in-memory list and thread without refetching. */
function patchThreadEverywhere(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string | undefined,
  threadId: string,
  patch: Partial<Pick<EmailThreadSummary, 'isRead' | 'isStarred'>>,
): void {
  qc.setQueriesData<InfiniteData<EmailThreadPage, string>>({ queryKey: ['email-inbox-threads', workspaceId] }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, threads: p.threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t)) })) }
      : data,
  );
  qc.setQueriesData<ThreadDetail>({ queryKey: ['email-inbox-thread', workspaceId, threadId] }, (data) =>
    data ? { ...data, thread: { ...data.thread, ...patch } } : data,
  );
}

export function useSetEmailThreadRead(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, isRead }: { threadId: string; isRead: boolean }) =>
      setEmailThreadRead(workspaceId!, threadId, isRead),
    onSuccess: (_data, { threadId, isRead }) => {
      patchThreadEverywhere(qc, workspaceId, threadId, { isRead });
    },
  });
}

export function useSetEmailThreadStarred(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, starred }: { threadId: string; starred: boolean }) =>
      setEmailThreadStarred(workspaceId!, threadId, starred),
    onSuccess: (_data, { threadId, starred }) => {
      patchThreadEverywhere(qc, workspaceId, threadId, { isStarred: starred });
    },
  });
}

export function useSendEmail(workspaceId?: string, scope: string | null = null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendEmailInput) => sendEmail(workspaceId!, input),
    onSuccess: async (_data, variables) => {
      // The sent reply exists only in Gmail: drop this device's copies so the
      // next read picks it up.
      if (scope) {
        await dropLists(scope);
        if (variables.threadId) await dropEntries(scope, [threadKey(scope, variables.threadId)]);
      }
      qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
      if (variables.threadId) {
        qc.invalidateQueries({ queryKey: ['email-inbox-thread', workspaceId, variables.threadId] });
      }
    },
  });
}

export function useGmailConnection(workspaceId?: string) {
  return useQuery({
    queryKey: ['gmail-connection', workspaceId],
    queryFn: () => getGmailConnection(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useStartGmailOAuth(workspaceId?: string) {
  return useMutation({
    mutationFn: () => startGmailOAuth(workspaceId!),
  });
}

export function useDisconnectGmail(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectGmail(workspaceId!),
    onSuccess: () => {
      if (workspaceId) void clearWorkspaceEmailCache(workspaceId);
      qc.invalidateQueries({ queryKey: ['gmail-connection', workspaceId] });
    },
  });
}

export function useYahooConnection(workspaceId?: string) {
  return useQuery({
    queryKey: ['yahoo-connection', workspaceId],
    queryFn: () => getYahooConnection(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useStartYahooOAuth(workspaceId?: string) {
  return useMutation({
    mutationFn: () => startYahooOAuth(workspaceId!),
  });
}

export function useDisconnectYahoo(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectYahoo(workspaceId!),
    onSuccess: () => {
      if (workspaceId) void clearWorkspaceEmailCache(workspaceId);
      qc.invalidateQueries({ queryKey: ['yahoo-connection', workspaceId] });
    },
  });
}
