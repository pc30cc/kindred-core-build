/**
 * Phase 3 — Editable conversation action panel.
 *
 * Lives in the Inbox sidebar (Info tab). Lets workspace members edit:
 *   • status      — open | pending | resolved | closed
 *   • priority    — low  | normal  | high     | urgent
 *   • assignee    — the transfer picker (ConversationAssignee): an operator
 *                   of the chat team, a department, or back to the queue
 *   • tags        — free-form add/remove (server normalizes)
 *
 * Status, priority and tags go through useUpdateConversation → PATCH
 * /api/conversations/:id; the assignee through the transfer and claim
 * routes. They are workspace-membership gated and write both
 * conversation_events (UI timeline) and audit_logs (compliance) per change.
 *
 * Optimistic update behavior is owned by useUpdateConversation; this
 * component just dispatches the mutation. While the mutation is in flight
 * controls are disabled to avoid stacking edits on stale state.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Hash, X, Plus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConversationAssignee } from '@/components/inbox/ConversationAssignee';

type Status = 'open' | 'pending' | 'resolved' | 'closed';
type Priority = 'low' | 'normal' | 'high' | 'urgent';

interface Props {
  conversationId: string;
  workspaceId: string;
  status: Status | string;
  priority: Priority | string;
  assignedTo: string | null;
  /** The conversation's department (package A's payload; null when none or not sent). */
  departmentId?: string | null;
  departmentName?: string | null;
  /** Who is looking, for what the transfer picker offers them. */
  viewerId?: string | null;
  viewerRole?: string | null;
  tags: string[];
  onMutate: (vars: {
    status?: Status;
    priority?: Priority;
    tags?: string[];
  }) => void;
  isPending: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
  dir: 'ltr' | 'rtl';
  locale?: string;
}

const STATUSES: Status[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

const priorityColor: Record<string, string> = {
  low: 'text-muted-foreground',
  normal: 'text-info',
  high: 'text-warning',
  urgent: 'text-destructive',
};

export function ConversationActionPanel({
  conversationId, workspaceId, status, priority, assignedTo, departmentId, departmentName,
  viewerId, viewerRole, tags, onMutate, isPending, t, dir, locale,
}: Props) {
  const [tagInput, setTagInput] = useState('');

  const addTag = () => {
    const v = tagInput.trim().toLowerCase();
    if (!v) return;
    if (tags.includes(v)) { setTagInput(''); return; }
    onMutate({ tags: [...tags, v] });
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    onMutate({ tags: tags.filter((x) => x !== tag) });
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 overflow-hidden" dir={dir}>
      <div className="px-3 py-2 border-b border-border/30 bg-secondary/15 flex items-center justify-between">
        <h4 className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
          {t('inbox.details') || 'Details'}
        </h4>
        {isPending && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      <div className="divide-y divide-border/20">
        {/* Status */}
        <div className="px-3 py-2 space-y-1">
          <span className="text-[10px] text-muted-foreground">{t('inbox.status') || 'Status'}</span>
          <Select
            value={String(status)}
            onValueChange={(v) => onMutate({ status: v as Status })}
            disabled={isPending}
          >
            <SelectTrigger className="h-7 text-[11px] capitalize"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="text-[11px] capitalize">
                  {t(`inbox.${s}`) || s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Priority */}
        <div className="px-3 py-2 space-y-1">
          <span className="text-[10px] text-muted-foreground">{t('inbox.priority') || 'Priority'}</span>
          <Select
            value={String(priority)}
            onValueChange={(v) => onMutate({ priority: v as Priority })}
            disabled={isPending}
          >
            <SelectTrigger className={cn('h-7 text-[11px] capitalize', priorityColor[priority] || '')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p} className={cn('text-[11px] capitalize', priorityColor[p])}>
                  {t(`inbox.priority_${p}`) || p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Assignee — who has it, and the transfer picker */}
        <ConversationAssignee
          workspaceId={workspaceId}
          conversationId={conversationId}
          assignedTo={assignedTo}
          departmentId={departmentId ?? null}
          departmentName={departmentName ?? null}
          viewerId={viewerId}
          viewerRole={viewerRole}
          t={t}
          dir={dir}
          locale={locale}
        />

        {/* Tags */}
        <div className="px-3 py-2 space-y-1.5">
          <span className="text-[10px] text-muted-foreground">{t('inbox.tags') || 'Tags'}</span>
          <div className="flex flex-wrap gap-1">
            {tags.length === 0 && (
              <span className="text-[10px] text-muted-foreground/70">
                {t('inbox.noTags') || 'No tags'}
              </span>
            )}
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-foreground border border-border/40"
              >
                <Hash className="w-2.5 h-2.5 text-primary/60" />
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  disabled={isPending}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('inbox.removeTag') || 'Remove tag'}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addTag(); }
              }}
              placeholder={t('inbox.addTag') || 'Add tag…'}
              className="h-7 text-[11px]"
              dir={dir}
              disabled={isPending}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-7 w-7 shrink-0"
              onClick={addTag}
              disabled={isPending || !tagInput.trim()}
              aria-label={t('inbox.addTag') || 'Add tag'}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
