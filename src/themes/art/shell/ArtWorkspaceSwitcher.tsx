import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronsUpDown, ExternalLink, Lock, Plus, UserPlus } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { ImageWithSkeleton } from '@/components/common/ImageWithSkeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CreateWorkspaceDialog } from '@/features/workspace/CreateWorkspaceDialog';
import { useWorkspaceCapacity } from '@/features/workspace/useWorkspaceCapacity';
import { useArtWorkspace } from './useArtWorkspace';
import { artMenuContent, artMenuItem, artMenuLabel } from './styles';

/** The workspace's logo, or a building on a clay tile. */
function ArtWorkspaceMark({ logoUrl, className }: { logoUrl: string; className?: string }) {
  return (
    <span
      data-shell="workspace-mark"
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-primary to-primary/75 text-primary-foreground',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.2),0_1px_2px_0_hsl(var(--art-shadow)/0.18)]',
        className,
      )}
    >
      {logoUrl ? (
        <ImageWithSkeleton src={logoUrl} className="h-full w-full object-cover" />
      ) : (
        <Building2 className="h-[18px] w-[18px]" strokeWidth={2.1} />
      )}
    </span>
  );
}

/**
 * The workspace's name at the start of the header; it opens the switcher.
 * Same entries and rules as the classic sidebar's workspace menu: the
 * workspaces to switch to, creating one (after the plan's capacity check),
 * inviting an operator, and the workspace's site.
 */
export function ArtWorkspaceSwitcher({
  isWorkspaceAdmin,
  className,
}: {
  isWorkspaceAdmin: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { workspace, workspaces, name, domain, logoUrl } = useArtWorkspace();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [limitNotice, setLimitNotice] = useState(false);
  const { data: capacity, isLoading: capacityLoading } = useWorkspaceCapacity(open);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setLimitNotice(false);
  };

  return (
    <>
      {/* Not modal: the create dialog opens as the menu closes. */}
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-shell="workspace-switcher"
            aria-label={t('artShell.switchWorkspace')}
            className={cn(
              'flex h-11 min-w-0 shrink items-center gap-2.5 rounded-full py-1 pe-3 ps-1 text-start transition-colors',
              'hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/80',
              className,
            )}
          >
            <ArtWorkspaceMark logoUrl={logoUrl} className="h-9 w-9" />
            <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{name}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={10} className={cn(artMenuContent, 'max-h-[70vh] w-72 overflow-y-auto')}>
          <DropdownMenuLabel className={artMenuLabel}>{t('artShell.workspaces')}</DropdownMenuLabel>
          {workspaces.map((ws) => {
            const current = workspace?.id === ws.id;
            return (
              <DropdownMenuItem
                key={ws.id}
                onSelect={() => navigate(`/${ws.slug}`)}
                className={cn(artMenuItem, 'py-1.5', current && 'bg-primary/[0.07]')}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.625rem] bg-primary/10 text-[13px] font-semibold text-primary">
                  {ws.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{ws.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" dir="ltr">{ws.slug}</span>
                </span>
                {current && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </DropdownMenuItem>
            );
          })}

          {isWorkspaceAdmin && (
            <>
              <DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-foreground/[0.07]" />
              {limitNotice ? (
                <div className="m-1 space-y-2.5 rounded-xl bg-destructive/[0.07] px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-destructive">{t('workspaceCreate.limitTitle')}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {t('workspaceCreate.limitDesc')
                          .replace('{limit}', capacity?.limit == null ? t('workspaceCreate.unlimited') : String(capacity.limit))
                          .replace('{used}', String(capacity?.used ?? 0))}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      className="h-8 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-background"
                      onClick={() => setLimitNotice(false)}
                    >
                      {t('workspaceCreate.cancel')}
                    </button>
                    <button
                      type="button"
                      className="h-8 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                      onClick={() => {
                        onOpenChange(false);
                        navigate(wsPath('/billing'));
                      }}
                    >
                      {t('workspaceCreate.upgrade')}
                    </button>
                  </div>
                </div>
              ) : (
                <DropdownMenuItem
                  disabled={capacityLoading}
                  className={artMenuItem}
                  onSelect={(e) => {
                    if (capacity && !capacity.canCreate) {
                      e.preventDefault();
                      setLimitNotice(true);
                      return;
                    }
                    setCreateOpen(true);
                  }}
                >
                  <Plus />
                  <span className="flex-1">{t('workspaceCreate.menuAction')}</span>
                  {capacity?.limit != null && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {capacity.used} / {capacity.limit}
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild className={artMenuItem}>
                <Link to={wsPath('/team')}>
                  <UserPlus />
                  <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
                </Link>
              </DropdownMenuItem>
            </>
          )}

          {domain && (
            <>
              <DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-foreground/[0.07]" />
              <DropdownMenuItem asChild className={cn(artMenuItem, 'text-muted-foreground')}>
                <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  <span className="truncate" dir="ltr">{domain}</span>
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} upgradeHref={wsPath('/billing')} />
    </>
  );
}
