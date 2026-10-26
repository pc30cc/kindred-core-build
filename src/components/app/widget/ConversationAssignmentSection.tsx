/**
 * Widget → Behaviour → Conversation assignment: how chat routing gives a
 * conversation to an operator (server/services/chatRouting.ts, migration
 * 278), in words that match what it does:
 *
 *   - the mode (auto / round robin / manual) with what each one does, the
 *     plan lock (a plan without `widget_assignment_routing` routes as Manual,
 *     server and panel alike);
 *   - "Return returning visitors to the same operator" and its window in
 *     days (also what decides whether a reopened conversation keeps its
 *     operator), greyed out when the Super Admin turned it off platform-wide;
 *   - the default maximum of open conversations per operator (members may
 *     have their own in Team & departments);
 *   - the first-response timeout in minutes (0 = off; automatic assignments
 *     only);
 *   - closing a quiet conversation after 1 to 48 hours (migration 284;
 *     shared/inactivityClose.ts), or the Super Admin's default (null). It
 *     applies to every plan and every mode, so neither the plan lock nor
 *     Manual greys it out: only the Super Admin's platform switch does.
 *
 * Numbers save on blur or Enter, only when valid; a refused save is undone
 * and said.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { useChatRoutingPolicy } from '@/hooks/useChatRouting';
import {
  CHAT_CAPACITY_MAX,
  CHAT_CAPACITY_MIN,
  DEFAULT_CHAT_CAPACITY,
  DEFAULT_FIRST_RESPONSE_TIMEOUT_MINUTES,
  DEFAULT_LAST_AGENT_WINDOW_DAYS,
  FIRST_RESPONSE_TIMEOUT_MAX,
  FIRST_RESPONSE_TIMEOUT_MIN,
  INACTIVITY_CLOSE_MAX_HOURS,
  INACTIVITY_CLOSE_MIN_HOURS,
  LAST_AGENT_WINDOW_MAX,
  LAST_AGENT_WINDOW_MIN,
} from '@/lib/chat-routing-api';
import { effectiveInactivityCloseHours } from '../../../../shared/inactivityClose';
import type { WidgetSettings } from '@/types/models';
import { NumberSetting } from './NumberSetting';

type AssignmentFields = Pick<
  WidgetSettings,
  | 'assignment_mode'
  | 'last_agent_routing_enabled'
  | 'last_agent_window_days'
  | 'default_max_concurrent_chats'
  | 'first_response_timeout_minutes'
  | 'inactivity_close_hours'
>;

type AssignmentMode = NonNullable<WidgetSettings['assignment_mode']>;

export interface ConversationAssignmentSectionProps {
  workspaceId: string | undefined;
  settings: Partial<AssignmentFields> | undefined;
  /** The plan's `widget_assignment_routing`. Without it: Manual, locked. */
  planAllowsRouting: boolean;
  /**
   * Saves a patch of widget settings. A rejection undoes the change here and
   * says so; resolving `false` undoes it silently (the caller's save layer,
   * useWidgetSettingsDraft, has said why already).
   */
  onSave: (patch: Partial<AssignmentFields>) => Promise<unknown>;
  /** Where Team & departments lives, for the per-member settings link. */
  teamPath?: string;
}

