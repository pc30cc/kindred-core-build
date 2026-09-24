import { UserRound } from 'lucide-react';
import { AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/** Shown wherever an operator has no photo: a violet person figure in a circle. */
export function OperatorAvatarFallback({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <AvatarFallback className={cn('bg-brand-violet/15 text-brand-violet ring-1 ring-brand-violet/30', className)}>
      <UserRound className={cn('h-[60%] w-[60%]', iconClassName)} />
    </AvatarFallback>
  );
}
