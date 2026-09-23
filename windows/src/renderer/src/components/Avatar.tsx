import { useState } from 'react'
import * as flags from 'country-flag-icons/string/3x2'
import { siAndroid, siApple, siLinux } from 'simple-icons'
import { Monitor, Sparkles } from 'lucide-react'
import { cx } from '@/lib/cx'

const PALETTE = ['#3b7af2', '#7c4ddb', '#0ea5a4', '#e5484d', '#f76b15', '#30a46c', '#d6409f', '#0091ff', '#8e4ec6', '#12a594']

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const second = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : ''
  return (first + second).toLocaleUpperCase()
}

function OSGlyph({ os, size }: { os: string; size: number }) {
  const o = os.toLowerCase()
  const box = { width: size, height: size }
  if (o.includes('windows')) {
    // Four panes — drawn rather than taken from an icon set, which no longer ships the mark.
    return (
      <svg viewBox="0 0 24 24" style={box} fill="#0078d4" aria-hidden>
        <path d="M2 4.5l8.5-1.2v8.2H2zM11.5 3.2L22 1.7v9.8H11.5zM2 12.5h8.5v8.2L2 19.5zM11.5 12.5H22v9.8l-10.5-1.5z" />
      </svg>
    )
  }
  const icon = o.includes('android') ? siAndroid : o.includes('ios') || o.includes('mac') || o.includes('iphone') || o.includes('ipad') ? siApple : o.includes('linux') || o.includes('ubuntu') ? siLinux : null
  if (!icon) return <Monitor style={box} className="text-fg-2" strokeWidth={2.2} />
  const color = icon === siApple ? 'var(--text)' : `#${icon.hex}`
  return (
    <svg viewBox="0 0 24 24" style={box} fill={color} aria-hidden>
      <path d={icon.path} />
    </svg>
  )
}

export function Flag({ code, width = 16 }: { code: string; width?: number }) {
  const svg = (flags as Record<string, string>)[code.toUpperCase()]
  if (!svg) return null
  return (
    <span
      className="inline-block overflow-hidden rounded-[3px] ring-1 ring-black/10"
      style={{ width, height: Math.round((width * 2) / 3) }}
      dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" ') }}
      aria-hidden
    />
  )
}

export function Avatar({
  name,
  imageURL,
  size = 40,
  os,
  countryCode,
  status,
  square,
  className,
}: {
  name: string
  imageURL?: string | null
  size?: number
  os?: string | null
  countryCode?: string | null
  /** A presence dot, for the operator's own avatar. */
  status?: 'online' | 'offline' | null
  square?: boolean
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const color = PALETTE[hash(name) % PALETTE.length]
  const showImage = imageURL && !failed && /^(https:|blob:|data:)/.test(imageURL)
  const badge = Math.max(14, Math.round(size * 0.38))
  return (
    <div className={cx('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className={cx('flex size-full items-center justify-center overflow-hidden font-semibold text-white', square ? 'rounded-[28%]' : 'rounded-full')}
        style={{ background: showImage ? 'var(--elevated)' : `linear-gradient(135deg, ${color}, ${color}cc)`, fontSize: size * 0.38 }}
      >
        {showImage ? <img src={imageURL!} alt="" className="size-full object-cover" onError={() => setFailed(true)} draggable={false} /> : initials(name)}
      </div>
      {os && size >= 28 && (
        <span
          className="absolute -end-0.5 -bottom-0.5 flex items-center justify-center rounded-full bg-surface ring-2 ring-surface"
          style={{ width: badge, height: badge }}
          title={os}
        >
          <OSGlyph os={os} size={Math.round(badge * 0.66)} />
        </span>
      )}
      {countryCode && size >= 28 && (
        <span className="absolute -start-0.5 -bottom-0.5 flex rounded-[4px] ring-2 ring-surface" title={countryCode}>
          <Flag code={countryCode} width={Math.round(badge * 1.05)} />
        </span>
      )}
      {status && (
        <span
          className={cx('absolute -end-0.5 -bottom-0.5 rounded-full ring-2 ring-surface', status === 'online' ? 'bg-success' : 'bg-fg-3')}
          style={{ width: Math.max(9, size * 0.28), height: Math.max(9, size * 0.28) }}
        />
      )}
    </div>
  )
}

export function AIAvatar({ size = 28 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-white"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, var(--ai-1), var(--ai-2))' }}
    >
      <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2} />
    </div>
  )
}
