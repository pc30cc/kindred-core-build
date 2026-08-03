import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { formatDateTime, formatRelative } from '@/lib/date';
import { useContact, useContactConversations, useUpdateContact, useDeleteContact } from '@/hooks/useContacts';
import { useContactCalls, type ContactCall } from '@/hooks/useContactChannels';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft, ArrowRight, Mail, Phone, MapPin, Building2, Calendar, MessageSquare,
  Trash2, Edit3, Save, X, Loader2, Activity, User as UserIcon, StickyNote, Clock, Tag, Bot,
  PhoneCall, Video, Mic, Timer, Hourglass,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  getInitials, getDisplayName,
  getCompanyFromMetadata, getLocationFromMetadata,
} from '@/features/contacts/utils';
import { ContactPrivacyActions } from '@/components/privacy/ContactPrivacyActions';
import { useContactIp } from '@/hooks/useContactIp';
import { Globe, Lock } from 'lucide-react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';

/**
 * Conversation subjects are sometimes persisted with an English default
 * ("New conversation"). Map those defaults onto the active locale so the
 * Persian UI never leaks English strings.
 */
const DEFAULT_SUBJECTS = new Set([
  'new conversation',
  'new chat',
  'untitled conversation',
  'untitled',
]);

function conversationTitle(conv: any, t: (k: any, v?: any) => string): string {
  const subject = (conv?.subject ?? '').trim();
  if (!subject || DEFAULT_SUBJECTS.has(subject.toLowerCase())) {
    return t('contacts.conversationUntitled');
  }
  return subject;
}

function formatDuration(seconds?: number | null): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function callTypeLabel(type: string, t: (k: any) => string): string {
  switch (type) {
    case 'video': return t('contacts.callTypeVideo');
    case 'screenshare': return t('contacts.callTypeScreenshare');
    case 'meeting': return t('contacts.callTypeMeeting');
    default: return t('contacts.callTypeAudio');
  }
}

function callStateLabel(state: string, t: (k: any) => string): string {
  switch (state) {
    case 'ended': return t('contacts.callStateEnded');
    case 'active': case 'connecting': case 'ringing': case 'pending': return t('contacts.callStateActive');
    case 'missed': return t('contacts.callStateMissed');
    case 'failed': return t('contacts.callStateFailed');
    case 'cancelled': return t('contacts.callStateCancelled');
    default: return t('contacts.callStateOther');
  }
}

