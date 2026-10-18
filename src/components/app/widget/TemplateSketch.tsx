/**
 * A schematic of a chat widget template's home screen, for the template
 * pickers (Super Admin → Widget templates, Widget → Appearance). Shapes only:
 * no screenshot, no text, no brand. The accent is the current text colour.
 *
 *   default — header, welcome card, list rows, a button;
 *   t1      — coloured hero, cards over it, a bottom menu;
 *   t2      — coloured hero with an ask field and topic chips, no menu.
 * A skin over a renderer (`t1-intl`, `t2-intl`) has its renderer's shape.
 */
import { cn } from '@/lib/utils';
import { chatWidgetTemplate } from '../../../../shared/widgetTemplates';

const SURFACE = 'hsl(var(--background))';
const MUTED = 'hsl(var(--muted))';
const LINE = 'hsl(var(--border))';

/** The layout a template draws: its renderer's (a skin's is the renderer it restyles). */
function shapeOf(id: string): string {
  const script = chatWidgetTemplate(id)?.script;
  return script === 'presentation-t1.js' ? 't1' : script === 'presentation-t2.js' ? 't2' : 'default';
}

export function TemplateSketch({ id, className }: { id: string; className?: string }) {
  const shape = shapeOf(id);
  return (
    <svg
      viewBox="0 0 120 150"
      aria-hidden
      data-tpl-sketch={id}
      className={cn('h-auto w-full rounded-lg text-primary', className)}
    >
      <rect x="0.5" y="0.5" width="119" height="149" rx="10" fill={SURFACE} stroke={LINE} />
      {shape === 't1' ? (
        <>
          <path d="M1 11a10 10 0 0 1 10-10h98a10 10 0 0 1 10 10v51H1z" fill="currentColor" />
          <rect x="12" y="14" width="16" height="16" rx="5" fill={SURFACE} opacity=".9" />
          <rect x="12" y="36" width="58" height="6" rx="3" fill={SURFACE} opacity=".9" />
          <rect x="12" y="46" width="40" height="4" rx="2" fill={SURFACE} opacity=".6" />
          <rect x="10" y="56" width="100" height="30" rx="7" fill={SURFACE} stroke={LINE} />
          <rect x="18" y="64" width="50" height="5" rx="2.5" fill={MUTED} />
          <rect x="18" y="73" width="74" height="7" rx="3.5" fill="currentColor" opacity=".9" />
          <rect x="10" y="92" width="100" height="26" rx="7" fill={SURFACE} stroke={LINE} />
          <rect x="18" y="100" width="62" height="4" rx="2" fill={MUTED} />
          <rect x="18" y="108" width="44" height="4" rx="2" fill={MUTED} />
          <rect x="14" y="126" width="92" height="17" rx="8.5" fill={SURFACE} stroke={LINE} />
          <rect x="20" y="129" width="28" height="11" rx="5.5" fill="currentColor" opacity=".18" />
          <circle cx="60" cy="134.5" r="3" fill={MUTED} />
          <circle cx="84" cy="134.5" r="3" fill={MUTED} />
        </>
      ) : shape === 't2' ? (
        <>
          <path d="M1 11a10 10 0 0 1 10-10h98a10 10 0 0 1 10 10v63H1z" fill="currentColor" />
          <rect x="12" y="14" width="16" height="16" rx="5" fill={SURFACE} opacity=".9" />
          <rect x="12" y="36" width="64" height="6" rx="3" fill={SURFACE} opacity=".9" />
          <rect x="10" y="50" width="100" height="40" rx="8" fill={SURFACE} stroke={LINE} />
          <rect x="18" y="58" width="56" height="5" rx="2.5" fill={MUTED} />
          <rect x="18" y="67" width="40" height="4" rx="2" fill={MUTED} opacity=".7" />
          <circle cx="98" cy="80" r="5" fill="currentColor" />
          <rect x="10" y="98" width="30" height="10" rx="5" fill={SURFACE} stroke={LINE} />
          <rect x="44" y="98" width="34" height="10" rx="5" fill={SURFACE} stroke={LINE} />
          <rect x="82" y="98" width="28" height="10" rx="5" fill={SURFACE} stroke={LINE} />
          <rect x="10" y="116" width="100" height="10" rx="3" fill={MUTED} opacity=".8" />
          <rect x="10" y="131" width="100" height="10" rx="3" fill={MUTED} opacity=".8" />
        </>
      ) : (
        <>
          <path d="M1 11a10 10 0 0 1 10-10h98a10 10 0 0 1 10 10v25H1z" fill="currentColor" />
          <circle cx="16" cy="18" r="7" fill={SURFACE} opacity=".9" />
          <rect x="28" y="13" width="44" height="5" rx="2.5" fill={SURFACE} opacity=".9" />
          <rect x="28" y="21" width="30" height="4" rx="2" fill={SURFACE} opacity=".6" />
          <rect x="10" y="44" width="100" height="34" rx="8" fill={SURFACE} stroke={LINE} />
          <rect x="18" y="52" width="60" height="5" rx="2.5" fill={MUTED} />
          <rect x="18" y="61" width="44" height="4" rx="2" fill={MUTED} />
          <rect x="10" y="86" width="100" height="10" rx="3" fill={MUTED} opacity=".8" />
          <rect x="10" y="101" width="100" height="10" rx="3" fill={MUTED} opacity=".8" />
          <rect x="10" y="116" width="100" height="10" rx="3" fill={MUTED} opacity=".8" />
          <rect x="24" y="131" width="72" height="11" rx="5.5" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
