/**
 * What a code-split page's area shows while its file loads, and when it
 * cannot be loaded (src/lib/perf/lazyPage.tsx). Components only, so Fast
 * Refresh keeps working for this file and for lazyPage.tsx.
 */
import { Component, useState, type ReactNode } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { BrandFooter, BrandLoader } from '@/components/brand/BrandLoader';
import { useI18n } from '@/i18n';
import { hasLiveMediaCapture, isChunkLoadError } from './chunkReload';
import { hasShownPage } from './pageShown';

/** The page-area skeleton. Token colours only, so Classic and Art both fit. */
export function PageFallback({ inset = false }: { inset?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-busy="true"
      data-page-fallback=""
      className={`animate-[fade-in_240ms_ease-out_180ms_both] motion-reduce:animate-none ${inset ? 'p-4 sm:p-6' : ''}`}
    >
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="h-7 w-48 max-w-[60%] rounded-lg" />
      <Skeleton className="mt-2 h-4 w-80 max-w-[85%]" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="hidden h-28 rounded-2xl sm:block" />
        <Skeleton className="hidden h-28 rounded-2xl xl:block" />
      </div>
      <Skeleton className="mt-4 h-72 rounded-2xl" />
    </div>
  );
}

/**
 * Frameless pages (sign-in, public, native) while their file loads.
 *
 * At start-up, before any page has been on screen, this is the launch
 * loader itself: the static #boot-splash in index.html fades out as soon as
 * the app has rendered (src/main.tsx), and without a copy underneath it the
 * sign-in screen would be an empty background until its file arrived. The
 * `.wy-launch` styles live in index.html, so the copy is pixel-identical.
 * After that (moving between sign-in pages) it draws nothing: these files
 * are small and a full-screen loader would only flash.
 */
export function BlankPageFallback() {
  const [starting] = useState(() => !hasShownPage());
  if (!starting) return null;
  return (
    <div className="wy-launch" data-page-fallback="launch">
      <BrandLoader />
      <BrandFooter />
    </div>
  );
}

export function PageLoadError() {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      data-page-load-error=""
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <WifiOff className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-sm text-sm text-muted-foreground">{t('workspaceRedirect.connectionFailed')}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // A reload is the only cure (see chunkReload.ts), but it would end a
          // live call: ask first.
          if (hasLiveMediaCapture() && !window.confirm(t('workspaceRedirect.reloadEndsCall'))) return;
          window.location.reload();
        }}
      >
        <RefreshCw aria-hidden="true" />
        {t('workspaceRedirect.tryAgain')}
      </Button>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** The current pathname: moving to another URL clears a failure. */
  resetKey: string;
  /** Called once a load failure is on screen, so the next attempt starts afresh. */
  onLoadError?: () => void;
}

interface BoundaryState {
  failed: boolean;
  error: unknown;
}

/**
 * Catches a page whose code could not be loaded. Every other error is thrown
 * on unchanged, so the app's existing error handling sees exactly what it
 * saw before pages were split out.
 *
 * Routes that render the same page (`email` and `email/:threadId`,
 * `seo/:section`, ...) keep this boundary mounted while the URL changes, so
 * a failure is cleared when the URL does; the page then mounts again and
 * makes a new attempt (onLoadError has handed lazyPage a fresh loader).
 */
export class PageLoadBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) this.props.onLoadError?.();
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, error: null });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (!isChunkLoadError(this.state.error)) throw this.state.error;
    return <PageLoadError />;
  }
}
