import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useContacts, useCreateContact, useDeleteContact } from '@/hooks/useContacts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, User } from 'lucide-react';

export default function ContactsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: contacts, isLoading } = useContacts(workspace?.id);
  const createContact = useCreateContact(workspace?.id);
  const deleteContact = useDeleteContact();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });

  const handleCreate = async () => {
    await createContact.mutateAsync(form);
    setForm({ name: '', email: '', phone: '' });
    setOpen(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('contacts.title')}</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />{t('contacts.addContact')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('contacts.addContact')}</DialogTitle>
            </DialogHeader>
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

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
          ) : !contacts?.length ? (
            <div className="p-8 text-center">
              <User className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">{t('contacts.noContacts')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('contacts.name')}</TableHead>
                  <TableHead>{t('contacts.email')}</TableHead>
                  <TableHead>{t('contacts.phone')}</TableHead>
                  <TableHead>{t('contacts.tags')}</TableHead>
                  <TableHead className="w-16">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map(contact => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium">{contact.name || '—'}</TableCell>
                    <TableCell>{contact.email || '—'}</TableCell>
                    <TableCell>{contact.phone || '—'}</TableCell>
                    <TableCell>
                      {contact.tags?.map(tag => (
                        <Badge key={tag} variant="secondary" className="me-1">{tag}</Badge>
                      ))}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteContact.mutate(contact.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
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
