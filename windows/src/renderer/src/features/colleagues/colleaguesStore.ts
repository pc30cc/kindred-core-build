import { create } from 'zustand'
import { api, ApiError } from '@/api/client'
import type { Colleague, ColleaguesResponse } from '@/api/types'
import { useApp } from '@/store/app'

export function colleagueName(c: Pick<Colleague, 'full_name' | 'email'>): string {
  return c.full_name?.trim() || c.email || '—'
}

// Shared with the background poller, which keeps the rail's badge current.
export const useColleagues = create<{ data: ColleaguesResponse | null; error: ApiError | null; set(d: ColleaguesResponse | null, e?: ApiError | null): void }>((set) => ({
  data: null,
  error: null,
  set: (data, error = null) => set({ data, error }),
}))

export async function refreshColleagues(workspaceId: string) {
  try {
    const data = await api.colleagues(workspaceId)
    useColleagues.getState().set(data)
    useApp.getState().setUnread('colleagues', data.total_unread ?? data.colleagues.reduce((n, c) => n + (c.unread ?? 0), 0))
  } catch (e) {
    if (!useColleagues.getState().data) useColleagues.getState().set(null, e instanceof ApiError ? e : new ApiError('transport'))
  }
}
