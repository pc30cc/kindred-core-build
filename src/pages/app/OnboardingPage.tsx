import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCreateWorkspace } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createWorkspace = useCreateWorkspace();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slug || slug === name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')) {
      setSlug(val.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !slug.trim()) return;
    setError('');
    try {
      await createWorkspace.mutateAsync({ name, slug });
      navigate('/app');
    } catch (e: any) {
      setError(e.message || 'Failed to create workspace');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create your workspace</CardTitle>
          <CardDescription>Set up your workspace to get started</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="space-y-2">
            <Label>Workspace Name</Label>
            <Input value={name} onChange={e => handleNameChange(e.target.value)} placeholder="My Company" />
          </div>
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="my-company" />
            <p className="text-xs text-muted-foreground">Used in URLs and API endpoints</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={handleCreate} className="w-full" disabled={!name || !slug || createWorkspace.isPending}>
            {createWorkspace.isPending ? t('common.loading') : t('common.create')}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
