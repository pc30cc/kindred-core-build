import { MessageSquare, Phone, Sparkles, BarChart3, Zap, Bot } from 'lucide-react';
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

/** Dark aurora showcase panel for auth screens (Magic UI style). */
export function AuthHeroPanel({ title, subtitle, className }: Props) {
  return (
    <div className={`dark relative hidden overflow-hidden bg-background text-foreground lg:flex ${className ?? ''}`}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-aurora absolute -top-40 start-[10%] h-[520px] w-[520px] rounded-full bg-brand-teal/25 blur-[110px]" />
        <div className="animate-aurora absolute top-24 end-[0%] h-[460px] w-[460px] rounded-full bg-brand-violet/25 blur-[110px]" style={{ animationDelay: '-6s' }} />
        <div className="animate-aurora absolute -bottom-40 start-1/3 h-[320px] w-[320px] rounded-full bg-brand-coral/15 blur-[100px]" style={{ animationDelay: '-12s' }} />
        <div className="bg-grid absolute inset-0" />
      </div>

      <div className="relative z-10 flex w-full flex-col items-center justify-center p-12 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping-soft absolute inline-flex h-full w-full rounded-full bg-primary" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          WEBYAR
        </span>
        <h2 className="max-w-md text-3xl font-bold leading-tight xl:text-4xl">
          <span className="text-brand">{title}</span>
        </h2>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{subtitle}</p>

        {/* Floating product card with rotating light border */}
        <div className="beam-border glass mt-10 w-full max-w-md rounded-3xl p-5 text-start shadow-glow">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white shadow-glow">
              <WebyarMark className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="h-2.5 w-28 rounded-full bg-foreground/80" />
              <div className="mt-2 h-2 w-40 rounded-full bg-muted-foreground/40" />
            </div>
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">● online</span>
          </div>
          <div className="mt-5 space-y-2.5">
            <div className="ms-auto w-3/4 rounded-2xl rounded-ee-md bg-brand px-3 py-2 text-xs text-white">
              <div className="h-2 w-full rounded-full bg-white/60" />
              <div className="mt-1.5 h-2 w-2/3 rounded-full bg-white/40" />
            </div>
            <div className="w-2/3 rounded-2xl rounded-es-md bg-secondary px-3 py-2">
              <div className="h-2 w-full rounded-full bg-muted-foreground/50" />
              <div className="mt-1.5 h-2 w-1/2 rounded-full bg-muted-foreground/30" />
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            {[72, 48, 88].map((h, i) => (
              <div key={i} className="flex h-16 items-end rounded-xl bg-secondary/70 p-2">
                <div className="w-full rounded-md bg-brand" style={{ height: `${h}%` }} />
              </div>
            ))}
          </div>
        </div>

        {/* Marquee of capabilities */}
        <div dir="ltr" className="relative mt-10 w-full max-w-lg overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
          <div className="animate-marquee flex w-max gap-2" style={{ animationDirection: 'reverse' }}>
            {[...CHIPS, ...CHIPS].map(({ icon: Icon, label }, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card/50 px-3 py-1.5 text-xs font-medium text-foreground/90 backdrop-blur">
                <Icon className="h-3.5 w-3.5 text-primary" />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
