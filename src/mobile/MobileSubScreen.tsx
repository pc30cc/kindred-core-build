/**
 * Native (iOS) sub-screen wrapper.
 *
 * Pushes an existing settings surface into the app shell with a compact,
 * centered nav bar and a back button, so the phone app can reuse the exact
 * same, already-audited settings logic instead of forking it.
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { MobileScreen } from './MobileScreen';

export function MobileSubScreen({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { dir } = useTranslation();
  const BackIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;

  return (
    <MobileScreen
      compact
      centered
      title={title}
      leading={
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-full p-1.5 text-primary transition-transform active:scale-90"
          aria-label="Back"
        >
          <BackIcon className="h-[26px] w-[26px]" />
        </button>
      }
      bodyClassName="pb-8"
    >
      <div className="px-3 py-4 [&_.grid]:grid-cols-1">{children}</div>
    </MobileScreen>
  );
}
