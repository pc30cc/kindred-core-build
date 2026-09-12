/**
 * React Query hooks for the Email Inbox feature (Gmail today, Yahoo Mail
 * planned) — mirrors useSeo.ts's shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listEmailThreads,
  getEmailThread,
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

export function useEmailThreads(
  workspaceId?: string,
  opts: { unread?: boolean; starred?: boolean; q?: string } = {},
) {
  return useQuery({
    queryKey: ['email-inbox-threads', workspaceId, opts.unread, opts.starred, opts.q],
    queryFn: () => listEmailThreads(workspaceId!, opts),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
  });
}

export function useEmailThread(workspaceId?: string, threadId?: string) {
  return useQuery({
    queryKey: ['email-inbox-thread', workspaceId, threadId],
    queryFn: () => getEmailThread(workspaceId!, threadId!),
    enabled: !!workspaceId && !!threadId,
  });
}

export function useSetEmailThreadRead(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, isRead }: { threadId: string; isRead: boolean }) =>
      setEmailThreadRead(workspaceId!, threadId, isRead),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
    },
  });
}

export function useSetEmailThreadStarred(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, starred }: { threadId: string; starred: boolean }) =>
      setEmailThreadStarred(workspaceId!, threadId, starred),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-inbox-threads', workspaceId] });
    },
  });
}

export function useSendEmail(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendEmailInput) => sendEmail(workspaceId!, input),
    onSuccess: (_data, variables) => {
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
      qc.invalidateQueries({ queryKey: ['yahoo-connection', workspaceId] });
    },
  });
}
