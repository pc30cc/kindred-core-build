import { useEffect, useRef } from 'react'

/**
 * Runs `task` now and then every `intervalMs`, one run at a time. Slower while
 * the window is in the background, and immediately again when it comes back —
 * the app has no push channel on Windows, so polling is what keeps it live.
 */
export function usePoll(task: () => Promise<void> | void, intervalMs: number, deps: unknown[], { backgroundMs = intervalMs * 3, immediate = true } = {}) {
  const ref = useRef(task)
  ref.current = task

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false

    const run = async () => {
      if (cancelled || running) return
      running = true
      try {
        await ref.current()
      } catch {
        // A failed poll is a blip, not an answer; the next one tries again.
      } finally {
        running = false
      }
      schedule()
    }
    const schedule = () => {
      if (cancelled) return
      clearTimeout(timer)
      timer = setTimeout(run, document.hasFocus() ? intervalMs : backgroundMs)
    }
    const onFocus = () => {
      clearTimeout(timer)
      void run()
    }

    if (immediate) void run()
    else schedule()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
