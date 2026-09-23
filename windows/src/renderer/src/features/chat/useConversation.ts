import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, newClientMessageId } from '@/api/client'
import type { CallChannel, Conversation, ConversationNote, ConversationPriority, ConversationStatus, Message, VisitorProfile, WorkspaceMember } from '@/api/types'
import { usePoll } from '@/hooks/usePoll'
import { INBOX_EVENT } from '@/features/notifications/realtime'
import { pollInterval } from '@/features/notifications/pollBudget'
import { useApp } from '@/store/app'
import { translate } from '@/i18n'
import { contactName } from '@/lib/format'
import { useInbox } from '@/features/inbox/inboxStore'

export type LoadState<T> = { kind: 'loading' } | { kind: 'loaded'; value: T } | { kind: 'failed'; error: ApiError }

/** The transcript, kept live by polling while it is open — the desktop has no push channel. */
export function useTranscript(conversation: Conversation) {
  const [state, setState] = useState<LoadState<Message[]>>({ kind: 'loading' })
  const [visitor, setVisitor] = useState<VisitorProfile | null>(useInbox.getState().visitors[conversation.id] ?? null)
  const [sending, setSending] = useState(false)
  const lastSeenCount = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      try {
        const messages = await api.messages(conversation.id)
        setState({ kind: 'loaded', value: messages })
        const incoming = messages.filter((m) => m.sender_type === 'contact').length
        // Reading marks the thread seen — but only while the window is actually being looked at.
        if (incoming !== lastSeenCount.current && document.hasFocus()) {
          lastSeenCount.current = incoming
          void api.markSeen(conversation.id).catch(() => undefined)
          useInbox.getState().patchLocal(conversation.id, { unread_count: 0 })
        }
      } catch (e) {
        if (!quiet) setState({ kind: 'failed', error: e instanceof ApiError ? e : new ApiError('transport') })
      }
    },
    [conversation.id],
  )

  useEffect(() => {
    lastSeenCount.current = -1
    setState({ kind: 'loading' })
    void load()
    if (!visitor) {
      void api
        .visitorIntel(conversation.workspace_id, { conversationIds: [conversation.id] })
        .then((r) => setVisitor(r.byConversation[conversation.id] ?? null))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  usePoll(() => load(true), pollInterval(4000), [conversation.id], { immediate: false, backgroundMs: 12_000, wakeOn: INBOX_EVENT })

  /** Returns false when the text should go back into the composer. */
  const send = useCallback(
    async (body: string, attachment?: { name: string; mime: string; data: Uint8Array }) => {
      setSending(true)
      const clientMessageId = newClientMessageId()
      // An optimistic bubble, replaced by the server's own copy on the next reload.
      const optimistic: Message = {
        id: `local-${clientMessageId}`,
        conversation_id: conversation.id,
        sender_type: 'agent',
        body,
        created_at: new Date().toISOString(),
        sender_name: null,
        metadata: { pending: true },
        attachments: attachment ? [{ id: `local-${clientMessageId}`, file_name: attachment.name, mime_type: attachment.mime, size_bytes: attachment.data.byteLength }] : null,
      }
      setState((s) => (s.kind === 'loaded' ? { kind: 'loaded', value: [...s.value, optimistic] } : s))
      try {
        let attachmentId: string | null = null
        if (attachment) {
          attachmentId = await api.uploadAttachment({
            workspaceId: conversation.workspace_id,
            conversationId: conversation.id,
            fileName: attachment.name,
            mimeType: attachment.mime,
            data: attachment.data,
          })
        }
        await api.sendMessage({ conversationId: conversation.id, workspaceId: conversation.workspace_id, body, attachmentId, clientMessageId })
        await load(true)
        useInbox.getState().patchLocal(conversation.id, {
          last_message: { body, created_at: new Date().toISOString(), sender_type: 'agent', attachment_kind: attachment ? attachment.mime.split('/')[0] : null },
        })
        return true
      } catch (e) {
        setState((s) => (s.kind === 'loaded' ? { kind: 'loaded', value: s.value.filter((m) => m.id !== optimistic.id) } : s))
        const language = useApp.getState().language
        if (e instanceof ApiError && e.status === 415) toast.error(translate(language, 'fileTypeNotAllowed'))
        else if (e instanceof ApiError && e.status === 413) toast.error(translate(language, 'fileTooLarge'))
        else toast.error(translate(language, 'offlineTitle'), { description: translate(language, 'offlineBody') })
        return false
      } finally {
        setSending(false)
      }
    },
    [conversation.id, conversation.workspace_id, load],
  )

  return { state, visitor, sending, send, reload: load }
}

/** Status, priority, assignee, tags and notes — the web's action panel, saved optimistically. */
export function useConversationActions(conversation: Conversation) {
  const [status, setStatusState] = useState<ConversationStatus>(conversation.status)
  const [priority, setPriorityState] = useState<ConversationPriority>(conversation.priority ?? 'normal')
  const [assignedTo, setAssignedTo] = useState<string | null>(conversation.assigned_to ?? null)
  const [tags, setTagsState] = useState<string[]>(conversation.tags ?? [])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [notes, setNotes] = useState<LoadState<ConversationNote[]>>({ kind: 'loading' })
  const [tookOver, setTookOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const t = (key: Parameters<typeof translate>[1]) => translate(useApp.getState().language, key)

  // Follow the server when a poll brings a newer state for this thread.
  useEffect(() => {
    setStatusState(conversation.status)
    setPriorityState(conversation.priority ?? 'normal')
    setAssignedTo(conversation.assigned_to ?? null)
    setTagsState(conversation.tags ?? [])
  }, [conversation.status, conversation.priority, conversation.assigned_to, conversation.tags])

  useEffect(() => {
    void api.workspaceMembers(conversation.workspace_id).then(setMembers).catch(() => setMembers([]))
    void api
      .notes(conversation.id, conversation.workspace_id)
      .then((value) => setNotes({ kind: 'loaded', value }))
      .catch(() => setNotes({ kind: 'loaded', value: [] }))
  }, [conversation.id, conversation.workspace_id])

  async function save<T>(apply: () => void, revert: () => void, patch: Parameters<typeof api.updateConversation>[2], local: Partial<Conversation>) {
    apply()
    try {
      await api.updateConversation(conversation.id, conversation.workspace_id, patch)
      useInbox.getState().patchLocal(conversation.id, local)
    } catch {
      revert()
      toast.error(t('saveFailed'))
    }
  }

  return {
    status,
    priority,
    assignedTo,
    tags,
    members: members.filter((m) => !m.suspended_at).sort((a, b) => memberName(a).localeCompare(memberName(b))),
    allMembers: members,
    notes,
    tookOver,
    busy,
    setStatus(next: ConversationStatus) {
      const prev = status
      void save(() => setStatusState(next), () => setStatusState(prev), { status: next }, { status: next })
    },
    setPriority(next: ConversationPriority) {
      const prev = priority
      void save(() => setPriorityState(next), () => setPriorityState(prev), { priority: next }, { priority: next })
    },
    assign(userId: string | null) {
      const prev = assignedTo
      void save(() => setAssignedTo(userId), () => setAssignedTo(prev), { assigned_to: userId }, { assigned_to: userId })
    },
    addTag(raw: string) {
      const tag = raw.trim().toLowerCase()
      if (!tag || tags.includes(tag) || tags.length >= 20) return
      const prev = tags
      const next = [...tags, tag]
      void save(() => setTagsState(next), () => setTagsState(prev), { tags: next }, { tags: next })
    },
    removeTag(tag: string) {
      const prev = tags
      const next = tags.filter((x) => x !== tag)
      void save(() => setTagsState(next), () => setTagsState(prev), { tags: next }, { tags: next })
    },
    async addNote(body: string) {
      const text = body.trim()
      if (!text) return false
      setBusy(true)
      try {
        await api.addNote(conversation.id, conversation.workspace_id, text)
        setNotes({ kind: 'loaded', value: await api.notes(conversation.id, conversation.workspace_id) })
        return true
      } catch {
        toast.error(t('saveFailed'))
        return false
      } finally {
        setBusy(false)
      }
    },
    async deleteNote(note: ConversationNote) {
      const prev = notes.kind === 'loaded' ? notes.value : []
      setNotes({ kind: 'loaded', value: prev.filter((n) => n.id !== note.id) })
      try {
        await api.deleteNote(conversation.id, conversation.workspace_id, note.id)
      } catch {
        setNotes({ kind: 'loaded', value: prev })
        toast.error(t('saveFailed'))
      }
    },
    async takeOver() {
      if (busy) return
      setBusy(true)
      try {
        await api.takeOver(conversation.id, conversation.workspace_id)
        setTookOver(true)
        const me = useApp.getState().session
        const meId = me.kind === 'signedIn' ? me.user.id : null
        useInbox.getState().patchLocal(conversation.id, { ai_state: 'human_active', assigned_to: meId, metadata: { ...(conversation.metadata ?? {}), ai_state: 'human_active' } })
        toast.success(t('takenOver'))
      } catch {
        toast.error(t('takeOverFailed'))
      } finally {
        setBusy(false)
      }
    },
    async invite(channel: CallChannel) {
      try {
        const invitation = await api.inviteToCall(conversation.id, conversation.workspace_id, channel)
        useApp.getState().startCall({
          invitation,
          conversationId: conversation.id,
          contactName: contactName(conversation.contacts, useApp.getState().language),
          contactAvatarURL: conversation.contacts?.avatar_url,
        })
      } catch {
        toast.error(t('inviteFailed'))
      }
    },
  }
}

export function memberName(m: WorkspaceMember): string {
  return m.profile?.full_name?.trim() || m.profile?.email || m.user_id.slice(0, 8)
}
