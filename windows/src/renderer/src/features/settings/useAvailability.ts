import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '@/api/client'
import type { AvailabilityPrefs, AvailabilityResponse } from '@/api/types'

// Whether visitors can see this operator. The app sends each switch on its own and
// takes the server's recomputed status back rather than working the rule out here.

interface AvailabilityStore {
  availability: AvailabilityResponse | null
  saving: boolean
  failed: boolean
  load(): Promise<void>
  update(change: Partial<Pick<AvailabilityPrefs, 'force_offline' | 'available_when_using_app' | 'schedule_enabled'>>): Promise<void>
}

const useStore = create<AvailabilityStore>((set, get) => ({
  availability: null,
  saving: false,
  failed: false,
  async load() {
    try {
      set({ availability: await api.availability() })
    } catch {
      // Presence is a nicety on top of the app; leave what we had.
    }
  },
  async update(change) {
    const previous = get().availability
    if (previous) set({ availability: { ...previous, prefs: { ...previous.prefs, ...change } } })
    set({ saving: true, failed: false })
    try {
      set({ availability: await api.updateAvailability(change) })
    } catch {
      set({ availability: previous, failed: true })
    } finally {
      set({ saving: false })
    }
  },
}))

export function useAvailability() {
  const store = useStore()
  useEffect(() => {
    if (!store.availability) void store.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return store
}

export const reloadAvailability = () => useStore.getState().load()
