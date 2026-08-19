import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API_BASE } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Building2, Globe, Loader2 } from 'lucide-react';
import { useCreateWorkspace, useAccount } from '@/hooks/useWorkspace';
import { toast } from '@/lib/toast';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const navigate = useNavigate();
  const { data: account } = useAccount();
  const createWorkspace = useCreateWorkspace();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !account?.id) return;

    try {
      const newWsId = await createWorkspace.mutateAsync({
        accountId: account.id,
        name: name.trim(),
      });

      // Fetch the new workspace slug and navigate directly to it
      const res = await fetch(`${API_BASE}/api/workspaces/${newWsId}`, { credentials: 'include' });
      const newWs = res.ok ? await res.json() : null;

      toast.success('Workspace created successfully');
      setName('');
      setDomain('');
      onOpenChange(false);

      navigate(newWs?.slug ? `/app/w/${newWs.slug}` : '/app');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create workspace');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Create a new workspace
          </DialogTitle>
          <DialogDescription>
            Each workspace has its own inbox, contacts, widget, and settings.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Company name</Label>
            <div className="relative">
              <Building2 className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="ws-name"
                placeholder="Acme Inc."
                value={name}
                onChange={e => setName(e.target.value)}
                className="ps-9"
                autoFocus
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ws-domain">Website (optional)</Label>
            <div className="relative">
              <Globe className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="ws-domain"
                placeholder="acme.com"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                className="ps-9"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Used for widget configuration and branding.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createWorkspace.isPending}>
              {createWorkspace.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              Create workspace
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
