import strings from './strings.json'
import { extra } from './extra'

export type Language = 'en' | 'fa' | 'tr'

export const LANGUAGES: { id: Language; endonym: string }[] = [
  { id: 'fa', endonym: 'فارسی' },
  { id: 'en', endonym: 'English' },
  { id: 'tr', endonym: 'Türkçe' },
]

type Dict = Record<string, string>
const ios = strings as Record<Language, Dict>

/** Every key the app can ask for: the iOS app's own copy, plus the desktop-only lines. */
export type StringKey = keyof (typeof strings)['en'] | keyof (typeof extra)['en']

export function isRTL(language: Language): boolean {
  return language === 'fa'
}

export function localeOf(language: Language): string {
  return language === 'fa' ? 'fa-IR' : language === 'tr' ? 'tr-TR' : 'en-US'
}

/**
 * Looks a sentence up and fills its `{placeholders}`. `{n}` is written in the
 * language's own digits, the same way the iOS app formats counts.
 */
export function translate(language: Language, key: StringKey, params?: Record<string, string | number>): string {
  const raw = (extra[language] as Dict)[key] ?? ios[language]?.[key] ?? (extra.en as Dict)[key] ?? ios.en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    return typeof value === 'number' ? formatNumber(value, language) : value
  })
}

const numberFormats = new Map<Language, Intl.NumberFormat>()
export function formatNumber(value: number, language: Language): string {
  let f = numberFormats.get(language)
  if (!f) {
    f = new Intl.NumberFormat(localeOf(language), { useGrouping: false })
    numberFormats.set(language, f)
  }
  return f.format(value)
}
