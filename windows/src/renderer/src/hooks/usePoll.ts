import { useEffect, useRef } from 'react'

/**
 * Runs `task` now and then every `intervalMs`, one run at a time. Slower while
 * the window is in the background, and immediately again when it comes back —
 * and at once whenever `wakeOn` fires on `window` (the realtime inbox events),
 * so polling is only the safety net under the push channel.
 */
export function usePoll(
  task: () => Promise<void> | void,
  intervalMs: number,
  deps: unknown[],
  { backgroundMs = intervalMs * 3, immediate = true, wakeOn }: { backgroundMs?: number; immediate?: boolean; wakeOn?: string } = {},
) {
  const ref = useRef(task)
  ref.current = task

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    // A wake-up that lands mid-run must not be lost: the run in flight may
    // already have read the state from before the event.
    let again = false

    const run = async () => {
      if (cancelled) return
      if (running) {
        again = true
        return
      }
      running = true
      try {
        await ref.current()
      } catch {
        // A failed poll is a blip, not an answer; the next one tries again.
      } finally {
        running = false
      }
      if (again) {
        again = false
        void run()
      } else schedule()
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
    if (wakeOn) window.addEventListener(wakeOn, onFocus)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      if (wakeOn) window.removeEventListener(wakeOn, onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
