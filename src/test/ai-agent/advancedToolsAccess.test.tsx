/**
 * Who may use the AI section's Advanced tools (owner, 2026-11-03;
 * docs/operations/AI_ADVANCED_TOOLS.md): one rule, shared/aiAdvancedTools.ts,
 * read by the web panel's guard and menu (useAiAdvancedToolsAccess) and by
 * the server's guard. The Super Admin always; otherwise the plan's
 * `ai_advanced_tools` exactly true AND the workspace's owner or an admin.
 * While the admin check, the plan or the role loads, nothing is offered (no
 * flash), and an unreadable plan is a no.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { aiAdvancedToolsAllowed, canManageWorkspaceAi } from '../../../shared/aiAdvancedTools';
import { planAccessOf } from '@/lib/planAccess';
import type { WorkspaceEffectiveEntitlements } from '@/lib/entitlements-api';

const state = {
  admin: { data: false as boolean | undefined, isLoading: false },
  plan: { snapshot: null as WorkspaceEffectiveEntitlements | null, failed: false },
  role: { data: 'owner' as string | null | undefined, isLoading: false, isError: false },
  workspaceId: 'ws-1' as string | null,
};

vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => state.admin }));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: state.workspaceId ? { id: state.workspaceId } : null }),
  useWorkspacePath: () => (p: string) => `/w/acme${p}`,
}));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => planAccessOf(state.plan.snapshot, state.plan.failed),
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => state.role }));

const { useAiAdvancedToolsAccess } = await import('@/features/ai-agent/useAiAdvancedToolsAccess');
const { AdvancedAiAgentGuard } = await import('@/features/ai-agent/AdvancedAiAgentGuard');

function snapshot(advanced: boolean | undefined): WorkspaceEffectiveEntitlements {
  return {
    features: advanced === undefined ? {} : { ai_advanced_tools: { value: advanced, source: 'plan' } },
    modules: { ai_assistant: { value: true, source: 'plan' } },
    channels: {},
    limits: {},
  } as unknown as WorkspaceEffectiveEntitlements;
}

beforeEach(() => {
  state.admin = { data: false, isLoading: false };
  state.plan = { snapshot: snapshot(true), failed: false };
  state.role = { data: 'owner', isLoading: false, isError: false };
  state.workspaceId = 'ws-1';
});

describe('the rule (shared/aiAdvancedTools.ts)', () => {
  it('the Super Admin always', () => {
    expect(aiAdvancedToolsAllowed({ isPlatformAdmin: true, planValue: false, role: null })).toBe(true);
    expect(aiAdvancedToolsAllowed({ isPlatformAdmin: true, planValue: undefined, role: 'agent' })).toBe(true);
  });

  it('the owner or an admin with the key', () => {
    expect(aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue: true, role: 'owner' })).toBe(true);
    expect(aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue: true, role: 'admin' })).toBe(true);
  });

  it('an agent (or any other role) with the key: no', () => {
    for (const role of ['agent', 'team_lead', 'support_agent', 'viewer', 'analyst', null, undefined]) {
      expect(aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue: true, role }), String(role)).toBe(false);
    }
  });

  it('the owner without the key, or with anything but exactly true (unread, unreadable): no', () => {
    for (const planValue of [false, undefined, null, 'true', 1]) {
      expect(aiAdvancedToolsAllowed({ isPlatformAdmin: false, planValue, role: 'owner' }), String(planValue)).toBe(false);
    }
  });

  it('the non-production override', () => {
    expect(aiAdvancedToolsAllowed({ isPlatformAdmin: false, devOverride: true, planValue: false, role: null })).toBe(true);
  });

  it('manages the AI: the owner and admins only', () => {
    expect(canManageWorkspaceAi('owner')).toBe(true);
    expect(canManageWorkspaceAi('admin')).toBe(true);
    expect(canManageWorkspaceAi('agent')).toBe(false);
  });
});

describe('useAiAdvancedToolsAccess', () => {
  const access = () => renderHook(() => useAiAdvancedToolsAccess()).result.current;

  it('an owner whose plan has the key: allowed', () => {
    expect(access()).toBe('allowed');
  });

  it('an admin whose plan has the key: allowed; an agent: denied', () => {
    state.role = { data: 'admin', isLoading: false, isError: false };
    expect(access()).toBe('allowed');
    state.role = { data: 'agent', isLoading: false, isError: false };
    expect(access()).toBe('denied');
  });

  it('an owner whose plan does not have it (or does not carry it): denied', () => {
    state.plan = { snapshot: snapshot(false), failed: false };
    expect(access()).toBe('denied');
    state.plan = { snapshot: snapshot(undefined), failed: false };
    expect(access()).toBe('denied');
  });

  it('an unreadable plan: denied', () => {
    state.plan = { snapshot: null, failed: true };
    expect(access()).toBe('denied');
  });

  it('an unreadable role: denied', () => {
    state.role = { data: undefined, isLoading: false, isError: true };
    expect(access()).toBe('denied');
  });

  it('while the plan, the role or the admin check loads: loading, never allowed', () => {
    state.plan = { snapshot: null, failed: false };
    expect(access()).toBe('loading');
    state.plan = { snapshot: snapshot(true), failed: false };
    state.role = { data: undefined, isLoading: true, isError: false };
    expect(access()).toBe('loading');
    state.role = { data: 'owner', isLoading: false, isError: false };
    state.admin = { data: undefined, isLoading: true };
    expect(access()).toBe('loading');
  });

  it('the Super Admin: allowed at once, whatever the plan and role', () => {
    state.admin = { data: true, isLoading: false };
    state.plan = { snapshot: null, failed: false };
    state.role = { data: null, isLoading: false, isError: false };
    expect(access()).toBe('allowed');
  });
});

describe('AdvancedAiAgentGuard', () => {
  function open() {
    return render(
      <MemoryRouter initialEntries={['/w/acme/ai-agent/test-cases']}>
        <Routes>
          <Route path="/w/acme/ai-agent/test-cases" element={<AdvancedAiAgentGuard><p>test cases page</p></AdvancedAiAgentGuard>} />
          <Route path="/w/acme/ai-agent/overview" element={<p>overview page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('opens the page for an owner whose plan has the key', () => {
    open();
    expect(screen.getByText('test cases page')).toBeTruthy();
  });

  it('redirects a customer without it to the overview', () => {
    state.plan = { snapshot: snapshot(false), failed: false };
    open();
    expect(screen.getByText('overview page')).toBeTruthy();
    expect(screen.queryByText('test cases page')).toBeNull();
  });

  it('shows neither the page nor a redirect while the plan loads', () => {
    state.plan = { snapshot: null, failed: false };
    open();
    expect(screen.queryByText('test cases page')).toBeNull();
    expect(screen.queryByText('overview page')).toBeNull();
  });
});
