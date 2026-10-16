/**
 * Generic phone-verification hooks. They work for any registered purpose;
 * the backend resolves the verification subject, so the client only supplies
 * the purpose plus workspace context.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  checkPhoneVerification,
  cancelPhoneVerification,
  getPhoneVerificationDelivery,
  getPhoneVerificationStatus,
  resendPhoneVerification,
  startPhoneVerification,
  type PhoneDeliveryChannel,
  type PhoneDeliveryState,
  type PhoneVerificationContext,
  type PhoneVerificationStatus,
} from '@/lib/api';

export const phoneVerificationStatusKey = (ctx: PhoneVerificationContext) => [
  'phone-verification-status',
  ctx.purpose,
  ctx.workspaceId ?? ctx.workspaceSlug ?? null,
];

export function usePhoneVerificationStatus(ctx: PhoneVerificationContext, enabled = true) {
  return useQuery<PhoneVerificationStatus>({
    queryKey: phoneVerificationStatusKey(ctx),
    queryFn: () => getPhoneVerificationStatus(ctx),
    enabled: enabled && Boolean(ctx.workspaceId || ctx.workspaceSlug),
    staleTime: 15_000,
  });
}

export function useStartPhoneVerification(ctx: PhoneVerificationContext) {
  return useMutation({
    mutationFn: (input: { phone: string; country: string }) =>
      startPhoneVerification({ ...ctx, ...input }),
  });
}

export function useResendPhoneVerification(ctx: PhoneVerificationContext) {
  return useMutation({
    mutationFn: (channel?: PhoneDeliveryChannel) => resendPhoneVerification(ctx, channel),
  });
}

/** How long after a send the screen keeps asking whether the code arrived. */
export const DELIVERY_WATCH_MS = 90_000;
const DELIVERY_POLL_MS = 5_000;

/**
 * Polls the delivery state of one code for about a minute and a half after
 * it was sent, and stops at an answer ('delivered' or 'failed'). Lets the
 * screen offer a voice call as soon as an SMS is known to have failed.
 */
export function usePhoneDeliveryState(
  ctx: PhoneVerificationContext,
  challengeId: string | null,
  sentAt: number | null,
) {
  return useQuery<{ state: PhoneDeliveryState }>({
    queryKey: ['phone-verification-delivery', ctx.purpose, ctx.workspaceId ?? ctx.workspaceSlug ?? null, challengeId],
    queryFn: () => getPhoneVerificationDelivery({ ...ctx, challengeId: challengeId ?? '' }),
    enabled: Boolean(challengeId && sentAt && (ctx.workspaceId || ctx.workspaceSlug)),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === 'delivered' || state === 'failed') return false;
      if (!sentAt || Date.now() - sentAt > DELIVERY_WATCH_MS) return false;
      return DELIVERY_POLL_MS;
    },
  });
}

/**
 * "Change number" must kill the outstanding code server-side; clearing local
 * state alone would leave a usable OTP in flight.
 */
export function useCancelPhoneVerification(ctx: PhoneVerificationContext) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { challengeId?: string | null }) =>
      cancelPhoneVerification({ ...ctx, challengeId: input?.challengeId ?? null }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: phoneVerificationStatusKey(ctx) });
    },
  });
}

export function useCheckPhoneVerification(ctx: PhoneVerificationContext) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { challengeId: string; code: string }) =>
      checkPhoneVerification({ ...ctx, ...input }),
    onSuccess: () => {
      // Unlock the gated surface without a full page reload.
      qc.invalidateQueries({ queryKey: phoneVerificationStatusKey(ctx) });
      qc.invalidateQueries({ queryKey: ['widget-settings'] });
      qc.invalidateQueries({ queryKey: ['workspace'] });
    },
  });
}