export default function ContactDetailPage() {
  const { t, dir } = useTranslation();
  const rtl = dir === 'rtl';
  const { id, slug: wsSlug } = useParams();
  const navigate = useNavigate();
  const { data: contact, isLoading } = useContact(id);
  const { data: conversations } = useContactConversations(id);
  const { data: calls } = useContactCalls(id);
  const { data: ipState } = useContactIp(id);
  const updateMutation = useUpdateContact();
  const deleteMutation = useDeleteContact();
  const workspace = useCurrentWorkspace();
  const { data: ents } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const canEdit = ents?.features?.contact_edit?.value !== false;

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '', tags: '' });

  const startEdit = () => {
    if (!contact) return;
    setForm({
      name: contact.name ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      notes: (contact as any).notes ?? '',
      tags: (contact.tags ?? []).join(', '),
    });
    setEditing(true);
  };

  const handleSave = async () => {
    if (!contact) return;
    try {
      await updateMutation.mutateAsync({
        id: contact.id,
        name: form.name || null,
        email: form.email || null,
        phone: form.phone || null,
        notes: form.notes || null,
        tags: form.tags ? form.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
      } as any);
      toast({ title: t('contacts.toastUpdated') });
      setEditing(false);
    } catch (e: any) {
      toast({ title: t('contacts.toastError'), description: e?.message, variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!contact) return;
    try {
      await deleteMutation.mutateAsync(contact.id);
      toast({ title: t('contacts.toastDeleted') });
      navigate(`/app/w/${wsSlug}/contacts`);
    } catch (e: any) {
      toast({ title: t('contacts.toastError'), description: e?.message, variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3" dir={dir}>
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('contacts.loading')}</p>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3" dir={dir}>
        <p className="text-muted-foreground">{t('contacts.notFound')}</p>
        <Link to={`/app/w/${wsSlug}/contacts`}>
          <Button variant="outline">{t('contacts.backToContacts')}</Button>
        </Link>
      </div>
    );
  }

  const company = getCompanyFromMetadata(contact);
  const loc = getLocationFromMetadata(contact);
  const location = [loc.city, loc.country].filter(Boolean).join('، ') || null;
  const BackIcon = rtl ? ArrowRight : ArrowLeft;
  const billingHref = `/app/w/${wsSlug}/billing`;
  const ipLocked = ipState?.status === 'locked';
  const ipValue = ipState?.status === 'ok' ? ipState.ip : null;
  const callList = (calls ?? []) as ContactCall[];
  const totalTalk = callList.reduce((acc, c) => acc + (c.duration_seconds ?? 0), 0);
  const hasCalls = callList.length > 0;
  const hasChat = (conversations ?? []).some(
    (c: any) => !callList.some((call) => call.conversation_id === c.id),
  );
  const sourceLabel = hasCalls && hasChat
    ? t('contacts.sourceBoth')
    : hasCalls
      ? t('contacts.sourceCall')
      : (conversations ?? []).length
        ? t('contacts.sourceChat')
        : t('contacts.sourceUnknown');

  return (
    <div className="flex flex-col h-full bg-background" dir={dir}>
      {/* Toolbar */}
      <div className="sticky top-0 z-10 border-b border-border bg-card px-4 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/app/w/${wsSlug}/contacts`)} className="gap-1.5 shrink-0">
          <BackIcon className="w-4 h-4" />{t('contacts.back')}
        </Button>
        <div className="w-8 h-8 rounded-md overflow-hidden bg-primary/10 flex items-center justify-center shrink-0">
          {contact.avatar_url ? (
            <img src={contact.avatar_url} alt={getDisplayName(contact)} className="w-full h-full object-cover" />
          ) : (
            <span className="text-[11px] font-bold text-primary">{getInitials(contact.name, contact.email)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-foreground truncate leading-tight">{getDisplayName(contact)}</h1>
          <p className="text-[11px] text-muted-foreground truncate">
            {[company, contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
          <span className="inline-flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" />{conversations?.length ?? 0}</span>
          <span className="inline-flex items-center gap-1"><PhoneCall className="w-3.5 h-3.5" />{callList.length}</span>
          {contact.updated_at && (
            <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{formatRelative(contact.updated_at)}</span>
          )}
        </div>
        {!editing ? (
          <>
            {canEdit ? (
              <Button size="sm" variant="outline" onClick={startEdit} className="gap-1.5">
                <Edit3 className="w-3.5 h-3.5" />{t('contacts.edit')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 opacity-60"
                onClick={() => navigate(billingHref)}
                title={t('contacts.featureLockedDesc')}
              >
                <Lock className="w-3.5 h-3.5" />{t('contacts.edit')}
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />{t('contacts.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent dir={dir}>
                <AlertDialogHeader className="text-start sm:text-start">
                  <AlertDialogTitle className="text-start">{t('contacts.deleteOneTitle')}</AlertDialogTitle>
                  <AlertDialogDescription className="text-start">
                    {t('contacts.deleteOneDesc', { name: getDisplayName(contact) })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="sm:justify-start gap-2">
                  <AlertDialogCancel>{t('contacts.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {t('contacts.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} className="gap-1.5">
              <X className="w-3.5 h-3.5" />{t('contacts.cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Save className="w-3.5 h-3.5" />{t('contacts.save')}</>}
            </Button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-4 sm:p-5">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Sidebar */}
            <Card className="lg:col-span-1 h-fit">
              <CardContent className="p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-3">
                  {t('contacts.contactChannels')}
                </p>
                <div className="mb-3">
                  <Badge variant="secondary" className="text-[10px] gap-1">
                    {hasCalls ? <PhoneCall className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                    {sourceLabel}
                  </Badge>
                </div>
                <div className="space-y-3.5">
                  <Row icon={Mail} label={t('contacts.email')} value={contact.email} />
                  <Row icon={Phone} label={t('contacts.phone')} value={contact.phone} />
                  <Row icon={Building2} label={t('contacts.company')} value={company} />
                  <Row icon={MapPin} label={t('contacts.location')} value={location} />
                  <Row icon={Calendar} label={t('contacts.createdAt')} value={contact.created_at ? formatDateTime(contact.created_at) : null} />
                  <Row icon={Clock} label={t('contacts.updatedAt')} value={contact.updated_at ? formatDateTime(contact.updated_at) : null} />
                </div>
                <div className="mt-4 pt-4 border-t border-border">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                    {t('contacts.tags')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(contact.tags ?? []).length ? (
                      (contact.tags ?? []).map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                      ))
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{t('contacts.noTags')}</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Main */}
            <div className="lg:col-span-2">
              <Tabs defaultValue="overview" dir={dir}>
                <TabsList className="w-full justify-start flex-wrap h-auto">
                  <TabsTrigger value="overview" className="gap-1.5"><UserIcon className="w-3.5 h-3.5" />{t('contacts.tabOverview')}</TabsTrigger>
                  <TabsTrigger value="conversations" className="gap-1.5"><MessageSquare className="w-3.5 h-3.5" />{t('contacts.tabChats')}</TabsTrigger>
                  <TabsTrigger value="calls" className="gap-1.5"><PhoneCall className="w-3.5 h-3.5" />{t('contacts.tabCalls')}</TabsTrigger>
                  <TabsTrigger value="notes" className="gap-1.5"><StickyNote className="w-3.5 h-3.5" />{t('contacts.tabNotes')}</TabsTrigger>
                  <TabsTrigger value="tags" className="gap-1.5"><Tag className="w-3.5 h-3.5" />{t('contacts.tabTags')}</TabsTrigger>
                  <TabsTrigger value="activity" className="gap-1.5"><Activity className="w-3.5 h-3.5" />{t('contacts.tabActivity')}</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="mt-4">
                  <Card className="border-border/70">
                    <CardContent className="p-5 space-y-4">
                      {editing ? (
                        <>
                          <Field label={t('contacts.name')}><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>
                          <Field label={t('contacts.email')}><Input type="email" dir="ltr" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} /></Field>
                          <Field label={t('contacts.phone')}><Input dir="ltr" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} /></Field>
                        </>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <Row icon={UserIcon} label={t('contacts.name')} value={getDisplayName(contact)} />
                          <Row icon={Mail} label={t('contacts.email')} value={contact.email} />
                          <Row icon={Phone} label={t('contacts.phone')} value={contact.phone} />
                          <Row icon={Building2} label={t('contacts.company')} value={company} />
                          <Row icon={MapPin} label={t('contacts.location')} value={location} />
                          {ipLocked ? (
                            <div className="flex items-start gap-2.5">
                              <Lock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <p className="text-[11px] text-muted-foreground">{t('contacts.ipAddress')}</p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    toast({
                                      title: t('contacts.ipLockedTitle'),
                                      description: t('contacts.ipLockedDesc'),
                                      action: undefined,
                                    })
                                  }
                                  className="mt-0.5 inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                                >
                                  <span className="select-none tracking-widest">•••••••</span>
                                  <Link to={billingHref} className="text-primary hover:underline">
                                    {t('contacts.ipLocked')}
                                  </Link>
                                </button>
                              </div>
                            </div>
                          ) : (
                            <Row icon={Globe} label={t('contacts.ipAddress')} value={ipValue || t('contacts.ipUnavailable')} />
                          )}
                          <Row icon={MessageSquare} label={t('contacts.tabChats')} value={String(conversations?.length ?? 0)} />
                          <Row icon={PhoneCall} label={t('contacts.tabCalls')} value={String(callList.length)} />
                          <Row icon={Activity} label={t('contacts.colSource')} value={sourceLabel} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="conversations" className="mt-4">
                  <Card className="border-border/70">
                    <CardContent className="p-0">
                      <ScrollArea className="max-h-[500px]">
                        {!conversations?.length ? (
                          <div className="text-center py-16 text-muted-foreground">
                            <MessageSquare className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
                            <p className="text-sm">{t('contacts.noConversations')}</p>
                          </div>
                        ) : (
                          <div className="divide-y divide-border">
                            {conversations.map((conv: any) => (
                              <div
                                key={conv.id}
                                className={cn('p-4 hover:bg-secondary/50 cursor-pointer transition-colors', rtl && 'text-right')}
                                onClick={() => navigate(`/app/w/${wsSlug}/inbox?c=${conv.id}`)}
                                title={t('contacts.openConversation')}
                              >
                                <p className="font-medium text-sm text-foreground line-clamp-1">
                                  {conversationTitle(conv, t)}
                                </p>
                                {conv.last_message_body ? (
                                  <p className="text-xs text-muted-foreground line-clamp-1 mt-1">
                                    {conv.last_message_body}
                                  </p>
                                ) : null}
                                <div className="flex items-center gap-2 mt-1.5">
                                  {conv.handled_by_operator ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                                      <UserIcon className="w-3 h-3" />
                                      {conv.operator_name || t('contacts.handledByOperator')}
                                    </span>
                                  ) : conv.handled_by_ai ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-accent/15 text-accent-foreground">
                                      <Bot className="w-3 h-3" />
                                      {t('contacts.handledByAi')}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">
                                      {t('contacts.handledByUnassigned')}
                                    </span>
                                  )}
                                  {conv.handled_by_operator && conv.handled_by_ai ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-accent/15 text-accent-foreground">
                                      <Bot className="w-3 h-3" />
                                      {t('contacts.handledByAi')}
                                    </span>
                                  ) : null}
                                  <span className={cn(
                                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                                    conv.status === 'open' ? 'bg-success/15 text-success' :
                                    conv.status === 'pending' ? 'bg-warning/15 text-warning' :
                                    'bg-muted text-muted-foreground'
                                  )}>
                                    {conv.status === 'open' ? t('contacts.statusOpen') :
                                     conv.status === 'pending' ? t('contacts.statusPending') :
                                     t('contacts.statusClosed')}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">{formatRelative(conv.updated_at)}</span>
                                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <Clock className="w-3 h-3" />
                                    {formatDateTime(conv.updated_at)}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="notes" className="mt-4">
                  {null}
                  <Card className="border-border/70">
                    <CardContent className="p-5 space-y-3">
                      {editing ? (
                        <Field label={t('contacts.notes')}>
                          <Textarea rows={8} value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} />
                        </Field>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <StickyNote className="w-3.5 h-3.5" />
                            <p className="text-[11px] uppercase tracking-wide font-semibold">{t('contacts.notesTitle')}</p>
                          </div>
                          {(contact as any).notes ? (
                            <p className="whitespace-pre-wrap text-foreground leading-7 rounded-lg bg-secondary/50 p-4">
                              {(contact as any).notes}
                            </p>
                          ) : (
                            <p className="text-muted-foreground text-sm rounded-lg border border-dashed border-border p-4">
                              {t('contacts.notesEmpty')}
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="tags" className="mt-4">
                  <Card className="border-border/70">
                    <CardContent className="p-5 space-y-3">
                      {editing ? (
                        <Field label={t('contacts.tagsComma')}>
                          <Input value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} />
                        </Field>
                      ) : (contact.tags ?? []).length ? (
                        <div className="flex flex-wrap gap-2">
                          {(contact.tags ?? []).map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-sm rounded-lg border border-dashed border-border p-4">
                          {t('contacts.noTags')}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="activity" className="mt-4">
                  <Card className="border-border/70">
                    <CardContent className="p-5 space-y-3">
                      <ActivityRow time={contact.created_at} label={t('contacts.activityCreated')} />
                      {contact.updated_at !== contact.created_at && (
                        <ActivityRow time={contact.updated_at} label={t('contacts.activityUpdated')} />
                      )}
                    </CardContent>
                  </Card>
                  <div className="mt-4">
                    <ContactPrivacyActions contactId={contact.id} contactLabel={getDisplayName(contact)} />
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
        <p className="text-sm text-foreground truncate">{value || '—'}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function ActivityRow({ time, label }: { time?: string | null; label: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{time ? formatDateTime(time) : ''}</p>
      </div>
    </div>
  );
}
