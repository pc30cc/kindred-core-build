import { useEffect } from 'react'
import { create } from 'zustand'
import { ExternalLink, Megaphone, X } from 'lucide-react'
import { api } from '@/api/client'
import type { PromoCreative, Promotions } from '@/api/types'
import { useApp, planValue } from '@/store/app'
import { featureEnabled, limit } from '@/lib/entitlements'
import { Button, IconButton } from '@/components/ui'
import { useT } from '@/hooks/useT'

// What the platform may show as a promotion, resolved for one language by the server.
// The words and the picture come from the platform's own settings; nothing is
// tracked. Pacing is local, the same rules the iOS app keeps: skip the first
// launches, respect a minimum interval and a daily cap.

const KEYS = { launches: 'promo.launches', last: 'promo.lastShownAt', day: 'promo.day', dayCount: 'promo.dayCount' }

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Pacing is best effort.
  }
}

// Counted once per launch, before anything asks for a promotion.
write(KEYS.launches, String(Number(read(KEYS.launches) ?? 0) + 1))

const today = () => new Date().toISOString().slice(0, 10)

interface PromoStore {
  promotions: Promotions | null
  bannerDismissed: boolean
  fullscreen: PromoCreative | null
  load(workspaceId: string, locale: string): Promise<void>
}

const usePromos = create<PromoStore>((set) => ({
  promotions: null,
  bannerDismissed: false,
  fullscreen: null,
  async load(workspaceId, locale) {
    try {
      set({ promotions: await api.promotions(workspaceId, locale) })
    } catch {
      set({ promotions: null })
    }
  },
}))

function safeLink(url?: string | null): string | null {
  return url && /^https:\/\//i.test(url) ? url : null
}

export function PromoBanner() {
  const t = useT()
  const workspaceId = useApp((s) => s.workspace?.id)
  const language = useApp((s) => s.language)
  const plan = useApp(planValue)
  const { promotions, bannerDismissed, load } = usePromos()

  useEffect(() => {
    if (workspaceId) void load(workspaceId, language)
  }, [workspaceId, language, load])

  // Offered once the inbox has loaded, and only when the pace allows.
  useEffect(() => {
    const p = usePromos.getState().promotions
    if (!p?.enabled || !p.fullscreen || !featureEnabled(plan, 'mobile_promo_fullscreen') || usePromos.getState().fullscreen) return
    const launches = Number(read(KEYS.launches) ?? 0)
    if (launches <= (p.startAfterLaunches ?? 2)) return
    const minutes = Math.max(p.minIntervalMinutes ?? 360, limit(plan, 'mobile_promo_interval_minutes') ?? 0)
    const last = Number(read(KEYS.last) ?? 0)
    if (last && Date.now() - last < minutes * 60_000) return
    const cap = p.maxPerDay ?? 3
    const count = read(KEYS.day) === today() ? Number(read(KEYS.dayCount) ?? 0) : 0
    if (cap <= 0 || count >= cap) return
    write(KEYS.last, String(Date.now()))
    write(KEYS.day, today())
    write(KEYS.dayCount, String(count + 1))
    usePromos.setState({ fullscreen: p.fullscreen })
  }, [promotions, plan])

  const banner = promotions?.enabled && !bannerDismissed && featureEnabled(plan, 'mobile_promo_banner') ? promotions.banner : null
  if (!banner) return null
  const link = safeLink(banner.ctaURL)
  return (
    <div className="relative mx-3 mb-2.5 flex gap-3 overflow-hidden rounded-xl border border-brand/20 bg-brand-soft p-3">
      {banner.imageURL ? <img src={banner.imageURL} alt="" className="size-11 shrink-0 rounded-lg object-cover" /> : <Megaphone className="size-5 shrink-0 text-brand" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-fg">{banner.title}</div>
        <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-2">{banner.body}</div>
        {link && banner.ctaLabel && (
          <button onClick={() => void window.webyar.app.openExternal(link)} className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
            {banner.ctaLabel}
            <ExternalLink className="size-3" />
          </button>
        )}
      </div>
      <IconButton size="sm" icon={X} label={t('close')} onClick={() => usePromos.setState({ bannerDismissed: true })} />
    </div>
  )
}

export function PromoFullScreen() {
  const t = useT()
  const creative = usePromos((s) => s.fullscreen)
  if (!creative) return null
  const close = () => usePromos.setState({ fullscreen: null })
  const link = safeLink(creative.ctaURL)
  return (
    <div className="fade-in no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm" onMouseDown={close}>
      <div className="pop-in w-full max-w-[460px] overflow-hidden rounded-2xl bg-surface shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        {creative.imageURL ? (
          <img src={creative.imageURL} alt="" className="aspect-video w-full object-cover" />
        ) : (
          <div className="flex aspect-video items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--brand), #6a4de0)' }}>
            <Megaphone className="size-14 text-white/90" />
          </div>
        )}
        <div className="p-6">
          <h3 className="text-[19px] font-bold">{creative.title}</h3>
          <p className="mt-2 text-[14px] text-fg-2">{creative.body}</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={close}>{t('notNow')}</Button>
            {link && creative.ctaLabel && (
              <Button
                variant="primary"
                icon={ExternalLink}
                onClick={() => {
                  void window.webyar.app.openExternal(link)
                  close()
                }}
              >
                {creative.ctaLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
