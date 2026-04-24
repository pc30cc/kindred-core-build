/**
 * Phase — Inbox Call Hardening · Pass 4
 *
 * Lightweight CSS-only "voice activity" indicator for the audio-first
 * connected surface. Three bars that bounce on a stagger.
 *
 * No WebAudio analyser, no MediaStream wiring — this is intentionally a
 * presentation cue. Reading actual remote audio levels would require
 * pulling AnalyserNode per remote track, which is wasted work for a
 * compact inline surface and would re-render every ~16ms.
 *
 * The host passes `active` so the bars freeze in `reconnecting` / paused
 * states and the operator gets honest feedback that the line is degraded.
 */
export function AudioWaveform({ active = true, className }: { active?: boolean; className?: string }) {
  return (
    <div
      className={'inline-flex items-end gap-[3px] h-4 ' + (className ?? '')}
      role="presentation"
      aria-hidden
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={
            'w-[3px] rounded-sm bg-success ' +
            (active ? 'animate-[wave_1s_ease-in-out_infinite]' : 'opacity-40')
          }
          style={{
            height: '100%',
            animationDelay: i * 120 + 'ms',
            transformOrigin: 'bottom',
          }}
        />
      ))}
    </div>
  );
}