export function ConversationAssignmentSection({
  workspaceId,
  settings,
  planAllowsRouting,
  onSave,
  teamPath,
}: ConversationAssignmentSectionProps) {
  const { t } = useTranslation();
  const { data: platform } = useChatRoutingPolicy(workspaceId);
  // What was just changed here, until the save settles (the switches and
  // the select show it at once).
  const [draft, setDraft] = useState<Partial<AssignmentFields>>({});

  const save = async (patch: Partial<AssignmentFields>) => {
    setDraft((d) => ({ ...d, ...patch }));
    const clear = () => setDraft((d) => {
      const next = { ...d };
      for (const key of Object.keys(patch) as Array<keyof AssignmentFields>) delete next[key];
      return next;
    });
    try {
      await onSave(patch);
      clear();
    } catch (err) {
      clear();
      toast({
        title: t('widgetPage.behavior.assignment.saveFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const value = <K extends keyof AssignmentFields>(key: K): AssignmentFields[K] | undefined =>
    (key in draft ? draft[key] : settings?.[key]) as AssignmentFields[K] | undefined;

  const storedMode: AssignmentMode = value('assignment_mode') || 'auto';
  const mode: AssignmentMode = planAllowsRouting ? storedMode : 'manual';
  const automatic = mode !== 'manual';
  const platformLastAgent = platform?.last_agent_routing_enabled !== false;
  const lastAgentOn = platformLastAgent && value('last_agent_routing_enabled') !== false;
  const windowDays = value('last_agent_window_days') ?? DEFAULT_LAST_AGENT_WINDOW_DAYS;
  const capacity = value('default_max_concurrent_chats') ?? DEFAULT_CHAT_CAPACITY;
  const timeout = value('first_response_timeout_minutes') ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MINUTES;
  const locked = !planAllowsRouting;
  // The inactivity close: the workspace's own hours, or (null) the platform
  // default, which an older server does not send (24 then).
  const platformDefaultHours = effectiveInactivityCloseHours(null, platform?.inactivity_close_default_hours);
  const ownHours = value('inactivity_close_hours') ?? null;
  const inactivityHours = effectiveInactivityCloseHours(ownHours, platformDefaultHours);
  const inactivityOff = platform?.inactivity_close_enabled === false;

  const modeHelp = mode === 'auto'
    ? t('widgetPage.behavior.assignment.helpAuto')
    : mode === 'round_robin'
      ? t('widgetPage.behavior.assignment.helpRoundRobin')
      : t('widgetPage.behavior.assignment.helpManual');

  const teamLink = teamPath
    ? <Link to={teamPath} className="text-primary hover:underline">{t('widgetPage.behavior.assignment.teamLink')}</Link>
    : t('widgetPage.behavior.assignment.teamLink');

  return (
    <div className="pt-4 mt-2 border-t border-border space-y-3" data-conversation-assignment>
      <div className="flex items-start gap-3 min-w-0">
        <div className="p-2 rounded-lg bg-primary/10 shrink-0">
          <Users className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <Label className="text-sm" htmlFor="assignment-mode">{t('widgetPage.behavior.assignmentMode')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('widgetPage.behavior.assignmentModeHint')}{' '}
              {t('widgetPage.behavior.assignment.whoBefore')}
              {teamLink}
              {t('widgetPage.behavior.assignment.whoAfter')}
            </p>
            {locked && (
              <p className="text-xs text-primary mt-1" data-assignment-locked>{t('plan.locked.upgradeHint')}</p>
            )}
          </div>

          <Select
            disabled={locked}
            value={mode}
            onValueChange={(v) => void save({ assignment_mode: v as AssignmentMode })}
          >
            <SelectTrigger id="assignment-mode" className="w-full sm:w-80"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('widgetPage.behavior.assignmentModeAuto')}</SelectItem>
              <SelectItem value="round_robin">{t('widgetPage.behavior.assignmentModeRoundRobin')}</SelectItem>
              <SelectItem value="manual">{t('widgetPage.behavior.assignmentModeManual')}</SelectItem>
            </SelectContent>
          </Select>

          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground" data-assignment-help={mode}>
            <p className="text-foreground">{modeHelp}</p>
            {automatic && (
              <>
                <p>
                  {platform?.general_pool_enabled === false
                    ? t('widgetPage.behavior.assignment.departmentNoPool')
                    : t('widgetPage.behavior.assignment.departmentPool')}
                </p>
                <p>{t('widgetPage.behavior.assignment.available')}</p>
                <p>{t('widgetPage.behavior.assignment.nobody')}</p>
              </>
            )}
          </div>

          <div className="space-y-4 border-s border-border/60 ps-3">
            {/* Returning visitors */}
            <div className="space-y-2" data-assignment-last-agent>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <Label className="text-sm" htmlFor="assignment-last-agent">{t('widgetPage.behavior.assignment.lastAgent')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {!platformLastAgent
                      ? t('widgetPage.behavior.assignment.lastAgentPlatformOff')
                      : automatic
                        ? t('widgetPage.behavior.assignment.lastAgentHint', { days: windowDays })
                        : t('widgetPage.behavior.assignment.lastAgentManualHint', { days: windowDays })}
                  </p>
                </div>
                <Switch
                  id="assignment-last-agent"
                  disabled={locked || !platformLastAgent}
                  checked={lastAgentOn}
                  onCheckedChange={(v) => void save({ last_agent_routing_enabled: v })}
                />
              </div>
              <NumberSetting
                id="assignment-last-agent-days"
                label={t('widgetPage.behavior.assignment.lastAgentWindow')}
                unit={t('widgetPage.behavior.assignment.days')}
                value={windowDays}
                min={LAST_AGENT_WINDOW_MIN}
                max={LAST_AGENT_WINDOW_MAX}
                disabled={locked || !lastAgentOn}
                onCommit={(n) => void save({ last_agent_window_days: n })}
              />
            </div>

            {/* Capacity */}
            <NumberSetting
              id="assignment-capacity"
              label={t('widgetPage.behavior.assignment.capacity')}
              hint={t('widgetPage.behavior.assignment.capacityHint')}
              value={capacity}
              min={CHAT_CAPACITY_MIN}
              max={CHAT_CAPACITY_MAX}
              disabled={locked}
              onCommit={(n) => void save({ default_max_concurrent_chats: n })}
            />

            {/* First-response timeout */}
            <NumberSetting
              id="assignment-timeout"
              label={t('widgetPage.behavior.assignment.timeout')}
              hint={automatic
                ? t('widgetPage.behavior.assignment.timeoutHint')
                : t('widgetPage.behavior.assignment.timeoutManualHint')}
              unit={t('widgetPage.behavior.assignment.minutes')}
              value={timeout}
              min={FIRST_RESPONSE_TIMEOUT_MIN}
              max={FIRST_RESPONSE_TIMEOUT_MAX}
              disabled={locked || !automatic}
              onCommit={(n) => void save({ first_response_timeout_minutes: n })}
            />

            {/* Quiet conversations: every plan and every mode, so never `locked` */}
            <div data-assignment-inactivity>
              <NumberSetting
                id="assignment-inactivity"
                label={t('widgetPage.behavior.assignment.inactivityClose')}
                hint={inactivityOff
                  ? t('widgetPage.behavior.assignment.inactivityClosePlatformOff')
                  : t('widgetPage.behavior.assignment.inactivityCloseHint')}
                unit={t('widgetPage.behavior.assignment.hours')}
                value={inactivityHours}
                min={INACTIVITY_CLOSE_MIN_HOURS}
                max={INACTIVITY_CLOSE_MAX_HOURS}
                disabled={inactivityOff}
                onCommit={(n) => void save({ inactivity_close_hours: n })}
                aside={inactivityOff ? undefined : ownHours === null ? (
                  <span className="text-xs text-muted-foreground" data-assignment-inactivity-default>
                    {t('widgetPage.behavior.assignment.inactivityClosePlatformDefault', { hours: platformDefaultHours })}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    data-assignment-inactivity-reset
                    onClick={() => void save({ inactivity_close_hours: null })}
                  >
                    {t('widgetPage.behavior.assignment.inactivityCloseUseDefault')}
                  </button>
                )}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
