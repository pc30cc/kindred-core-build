/**
 * React Query hooks for the Email Inbox feature (Gmail today, Yahoo Mail
 * planned) — mirrors useSeo.ts's shape.
 */
import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime/types';
import {
  asLeader,
  cacheEpoch,
  clearEmailCache,
  clearWorkspaceEmailCache,
  coordinatedFetch,
  cursorKey,
  dropEntries,
  dropLists,
  dropThreads,
  patchEntry,
  patchLists,
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
type ThreadFlags = Pick<EmailThreadSummary, 'isRead' | 'isStarred'>;

const LIST_FRESH_MS = 15_000;
const THREAD_FRESH_MS = 60_000;
/** Table-backed (Yahoo) inbox: the server has the data, so polling it is cheap and is its only update signal. */
const TABLE_INBOX_POLL_MS = 30_000;
/** Live (Gmail) inbox without an open realtime connection: ask for changes (ids only) at this pace while visible. */
const CHANGES_FALLBACK_MS = 60_000;

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
 * Inbox pages.
 *
 * Live (Gmail, `scope` set): the device cache is shown first (placeholder),
 * then Gmail's current page replaces it. Pages load on demand; there is no
 * polling — realtime `email_mailbox_changed` drives refreshes
 * (useEmailMailboxSync).
 *
 * Table-backed (Yahoo, `scope` null): read from the server and polled, as before.
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
        const startedAt = cacheEpoch();
        const page = await coordinatedFetch(scope, listKey(scope, `${filter}|${pageParam}`), fetchPage, { freshMs: LIST_FRESH_MS });
        if (!pageParam && page.historyId) {
          const current = await readEntry<string>(cursorKey(scope));
          if (!current) await writeEntry(scope, cursorKey(scope), page.historyId, page.historyId, startedAt);
        }
        return page;
      } catch (err) {
        forgetOnRevoked(err, scope);
        throw err;
      }
    },
    getNextPageParam: (last) => last.nextPageToken || undefined,
    enabled: !!workspaceId,
    staleTime: scope ? 30_000 : 0,
    refetchInterval: scope ? false : TABLE_INBOX_POLL_MS,
    placeholderData: cached.data
      ? ({ pages: [cached.data], pageParams: [''] } as InfiniteData<EmailThreadPage, string>)
      : undefined,
  });
}

/**
 * One thread. Live: a body cached on this device is reused without a request
 * while its version (see threadBodyVersion) matches the current list row's;
 * the row's read/star flags win over the cached copy's. Table-backed: read
 * from the server whenever it is opened.
 */
export function useEmailThread(
  workspaceId: string | undefined,
  scope: string | null,
  threadId: string | undefined,
  row: (ThreadFlags & { version: string | null }) | null = null,
) {
  const expectVersion = row?.version ?? null;
  // Read by the query function at fetch time: the key stays stable when the
  // row changes, so an open thread (and a reply being typed under it) is never
  // swapped for an empty query — it refetches in place instead (below).
  const expectVersionRef = useRef(expectVersion);
  expectVersionRef.current = expectVersion;
  // The version on screen: a refetch asked for because the row moved on must
  // not be answered with this same copy from the cache.
  const shownVersionRef = useRef<string | null>(null);
  const key = scope && threadId ? threadKey(scope, threadId) : null;
  const cached = useQuery({
    queryKey: ['email-inbox-thread-cache', key],
    queryFn: async () => (key ? (await readEntry<ThreadDetail>(key))?.value ?? null : null),
    enabled: !!key,
    staleTime: Infinity,
    gcTime: 60_000,
  });

  const query = useQuery({
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
          expectVersion: expectVersionRef.current,
          staleVersion: shownVersionRef.current,
        });
      } catch (err) {
        forgetOnRevoked(err, scope);
        throw err;
      }
    },
    enabled: !!workspaceId && !!threadId,
    staleTime: scope ? Infinity : 0,
    placeholderData: cached.data ?? undefined,
    select: (data: ThreadDetail) =>
      row ? { ...data, thread: { ...data.thread, isRead: row.isRead, isStarred: row.isStarred } } : data,
  });

  // The list row now says the thread has other messages than the ones shown:
  // re-read it (from another tab's fresh copy, or Gmail) without blanking it.
  // Once per new row version, so a row that never matches cannot loop.
  const shownVersion = query.data ? threadBodyVersion(query.data.thread) : null;
  shownVersionRef.current = shownVersion;
  const refetchedFor = useRef<string | null>(null);
  const { refetch, isFetching } = query;
  useEffect(() => {
    if (!scope || !expectVersion || !shownVersion || expectVersion === shownVersion || isFetching) return;
    if (refetchedFor.current === expectVersion) return;
    refetchedFor.current = expectVersion;
    void refetch();
  }, [scope, expectVersion, shownVersion, isFetching, refetch]);

  return query;
}

/**
 * Keeps an open live inbox current without polling Gmail: one realtime
 * subscription (the workspace inbox channel the app already uses) carries
 * `email_mailbox_changed` — a cursor, never content. One tab (the Web Lock
 * leader) asks `/changes` since the stored cursor; changed threads lose their
 * cached body, list pages are dropped, and every tab re-reads page one, the
 * others getting the leader's copy from IndexedDB instead of the network.
 * Without an open realtime connection, the same `/changes` check (ids only)
 * runs every CHANGES_FALLBACK_MS while the page is visible.
 */
