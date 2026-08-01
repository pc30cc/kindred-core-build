/**
 * Generic phone-verification hooks. They work for any registered purpose;
 * the backend resolves the verification subject, so the client only supplies
 * the purpose plus workspace context.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  checkPhoneVerification,
  getPhoneVerificationStatus,
  resendPhoneVerification,
  startPhoneVerification,
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
  return useMutation({ mutationFn: () => resendPhoneVerification(ctx) });
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