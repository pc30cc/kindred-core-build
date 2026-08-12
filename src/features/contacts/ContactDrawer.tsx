import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useContact, useUpdateContact, useDeleteContact, useContactConversations } from '@/hooks/useContacts';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import {
  Mail, Phone, MapPin, Building2, Calendar, Tag, MessageSquare,
  ExternalLink, Trash2, Save, Loader2, User as UserIcon, Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getInitials, getDisplayName, timeAgo, getCompanyFromMetadata, getLocationFromMetadata } from './utils';
import { ContactPrivacyActions } from '@/components/privacy/ContactPrivacyActions';

interface Props {
  contactId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContactDrawer({ contactId, open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { t, dir } = useTranslation();
  const { wsSlug } = useParams();
  const { data: contact, isLoading } = useContact(contactId ?? undefined);
  const { data: conversations } = useContactConversations(contactId ?? undefined);
  const updateMutation = useUpdateContact();
  const deleteMutation = useDeleteContact();

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
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
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
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: t('contacts.toastError'), description: e?.message, variant: 'destructive' });
    }
  };

  const location = contact ? getLocationFromMetadata(contact) : {};
  const company = contact ? getCompanyFromMetadata(contact) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={dir === 'rtl' ? 'left' : 'right'} dir={dir} className="w-full sm:max-w-md p-0 flex flex-col">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !contact ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            {t('contacts.notFound')}
          </div>
        ) : (
          <>
            <SheetHeader className="p-5 border-b border-border bg-gradient-to-br from-primary/5 to-transparent">
              <div className="flex items-start gap-3">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary shrink-0">
                  {contact.avatar_url ? (
                    <img src={contact.avatar_url} alt="" className="w-14 h-14 rounded-full object-cover" />
                  ) : (
                    getInitials(contact.name, contact.email)
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-base text-start">{getDisplayName(contact, t)}</SheetTitle>
                  {contact.email && (
                    <p className="text-xs text-muted-foreground truncate">{contact.email}</p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(contact.tags ?? []).slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-[10px] h-5">{tag}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs flex-1"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/app/w/${wsSlug}/contacts/${contact.id}`);
                  }}
                >
                  <ExternalLink className="w-3 h-3 me-1.5" />
                  {t('contacts.openFullPage')}
                </Button>
                {!editing && (
                  <Button size="sm" className="h-8 text-xs" onClick={startEdit}>
                    {t('contacts.edit')}
                  </Button>
                )}
              </div>
            </SheetHeader>

            <Tabs defaultValue="info" className="flex-1 flex flex-col overflow-hidden">
              <TabsList className="mx-5 mt-3 grid grid-cols-3 h-9">
                <TabsTrigger value="info" className="text-xs">
                  <UserIcon className="w-3.5 h-3.5 me-1" />{t('contacts.tabInfo')}
                </TabsTrigger>
                <TabsTrigger value="conversations" className="text-xs">
                  <MessageSquare className="w-3.5 h-3.5 me-1" />{t('contacts.tabChats')}
                </TabsTrigger>
                <TabsTrigger value="activity" className="text-xs">
                  <Activity className="w-3.5 h-3.5 me-1" />{t('contacts.tabActivity')}
                </TabsTrigger>
              </TabsList>

              <ScrollArea className="flex-1">
                <TabsContent value="info" className="p-5 space-y-4 mt-0">
                  {editing ? (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t('contacts.name')}</Label>
                        <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="h-9" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t('contacts.email')}</Label>
                        <Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} className="h-9" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t('contacts.phone')}</Label>
                        <Input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} className="h-9" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t('contacts.tagsComma')}</Label>
                        <Input value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} className="h-9" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{t('contacts.notes')}</Label>
                        <Textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={4} />
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} className="flex-1">
                          {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Save className="w-3.5 h-3.5 me-1.5" />{t('contacts.save')}</>}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(false)} className="flex-1">{t('contacts.cancel')}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <InfoRow icon={Mail} label={t('contacts.email')} value={contact.email} />
                      <InfoRow icon={Phone} label={t('contacts.phone')} value={contact.phone} />
                      <InfoRow icon={Building2} label={t('contacts.company')} value={company} />
                      <InfoRow icon={MapPin} label={t('contacts.location')} value={[location.city, location.country].filter(Boolean).join(', ') || null} />
                      <InfoRow icon={Calendar} label={t('contacts.createdAt')} value={contact.created_at ? new Date(contact.created_at).toLocaleString() : null} />
                      <InfoRow icon={Calendar} label={t('contacts.updatedAt')} value={contact.updated_at ? timeAgo(contact.updated_at) : null} />
                      {(contact.tags ?? []).length > 0 && (
                        <div className="space-y-1.5 pt-2">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1.5">
                            <Tag className="w-3 h-3" />{t('contacts.tagsLabel')}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {(contact.tags ?? []).map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {(contact as any).notes && (
                        <div className="space-y-1.5 pt-2 border-t border-border">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{t('contacts.notes')}</p>
                          <p className="text-sm text-foreground whitespace-pre-wrap">{(contact as any).notes}</p>
                        </div>
                      )}

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="w-full mt-4 text-destructive border-destructive/30 hover:bg-destructive/10">
                            <Trash2 className="w-3.5 h-3.5 me-1.5" />{t('contacts.deleteContact')}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent dir={dir}>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-start">{t('contacts.deleteOneTitle')}</AlertDialogTitle>
                            <AlertDialogDescription className="text-start">
                              {t('contacts.deleteOneDesc', { name: getDisplayName(contact, t) })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('contacts.cancel')}</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                              {t('contacts.delete')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <div className="pt-4">
                        <ContactPrivacyActions contactId={contact.id} contactLabel={getDisplayName(contact, t)} />
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="conversations" className="p-5 space-y-2 mt-0">
                  {!conversations?.length ? (
                    <div className="text-center py-12 text-sm text-muted-foreground">
                      <MessageSquare className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
                      {t('contacts.noConversations')}
                    </div>
                  ) : (
                    conversations.map((conv: any) => (
                      <div
                        key={conv.id}
                        className="p-3 rounded-lg border border-border hover:bg-accent/40 cursor-pointer transition-colors"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/app/w/${wsSlug}/inbox`);
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground line-clamp-1">
                            {conv.subject || t('contacts.conversationFallback', { id: conv.id.slice(0, 8) })}
                          </p>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {timeAgo(conv.updated_at)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                            conv.status === 'open' ? 'bg-success/15 text-success' :
                            conv.status === 'pending' ? 'bg-warning/15 text-warning' :
                            'bg-muted text-muted-foreground'
                          )}>
                            {conv.status === 'open' ? t('contacts.statusOpen')
                              : conv.status === 'pending' ? t('contacts.statusPending')
                              : t('contacts.statusClosed')}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </TabsContent>

                <TabsContent value="activity" className="p-5 mt-0">
                  <div className="space-y-3">
                    <ActivityItem time={contact.created_at} label={t('contacts.activityCreated')} />
                    {contact.updated_at !== contact.created_at && (
                      <ActivityItem time={contact.updated_at} label={t('contacts.activityUpdated')} />
                    )}
                  </div>
                </TabsContent>
              </ScrollArea>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
        <p className="text-sm text-foreground truncate">{value || '—'}</p>
      </div>
    </div>
  );
}

function ActivityItem({ time, label }: { time?: string | null; label: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{time ? new Date(time).toLocaleString() : ''}</p>
      </div>
    </div>
  );
}
