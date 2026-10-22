/**
 * Team & departments: who receives chats, and each member's own chat
 * routing (migration 278, PATCH /api/workspace-members/:id/chat-routing).
 *
 *   - MemberChatRoutingControls: "Receive chats" (routing may give them a
 *     chat; off = they answer by hand only) and their own maximum of open
 *     chats (empty = the workspace default). The owner has them too.
 *   - ChatReceiversNote: the plain rules (owner and team members with the
 *     switch on, never staff; a department first, then the whole team unless
 *     the platform turned that off; Manual gives nobody a chat).
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { settingsErrorMessage } from '@/lib/settingsErrors';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  CHAT_CAPACITY_MAX,
  CHAT_CAPACITY_MIN,
  parseRoutingNumber,
  updateMemberChatRouting,
  type MemberChatRouting,
} from '@/lib/chat-routing-api';

export interface MemberChatRoutingRow {
  id: string;
  user_id: string;
  receives_chats: boolean;
  max_concurrent_chats: number | null;
}

export interface MemberChatRoutingControlsProps {
  workspaceId: string;
  /** workspace_members.id */
  memberId: string;
  /** For the controls' accessible names. */
  name: string;
  receivesChats: boolean;
  maxConcurrentChats: number | null;
  /** The workspace default (widget_settings.default_max_concurrent_chats). */
  defaultMax: number;
  /** The row as the server stored it, after each saved change. */
  onSaved?: (row: MemberChatRoutingRow) => void;
}

export function MemberChatRoutingControls({
  workspaceId,
  memberId,
  name,
  receivesChats,
  maxConcurrentChats,
  defaultMax,
  onSaved,
}: MemberChatRoutingControlsProps) {
  const { t } = useTranslation();
  const [receives, setReceives] = useState(receivesChats);
  const [text, setText] = useState(maxConcurrentChats == null ? '' : String(maxConcurrentChats));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);

  useEffect(() => { setReceives(receivesChats); }, [receivesChats]);
  useEffect(() => {
    if (editing.current) return;
    setText(maxConcurrentChats == null ? '' : String(maxConcurrentChats));
    setInvalid(false);
  }, [maxConcurrentChats]);

  const save = useMutation({
    mutationFn: (patch: MemberChatRouting) => updateMemberChatRouting(workspaceId, memberId, patch),
    onSuccess: (row) => {
      onSaved?.(row);
      toast.success(t('teamDept.chatRouting.saved'));
    },
    onError: (err: Error, patch) => {
      // Back to what the server has.
      if (patch.receives_chats !== undefined) setReceives(receivesChats);
      if (patch.max_concurrent_chats !== undefined) {
        setText(maxConcurrentChats == null ? '' : String(maxConcurrentChats));
      }
      // Why, in the panel's language: never the server's code ("member_not_found", "HTTP 503").
      toast.error(t('teamDept.chatRouting.saveFailed'), { description: settingsErrorMessage(err, t) });
    },
  });

  const toggle = (next: boolean) => {
    setReceives(next);
    save.mutate({ receives_chats: next });
  };

  const commitMax = () => {
    const n = parseRoutingNumber(text, CHAT_CAPACITY_MIN, CHAT_CAPACITY_MAX);
    if (n === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(n == null ? '' : String(n));
    if (n !== maxConcurrentChats) save.mutate({ max_concurrent_chats: n });
  };

  const errorId = `member-max-${memberId}-error`;
  return (
    <div className="space-y-1" data-member-chat-routing={memberId}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            aria-label={t('teamDept.chatRouting.receiveAria', { name })}
            checked={receives}
            onCheckedChange={toggle}
          />
          <span>{t('teamDept.chatRouting.receive')}</span>
        </label>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span aria-hidden>{t('teamDept.chatRouting.max')}</span>
          <Input
            type="text"
            inputMode="numeric"
            dir="ltr"
            className="h-7 w-14 px-1 text-center text-xs"
            aria-label={t('teamDept.chatRouting.maxAria', { name, n: defaultMax })}
            title={t('teamDept.chatRouting.maxDefault', { n: defaultMax })}
            placeholder={String(defaultMax)}
            value={text}
            disabled={!receives}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onFocus={() => { editing.current = true; }}
            onChange={(e) => { setText(e.target.value); setInvalid(false); }}
            onBlur={() => { editing.current = false; commitMax(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitMax();
              }
            }}
          />
        </div>
      </div>
      {invalid && (
        <p id={errorId} role="alert" className="text-[11px] text-destructive">
          {t('teamDept.chatRouting.maxInvalid', { min: CHAT_CAPACITY_MIN, max: CHAT_CAPACITY_MAX })}
        </p>
      )}
    </div>
  );
}

export interface ChatReceiversNoteProps {
  /** The Super Admin's fallback to the whole team (default on). */
  generalPoolEnabled: boolean;
  /** Manual assignment (chosen, or the plan's only mode): nobody gets one. */
  manual: boolean;
  defaultMax: number;
  /** Widget → Behaviour, where the mode and the defaults are set. */
  behaviourPath?: string;
}

export function ChatReceiversNote({ generalPoolEnabled, manual, defaultMax, behaviourPath }: ChatReceiversNoteProps) {
  const { t } = useTranslation();
  return (
    <Card className="p-4 border-border/60 bg-muted/20" data-chat-receivers-note>
      <div className="flex items-start gap-3 text-xs text-muted-foreground">
        <MessageSquare className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('teamDept.chatRouting.title')}</p>
          <p>{t('teamDept.chatRouting.who', { n: defaultMax })}</p>
          <p>{t('teamDept.chatRouting.staff')}</p>
          <p>{generalPoolEnabled ? t('teamDept.chatRouting.departmentPool') : t('teamDept.chatRouting.departmentNoPool')}</p>
          <p>{t('teamDept.chatRouting.off')}</p>
          {manual && <p className="text-foreground" data-chat-receivers-manual>{t('teamDept.chatRouting.manual')}</p>}
          <p>
            {t('teamDept.chatRouting.modeBefore')}
            {behaviourPath
              ? <Link to={behaviourPath} className="text-primary hover:underline">{t('teamDept.chatRouting.modeLink')}</Link>
              : t('teamDept.chatRouting.modeLink')}
            {t('teamDept.chatRouting.modeAfter')}
          </p>
        </div>
      </div>
    </Card>
  );
}
