import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useContact, useContactConversations, useUpdateContact, useDeleteContact } from '@/hooks/useContacts';
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
  ArrowLeft, Mail, Phone, MapPin, Building2, Calendar, MessageSquare,
  Trash2, Edit3, Save, X, Loader2, Activity, User as UserIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  getInitials, getDisplayName, timeAgo,
  getCompanyFromMetadata, getLocationFromMetadata,
} from '@/features/contacts/utils';
import { ContactPrivacyActions } from '@/components/privacy/ContactPrivacyActions';

export default function ContactDetailPage() {
  const { dir } = useTranslation();
  const { id, slug: wsSlug } = useParams();
  const navigate = useNavigate();
  const { data: contact, isLoading } = useContact(id);
  const { data: conversations } = useContactConversations(id);
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
      toast({ title: 'Contact updated' });
      setEditing(false);
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message, variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!contact) return;
    try {
      await deleteMutation.mutateAsync(contact.id);
      toast({ title: 'Contact deleted' });
      navigate(`/app/w/${wsSlug}/contacts`);
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message, variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!contact) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <p className="text-muted-foreground">Contact not found</p>
        <Link to={`/app/w/${wsSlug}/contacts`}>
          <Button variant="outline">Back to contacts</Button>
        </Link>
      </div>
    );
  }

  const company = getCompanyFromMetadata(contact);
  const loc = getLocationFromMetadata(contact);

  return (
    <div className="flex flex-col h-full bg-background" dir={dir}>
      {/* Header */}
      <div className="border-b border-border bg-card px-5 py-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/app/w/${wsSlug}/contacts`)} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />Back
        </Button>
        <div className="flex-1" />
        {!editing ? (
          <>
            <Button size="sm" variant="outline" onClick={startEdit} className="gap-1.5">
              <Edit3 className="w-3.5 h-3.5" />Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete contact?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>{getDisplayName(contact)}</strong>.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} className="gap-1.5">
              <X className="w-3.5 h-3.5" />Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Save className="w-3.5 h-3.5" />Save</>}
            </Button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sidebar */}
          <Card className="lg:col-span-1 h-fit">
            <CardContent className="p-5">
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-2xl font-bold text-primary mb-3">
                  {contact.avatar_url ? (
                    <img src={contact.avatar_url} alt="" className="w-20 h-20 rounded-full object-cover" />
                  ) : (
                    getInitials(contact.name, contact.email)
                  )}
                </div>
                <h2 className="text-base font-bold text-foreground">{getDisplayName(contact)}</h2>
                {company && <p className="text-xs text-muted-foreground mt-0.5">{company}</p>}
                <div className="flex flex-wrap gap-1 justify-center mt-3">
                  {(contact.tags ?? []).map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                  ))}
                </div>
              </div>

              <div className="mt-5 pt-5 border-t border-border space-y-3">
                <Row icon={Mail} label="Email" value={contact.email} />
                <Row icon={Phone} label="Phone" value={contact.phone} />
                <Row icon={Building2} label="Company" value={company} />
                <Row icon={MapPin} label="Location" value={[loc.city, loc.country].filter(Boolean).join(', ') || null} />
                <Row icon={Calendar} label="Created" value={contact.created_at ? new Date(contact.created_at).toLocaleString() : null} />
                <Row icon={Calendar} label="Last update" value={contact.updated_at ? timeAgo(contact.updated_at) : null} />
              </div>
            </CardContent>
          </Card>

          {/* Main */}
          <div className="lg:col-span-2">
            <Tabs defaultValue={editing ? 'profile' : 'conversations'}>
              <TabsList>
                <TabsTrigger value="profile" className="gap-1.5"><UserIcon className="w-3.5 h-3.5" />Profile</TabsTrigger>
                <TabsTrigger value="conversations" className="gap-1.5"><MessageSquare className="w-3.5 h-3.5" />Conversations</TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5"><Activity className="w-3.5 h-3.5" />Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="profile" className="mt-4">
                <Card>
                  <CardContent className="p-5 space-y-4">
                    {editing ? (
                      <>
                        <Field label="Name"><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>
                        <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} /></Field>
                        <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} /></Field>
                        <Field label="Tags (comma-separated)"><Input value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} /></Field>
                        <Field label="Notes"><Textarea rows={5} value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} /></Field>
                      </>
                    ) : (
                      <div className="space-y-3 text-sm">
                        {(contact as any).notes ? (
                          <div>
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Notes</p>
                            <p className="whitespace-pre-wrap text-foreground">{(contact as any).notes}</p>
                          </div>
                        ) : (
                          <p className="text-muted-foreground italic text-sm">No notes yet. Click Edit to add some.</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="conversations" className="mt-4">
                <Card>
                  <CardContent className="p-0">
                    <ScrollArea className="max-h-[500px]">
                      {!conversations?.length ? (
                        <div className="text-center py-16 text-muted-foreground">
                          <MessageSquare className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
                          <p className="text-sm">No conversations yet</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-border">
                          {conversations.map((conv: any) => (
                            <div
                              key={conv.id}
                              className="p-4 hover:bg-secondary/40 cursor-pointer transition-colors"
                              onClick={() => navigate(`/app/w/${wsSlug}/inbox`)}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm text-foreground line-clamp-1">
                                    {conv.subject || `Conversation #${conv.id.slice(0, 8)}`}
                                  </p>
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <span className={cn(
                                      'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                                      conv.status === 'open' ? 'bg-success/15 text-success' :
                                      conv.status === 'pending' ? 'bg-warning/15 text-warning' :
                                      'bg-muted text-muted-foreground'
                                    )}>
                                      {conv.status}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {timeAgo(conv.updated_at)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="activity" className="mt-4">
                <Card>
                  <CardContent className="p-5 space-y-3">
                    <ActivityRow time={contact.created_at} label="Contact was created" />
                    {contact.updated_at !== contact.created_at && (
                      <ActivityRow time={contact.updated_at} label="Contact was updated" />
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
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
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
        <p className="text-[11px] text-muted-foreground">{time ? new Date(time).toLocaleString() : ''}</p>
      </div>
    </div>
  );
}
