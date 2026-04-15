import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useContacts, useCreateContact, useDeleteContact } from '@/hooks/useContacts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, User, Users, Mail, Phone, Search } from 'lucide-react';

export default function ContactsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: contacts, isLoading } = useContacts(workspace?.id);
  const createContact = useCreateContact(workspace?.id);
  const deleteContact = useDeleteContact();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [search, setSearch] = useState('');

  const handleCreate = async () => {
    await createContact.mutateAsync(form);
    setForm({ name: '', email: '', phone: '' });
    setOpen(false);
  };

  const filtered = contacts?.filter(c =>
    !search || [c.name, c.email, c.phone].some(f => f?.toLowerCase().includes(search.toLowerCase()))
  );

  const withEmail = contacts?.filter(c => c.email)?.length || 0;
  const withPhone = contacts?.filter(c => c.phone)?.length || 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-header">{t('contacts.title')}</h1>
          <p className="page-subtitle mt-1">Manage your contacts and leads</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />{t('contacts.addContact')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('contacts.addContact')}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('contacts.name')}</Label>
                <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('contacts.email')}</Label>
                <Input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('contacts.phone')}</Label>
                <Input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleCreate} disabled={createContact.isPending}>
                {createContact.isPending ? t('common.loading') : t('common.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10"><Users className="h-5 w-5 text-primary" /></div>
            <div>
              <p className="text-2xl font-bold text-foreground">{contacts?.length || 0}</p>
              <p className="text-xs text-muted-foreground">Total Contacts</p>
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-info/10"><Mail className="h-5 w-5 text-info" /></div>
            <div>
              <p className="text-2xl font-bold text-foreground">{withEmail}</p>
              <p className="text-xs text-muted-foreground">With Email</p>
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-success/10"><Phone className="h-5 w-5 text-success" /></div>
            <div>
              <p className="text-2xl font-bold text-foreground">{withPhone}</p>
              <p className="text-xs text-muted-foreground">With Phone</p>
            </div>
          </div>
        </div>
      </div>

      <Card className="card-elevated">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-sm font-semibold">All Contacts</h3>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts..." className="pl-9 text-xs" />
          </div>
        </div>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
          ) : !filtered?.length ? (
            <div className="p-12 text-center">
              <User className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground font-medium">{t('contacts.noContacts')}</p>
              <p className="text-xs text-muted-foreground mt-1">Add your first contact to get started</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('contacts.name')}</TableHead>
                  <TableHead>{t('contacts.email')}</TableHead>
                  <TableHead>{t('contacts.phone')}</TableHead>
                  <TableHead>{t('contacts.tags')}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(contact => (
                  <TableRow key={contact.id} className="hover:bg-muted/30">
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <span className="text-xs font-semibold text-primary">{(contact.name || '?').charAt(0).toUpperCase()}</span>
                        </div>
                        <span className="font-medium text-sm">{contact.name || '—'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{contact.email || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{contact.phone || '—'}</TableCell>
                    <TableCell>
                      {contact.tags?.map(tag => (
                        <Badge key={tag} variant="secondary" className="me-1 text-[10px]">{tag}</Badge>
                      ))}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteContact.mutate(contact.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
