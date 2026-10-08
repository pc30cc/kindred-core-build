/**
 * src/lib/perf/lazyPage.tsx: what a code-split page shows while its file
 * loads, once it has loaded, and when it cannot be loaded.
 */
import { Component, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyPage } from '@/lib/perf/lazyPage';
import { CHUNK_RELOAD_KEY } from '@/lib/perf/chunkReload';
import { hasShownPage, markPageShown, resetPageShown } from '@/lib/perf/pageShown';

function Hello({ name }: { name: string }) {
  return <p>hello {name}</p>;
}

type HelloModule = { default: typeof Hello };

const MISSING = () =>
  new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/InboxPage-abc.js');

class Outer extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <p>outer caught: {this.state.error.message}</p> : this.props.children;
  }
}

/** Pages always render inside the app's router. */
const renderAt = (ui: ReactElement, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

beforeEach(() => {
  sessionStorage.clear();
  resetPageShown();
  // React logs every error a boundary catches; the assertions below are on
  // what renders, not on the log.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazyPage', () => {
  it('shows a loading state in the page area, then the page', async () => {
    let arrive!: (mod: HelloModule) => void;
    const Page = lazyPage(() => new Promise<HelloModule>((done) => { arrive = done; }));

    renderAt(<Page name="inbox" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('common.loading')).toBeInTheDocument();
    expect(hasShownPage()).toBe(false);

    await act(async () => {
      arrive({ default: Hello });
    });
    expect(await screen.findByText('hello inbox')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(hasShownPage()).toBe(true);
  });

  it('renders a page whose code is already here at once, with no loading frame', async () => {
    const load = vi.fn(() => Promise.resolve<HelloModule>({ default: Hello }));
    const Page = lazyPage(load);

    await Page.preload();
    await Page.preload();
    expect(load).toHaveBeenCalledTimes(1);

    renderAt(<Page name="contacts" />);
    // Synchronous: no Suspense round-trip for a preloaded page.
    expect(screen.getByText('hello contacts')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the launch loader up for a frameless page while the app is starting', () => {
    const Page = lazyPage(() => new Promise<HelloModule>(() => {}), { fallback: 'blank' });
    const { container } = renderAt(<Page name="login" />);
    // The same markup as index.html's #boot-splash, which fades out over it.
    const launch = container.querySelector('.wy-launch');
    expect(launch).not.toBeNull();
    expect(launch?.querySelector('.wy-loader')).not.toBeNull();
    expect(launch?.querySelector('.wy-footer')).not.toBeNull();
  });

  it('draws nothing for a frameless page once a page has been on screen', () => {
    markPageShown();
    const Page = lazyPage(() => new Promise<HelloModule>(() => {}), { fallback: 'blank' });
    const { container } = renderAt(<Page name="signup" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pads the skeleton of full-bleed pages', () => {
    const Page = lazyPage(() => new Promise<HelloModule>(() => {}), { fallback: 'inset' });
    renderAt(<Page name="inbox" />);
    expect(screen.getByRole('status').className).toMatch(/\bp-4\b/);
  });

  it('never rejects from preload, and a later attempt loads again', async () => {
    let attempts = 0;
    const Page = lazyPage<typeof Hello>(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ default: Hello });
    });
    await expect(Page.preload()).resolves.toBeUndefined();
    await expect(Page.preload()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    renderAt(<Page name="again" />);
    expect(screen.getByText('hello again')).toBeInTheDocument();
  });

  it('offers "try again" when the page file is still missing after the automatic reload', async () => {
    // The guard says this tab already reloaded for a missing chunk just now.
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    const Page = lazyPage<ComponentType>(() => Promise.reject(MISSING()));

    renderAt(
      <Outer>
        <Page />
      </Outer>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('workspaceRedirect.connectionFailed');
    expect(screen.getByRole('button', { name: 'workspaceRedirect.tryAgain' })).toBeInTheDocument();
    expect(screen.queryByText(/outer caught/)).toBeNull();
  });

  it('downloads the page again the next time it is opened after a failure', async () => {
    let attempts = 0;
    const Page = lazyPage<typeof Hello>(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(MISSING()) : Promise.resolve({ default: Hello });
    });

    const first = renderAt(<Page name="retry" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    first.unmount();

    renderAt(<Page name="retry" />);
    expect(await screen.findByText('hello retry')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('clears "try again" when the URL moves to another one served by the same page', async () => {
    let attempts = 0;
    const Page = lazyPage<typeof Hello>(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(MISSING()) : Promise.resolve({ default: Hello });
    });
    let navigate!: (to: string) => void;
    function NavigateCapture() {
      navigate = useNavigate();
      return null;
    }

    renderAt(
      <>
        <NavigateCapture />
        <Routes>
          <Route path="/email" element={<Page name="mailbox" />} />
          <Route path="/email/:threadId" element={<Page name="thread" />} />
        </Routes>
      </>,
      '/email',
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    act(() => navigate('/email/7'));
    expect(await screen.findByText('hello thread')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(attempts).toBe(2);
  });

  it('passes any other load error to the boundary above, as before', async () => {
    const Page = lazyPage<ComponentType>(() => Promise.reject(new Error('module threw')));
    renderAt(
      <Outer>
        <Page />
      </Outer>,
    );
    expect(await screen.findByText('outer caught: module threw')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('passes errors thrown while the page renders to the boundary above', async () => {
    function Broken(): JSX.Element {
      throw new Error('render failed');
    }
    const Page = lazyPage(() => Promise.resolve({ default: Broken }));
    await Page.preload();
    renderAt(
      <Outer>
        <Page />
      </Outer>,
    );
    expect(screen.getByText('outer caught: render failed')).toBeInTheDocument();
  });
});
