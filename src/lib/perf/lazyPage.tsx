/**
 * Route-level code splitting: each page of src/App.tsx is its own JS file,
 * downloaded the first time the page is opened (or earlier, by the prefetch
 * in src/lib/perf/prefetch.ts), instead of all ~150 pages arriving in one
 * multi-megabyte bundle before anything can be drawn.
 *
 * `lazyPage(() => import('...'))` returns a component that:
 *  - renders the page straight away when its code is already here (a
 *    prefetched or previously opened page never shows a loading frame);
 *  - otherwise suspends INSIDE the route, so the layout around it (sidebar,
 *    top bar, Art's frame, the admin menu) stays on screen and only the page
 *    area shows a light skeleton. The skeleton fades in after a short delay,
 *    so a fast load shows no flash at all;
 *  - recovers from a page file that vanished in a deploy with one guarded
 *    reload (src/lib/perf/chunkReload.ts), and otherwise offers "try again"
 *    in place of the page. A later visit to the page, or another URL served
 *    by the same page, tries the download again.
 *
 * `Page.preload()` starts the download early and never rejects.
 * The loading and error states are in ./PageLoadStates.tsx.
 */
import {
  Suspense,
  createElement,
  lazy,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
} from 'react';
import { useLocation } from 'react-router-dom';
import { loadWithChunkRecovery } from './chunkReload';
import { markPageShown } from './pageShown';
import { BlankPageFallback, PageFallback, PageLoadBoundary } from './PageLoadStates';

// Page components take any props (LegalPage takes `doc`); ComponentProps<T>
// below keeps each page's own props type-checked at its route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/**
 * What the page area shows while the page's code loads:
 *  - `page`: a content skeleton (pages inside the workspace / admin frames);
 *  - `inset`: the same with its own padding, for full-bleed pages (inbox,
 *    email) whose frame has none;
 *  - `blank`: nothing (sign-in, public and other frameless pages, where a
 *    dashboard skeleton would be the wrong shape; they load in parallel with
 *    the app itself, see preloadPath in App.tsx). While the app is still
 *    starting, the launch loader stays up instead (BlankPageFallback).
 */
export type PageFallbackKind = 'page' | 'inset' | 'blank';

export interface Preloadable {
  preload: () => Promise<void>;
}

export interface LazyPage<T extends AnyComponent> extends Preloadable {
  (props: ComponentProps<T>): JSX.Element;
  displayName?: string;
}

export function lazyPage<T extends AnyComponent>(
  load: () => Promise<{ default: T }>,
  options: { fallback?: PageFallbackKind } = {},
): LazyPage<T> {
  const fallbackKind = options.fallback ?? 'page';
  let resolved: T | null = null;
  let pending: Promise<{ default: T }> | null = null;

  const loadOnce = (): Promise<{ default: T }> => {
    if (!pending) {
      pending = load().then(
        (mod) => {
          resolved = mod.default;
          return mod;
        },
        (error: unknown) => {
          // Let a later attempt (navigation, hover) try again.
          pending = null;
          throw error;
        },
      );
    }
    return pending;
  };

  // React.lazy keeps a rejection for good. Once the boundary has shown a
  // failure, the next mount gets a fresh one and downloads again. (Not from
  // the rejection itself: React retries the suspended render, and a fresh
  // loader there would retry for ever instead of reaching the boundary.)
  const createLazy = (): LazyExoticComponent<T> => lazy(() => loadWithChunkRecovery(loadOnce));
  let Lazy = createLazy();
  const renewLoader = () => {
    if (!resolved) Lazy = createLazy();
  };

  const fallback =
    fallbackKind === 'blank' ? <BlankPageFallback /> : <PageFallback inset={fallbackKind === 'inset'} />;

  // The page itself, below the boundary: it mounts again after a failure.
  function PageBody(props: object) {
    // Picked once per mount. Switching from the lazy wrapper to the real
    // component on a later render would change the element type and
    // remount the page, dropping its state.
    const [Target] = useState<AnyComponent>(() => resolved ?? Lazy);
    useEffect(markPageShown, []);
    return createElement(Target, props);
  }

  function Page(props: ComponentProps<T>) {
    const { pathname } = useLocation();
    // Same props, same element: a navigation that only changes the URL does
    // not render the page again on this component's account.
    const body = useMemo(() => createElement(PageBody as AnyComponent, props), [props]);
    return (
      <PageLoadBoundary resetKey={pathname} onLoadError={renewLoader}>
        <Suspense fallback={fallback}>{body}</Suspense>
      </PageLoadBoundary>
    );
  }

  Page.preload = (): Promise<void> => loadOnce().then(
    () => undefined,
    () => undefined,
  );
  return Page;
}
