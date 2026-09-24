import { MessageSquare, Phone, Sparkles, BarChart3, Zap, Bot, CheckCheck } from 'lucide-react';
import { WebyarMark } from '@/components/brand/WebyarMark';

interface Props {
  title: string;
  subtitle: string;
  className?: string;
}

const CHIPS = [
  { icon: MessageSquare, label: 'Live Chat' },
  { icon: Bot, label: 'AI Agent' },
  { icon: Phone, label: 'Call Center' },
  { icon: BarChart3, label: 'Analytics' },
  { icon: Zap, label: 'Automation' },
  { icon: Sparkles, label: 'Smart Inbox' },
];

const ROWS = [
  { w1: 'w-24', w2: 'w-40', active: true, unread: 2 },
  { w1: 'w-20', w2: 'w-32', active: false, unread: 0 },
  { w1: 'w-28', w2: 'w-36', active: false, unread: 0 },
];

/** Calm, dark showcase panel for auth screens. */
export function AuthHeroPanel({ title, subtitle, className }: Props) {
  return (
    <div className={`dark relative hidden overflow-hidden bg-background text-foreground lg:flex ${className ?? ''}`}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-48 start-1/2 h-[560px] w-[560px] -translate-x-1/2 rounded-full bg-primary/10 blur-[140px]" />
        <div className="bg-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      </div>

      <div className="relative z-10 flex w-full flex-col items-center justify-center p-12 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/40 px-3 py-1 text-[11px] font-medium tracking-[0.2em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          WEBYAR
        </span>
        <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-foreground xl:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{subtitle}</p>

        {/* Product preview: a quiet inbox mock */}
        <div className="mt-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/60 bg-card/50 text-start shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <WebyarMark className="h-4 w-4" />
            </div>
            <div className="h-2 w-20 rounded-full bg-foreground/30" />
            <span className="ms-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> online
            </span>
          </div>

          <div className="divide-y divide-border/40">
            {ROWS.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-3 ${r.active ? 'bg-primary/[0.06]' : ''}`}>
                <div className="h-9 w-9 shrink-0 rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className={`h-2 ${r.w1} rounded-full bg-foreground/40`} />
                  <div className={`h-1.5 ${r.w2} rounded-full bg-muted-foreground/25`} />
                </div>
                {r.unread ? (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {r.unread}
                  </span>
                ) : (
                  <CheckCheck className="h-3.5 w-3.5 text-muted-foreground/60" />
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 border-t border-border/60">
            {[
              { v: '98%', l: 'CSAT' },
              { v: '<1m', l: 'Reply' },
              { v: '24/7', l: 'AI' },
            ].map((s) => (
              <div key={s.l} dir="ltr" className="border-e border-border/40 px-4 py-3 text-center last:border-e-0">
                <div className="text-sm font-semibold text-foreground">{s.v}</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        <div dir="ltr" className="relative mt-10 w-full max-w-lg overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
          <div className="animate-marquee flex w-max gap-2" style={{ animationDirection: 'reverse' }}>
            {[...CHIPS, ...CHIPS].map(({ icon: Icon, label }, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border/50 bg-card/30 px-3 py-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5 text-primary/80" />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
