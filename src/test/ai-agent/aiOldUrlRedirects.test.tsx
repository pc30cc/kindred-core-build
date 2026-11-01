/**
 * The AI section's old URLs keep working (owner, 2026-11-01): its knowledge
 * pages open their Knowledge Base tab, its four settings pages the one
 * settings page, «شخصیت و رفتار». The redirects are read from App.tsx's
 * ai-agent route block as they are written (relative `to`s) and resolved by
 * the real router under the same nesting (/:slug → ai-agent → page), so a
 * wrong number of `..` shows here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const start = app.indexOf('<Route path="ai-agent"');
const block = app.slice(start, app.indexOf('</Route>', start));
/** path → the `to` of its <Navigate>, for the block's redirect routes. */
const REDIRECTS = new Map(
  [...block.matchAll(/<Route path="([^"]+)" element=\{<Navigate to="([^"]+)" replace \/>\}\s*\/>/g)].map((m) => [m[1], m[2]]),
);

function Landed() {
  const { pathname, search } = useLocation();
  return <output data-testid="landed">{pathname + search}</output>;
}

function open(url: string) {
  cleanup();
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug" element={<Outlet />}>
          <Route path="ai-agent" element={<Outlet />}>
            {[...REDIRECTS].map(([path, to]) => (
              <Route key={path} path={path} element={<Navigate to={to} replace />} />
            ))}
            <Route path="behavior" element={<Landed />} />
          </Route>
          <Route path="knowledge-base" element={<Landed />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('landed').textContent;
}

describe('the AI section’s old URLs', () => {
  it.each([
    ['knowledge', '/acme/knowledge-base?tab=status'],
    ['train', '/acme/knowledge-base?tab=status'],
    ['web-pages', '/acme/knowledge-base?tab=web'],
    ['learning-candidates', '/acme/knowledge-base?tab=learning'],
    ['activation', '/acme/ai-agent/behavior'],
    ['instructions', '/acme/ai-agent/behavior'],
    ['guidance', '/acme/ai-agent/behavior'],
    ['settings', '/acme/ai-agent/behavior'],
  ])('/acme/ai-agent/%s opens %s', (path, target) => {
    expect(REDIRECTS.has(path)).toBe(true);
    expect(open(`/acme/ai-agent/${path}`)).toBe(target);
  });
});