export function useEmailMailboxSync(workspaceId: string | undefined, scope: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId || !scope) return;
    const refreshLists = () => void qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
    const refreshThreads = (ids: string[] | null) =>
      void qc.invalidateQueries({
        queryKey: ['email-inbox-thread', workspaceId],
        predicate: (q) => ids === null || ids.includes(String(q.queryKey[2])),
      });

    const offCache = onEmailCacheMessage((msg) => {
      if (msg.type === 'stored' || msg.type === 'invalidating') return;
      if (msg.scope === null || msg.scope === scope) {
        refreshLists();
        if (msg.type === 'cleared') {
          // Another tab found the mailbox disconnected or revoked: re-ask
          // whether it is connected rather than re-reading a gone inbox.
          void qc.invalidateQueries({ queryKey: ['gmail-connection', workspaceId] });
          refreshThreads(null);
        }
        if (msg.type === 'dropped') {
          const ids = msg.keys.filter((k) => k.startsWith(`${scope}|thread|`)).map((k) => k.slice(`${scope}|thread|`.length));
          if (ids.length) refreshThreads(ids);
        }
      }
    });

    let cancelled = false;
    let realtimeOpen = false;
    let everOpened = false;
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
            const startedAt = cacheEpoch();
            const changes = await getEmailChanges(workspaceId, cursor);
            if (changes.historyId) await writeEntry(scope, cursorKey(scope), changes.historyId, changes.historyId, startedAt);
            if (changes.reset) {
              await dropLists(scope);
              await dropThreads(scope);
              refreshLists();
              refreshThreads(null);
              return;
            }
            // Only added/removed messages outdate a cached body; read/star
            // (including this app's own mark-as-read echoing back) only
            // change list rows, which carry those flags.
            const contentIds = changes.contentThreadIds ?? changes.threadIds;
            if (contentIds.length) {
              await dropEntries(scope, contentIds.map((id) => threadKey(scope, id)));
              refreshThreads(contentIds);
            }
            if (changes.threadIds.length) {
              await dropLists(scope);
              refreshLists();
            }
          } catch (err) {
            forgetOnRevoked(err, scope);
          }
        });
      }, 1_500);
    };

    const fallback = setInterval(() => {
      if (!realtimeOpen && typeof document !== 'undefined' && document.visibilityState === 'visible') onChanged();
    }, CHANGES_FALLBACK_MS);

    void (async () => {
      const provider = await resolveClientRealtimeProvider(workspaceId);
      if (cancelled) return;
      // The polling/disabled adapters report 'open' but deliver no events:
      // only a push transport replaces the fallback check.
      const pushCapable = provider.vendor === 'centrifugo' || provider.vendor === 'supabase';
      const sub = await provider.subscribe(`ws:${workspaceId}:inbox`, {
        onEvent: (payload) => {
          // This sync serves the live (Gmail) mailbox only: a Yahoo mailbox's
          // signal is not a change here (the Yahoo list keeps its polling).
          if (payload?.provider && payload.provider !== 'gmail') return;
          if (payload?.kind === 'email_mailbox_changed' && payload.workspace_id === workspaceId) onChanged();
        },
        onStatus: (status) => {
          const wasOpen = realtimeOpen;
          realtimeOpen = pushCapable && status === 'open';
          // Catch up on anything missed while the connection was down.
          if (realtimeOpen && !wasOpen && everOpened) onChanged();
          if (realtimeOpen) everOpened = true;
        },
      });
      if (cancelled) sub.unsubscribe();
      else subscription = sub;
    })().catch(() => { /* no realtime: the fallback check above keeps the inbox current */ });

    return () => {
      cancelled = true;
      offCache();
      clearInterval(fallback);
      if (debounce) clearTimeout(debounce);
      subscription?.unsubscribe();
    };
  }, [workspaceId, scope, qc]);
}

/** Applies a label change in memory and in this device's cached copy, without refetching. */
function patchThreadEverywhere(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string | undefined,
  scope: string | null,
  threadId: string,
  patch: Partial<ThreadFlags>,
): void {
  qc.setQueriesData<InfiniteData<EmailThreadPage, string>>({ queryKey: ['email-inbox-threads', workspaceId] }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, threads: p.threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t)) })) }
      : data,
  );
  qc.setQueriesData<ThreadDetail>({ queryKey: ['email-inbox-thread', workspaceId, threadId] }, (data) =>
    data ? { ...data, thread: { ...data.thread, ...patch } } : data,
  );
  if (scope) {
    void patchEntry<ThreadDetail>(scope, threadKey(scope, threadId), (v) => ({ ...v, thread: { ...v.thread, ...patch } }));
    void patchLists<EmailThreadPage>(scope, (page) => ({
      ...page,
      threads: page.threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t)),
    }));
  }
}

export function useSetEmailThreadRead(workspaceId?: string, scope: string | null = null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, isRead }: { threadId: string; isRead: boolean }) =>
      setEmailThreadRead(workspaceId!, threadId, isRead),
    onSuccess: (_data, { threadId, isRead }) => {
      patchThreadEverywhere(qc, workspaceId, scope, threadId, { isRead });
      if (!scope) qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
    },
  });
}

export function useSetEmailThreadStarred(workspaceId?: string, scope: string | null = null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, starred }: { threadId: string; starred: boolean }) =>
      setEmailThreadStarred(workspaceId!, threadId, starred),
    onSuccess: (_data, { threadId, starred }) => {
      patchThreadEverywhere(qc, workspaceId, scope, threadId, { isStarred: starred });
      if (!scope) qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
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
