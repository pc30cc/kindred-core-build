import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useKBArticles, useKBCategories, useCreateKBArticle, useDeleteKBArticle } from '@/hooks/useKnowledgeBase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, BookOpen, Search } from 'lucide-react';

export default function KnowledgeBasePage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const [locale, setLocale] = useState('en');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: articles, isLoading } = useKBArticles(workspace?.id, locale, statusFilter);
  const { data: categories } = useKBCategories(workspace?.id, locale);
  const createArticle = useCreateKBArticle(workspace?.id);
  const deleteArticle = useDeleteKBArticle();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '', slug: '', content: '', excerpt: '', locale: 'en',
    status: 'draft' as const, category_id: '',
  });

  const handleCreate = async () => {
    const slug = form.slug || form.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    await createArticle.mutateAsync({
      ...form,
      slug,
      category_id: form.category_id || undefined,
    } as any);
    setForm({ title: '', slug: '', content: '', excerpt: '', locale: 'en', status: 'draft', category_id: '' });
    setOpen(false);
  };

  const filtered = articles?.filter(a =>
    !searchQuery || a.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const statusBadge: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    published: 'bg-success text-success-foreground',
    archived: 'bg-warning text-warning-foreground',
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('knowledgeBase.title')}</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />{t('knowledgeBase.newArticle')}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('knowledgeBase.newArticle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Slug</Label>
                  <Input value={form.slug} onChange={e => setForm(p => ({ ...p, slug: e.target.value }))} placeholder="auto-generated" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Locale</Label>
                  <Select value={form.locale} onValueChange={v => setForm(p => ({ ...p, locale: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="fa">فارسی</SelectItem>
                      <SelectItem value="tr">Türkçe</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v as any }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
                      <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={form.category_id} onValueChange={v => setForm(p => ({ ...p, category_id: v }))}>
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      {categories?.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Excerpt</Label>
                <Input value={form.excerpt} onChange={e => setForm(p => ({ ...p, excerpt: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Content</Label>
                <Textarea rows={8} value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleCreate} disabled={createArticle.isPending || !form.title}>
                {createArticle.isPending ? t('common.loading') : t('common.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="ps-9"
            placeholder={t('knowledgeBase.searchArticles')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <Select value={locale} onValueChange={setLocale}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="fa">فارسی</SelectItem>
            <SelectItem value="tr">Türkçe</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">{t('knowledgeBase.draft')}</SelectItem>
            <SelectItem value="published">{t('knowledgeBase.published')}</SelectItem>
            <SelectItem value="archived">{t('knowledgeBase.archived')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
          ) : !filtered?.length ? (
            <div className="p-8 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">{t('knowledgeBase.noArticles')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>Locale</TableHead>
                  <TableHead className="w-16">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(article => (
                  <TableRow key={article.id}>
                    <TableCell className="font-medium">{article.title}</TableCell>
                    <TableCell>{(article as any).knowledge_base_categories?.name || '—'}</TableCell>
                    <TableCell>
                      <Badge className={statusBadge[article.status]}>{article.status}</Badge>
                    </TableCell>
                    <TableCell><Badge variant="outline">{article.locale}</Badge></TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => deleteArticle.mutate(article.id)}>
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
