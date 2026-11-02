/**
 * What a colleague call's failure says, in words (TEAM_CALLS.md: the apps
 * show each refusal as a failed call; the web panel names it). Maps the
 * API's answers (server/routes/teamCalls.ts) and the browser's own failures
 * (a microphone the member blocked, no network) onto `teamCall.errors.*`.
 */
import type { TranslationKey } from '@/i18n';
import { TeamCallApiError } from '@/lib/team-calls-api';

export function teamCallErrorKey(err: unknown): TranslationKey {
  if (err instanceof TeamCallApiError) {
    const body = err.body;
    switch (err.code) {
      case 'callee_busy':
        return 'teamCall.errors.calleeBusy';
      case 'caller_busy':
        return 'teamCall.errors.callerBusy';
      case 'too_many_calls':
        return 'teamCall.errors.tooManyCalls';
      case 'limit_reached':
        if (body.reason === 'usage_unavailable') return 'teamCall.errors.usageUnavailable';
        return body.limit === 'max_call_minutes_per_month'
          ? 'teamCall.errors.limitMinutes'
          : 'teamCall.errors.limitConcurrent';
      case 'upgrade_required':
        // `reason: runtime`: the plan has it, the platform's or workspace's
        // switches do not; a `capability` names the channel the plan lacks.
        if (body.reason === 'runtime') return 'teamCall.errors.channelSwitchedOff';
        return typeof body.capability === 'string'
          ? 'teamCall.errors.channelNotInPlan'
          : 'teamCall.errors.upgradeRequired';
      case 'not_a_member':
        return 'teamCall.errors.notAMember';
      case 'entitlement_status_unavailable':
        return 'teamCall.errors.planUnavailable';
      case 'provider_not_ready':
        return 'teamCall.errors.providerNotReady';
      case 'network':
        return 'teamCall.errors.network';
      case 'not_connected':
      case 'token_mint_failed':
      case 'turn_missing':
      case 'room_create_failed':
        return 'teamCall.errors.connectFailed';
      default:
        return 'teamCall.errors.generic';
    }
  }
  const name = (err as { name?: unknown } | null)?.name;
  const message = String((err as { message?: unknown } | null)?.message ?? '');
  if (name === 'NotAllowedError' || /permission denied|not allowed/i.test(message)) {
    return 'teamCall.errors.microphoneBlocked';
  }
  return 'teamCall.errors.generic';
}
