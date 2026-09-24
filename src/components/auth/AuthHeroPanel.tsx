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
  { w1: 'w-24', w2: 'w-40', active: true, unread: 2, tone: 'bg-brand-teal/25' },
  { w1: 'w-20', w2: 'w-32', active: false, unread: 0, tone: 'bg-brand-sky/25' },
  { w1: 'w-28', w2: 'w-36', active: false, unread: 0, tone: 'bg-brand-violet/25' },
];

/** Light aurora showcase panel for auth screens — same language as the WebYar landing hero. */
export function AuthHeroPanel({ title, subtitle, className }: Props) {
  return (
    <div className={`relative hidden overflow-hidden border-s border-border/60 bg-secondary/40 text-foreground lg:flex ${className ?? ''}`}>
      {/* Aurora backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-aurora absolute -top-40 start-[10%] h-[520px] w-[520px] rounded-full bg-primary/20 blur-[110px]" />
        <div className="animate-aurora absolute top-24 end-[5%] h-[460px] w-[460px] rounded-full bg-brand-sky/20 blur-[110px]" style={{ animationDelay: '-6s' }} />
        <div className="animate-aurora absolute -bottom-40 start-1/3 h-[340px] w-[340px] rounded-full bg-brand-violet/15 blur-[100px]" style={{ animationDelay: '-12s' }} />
        <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_80%)]" />
      </div>

      <div className="relative z-10 flex w-full flex-col items-center justify-center p-12 text-center">
        <span className="glass mb-6 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold text-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          WEBYAR
        </span>
        <h2 className="max-w-md text-3xl font-extrabold leading-tight tracking-tight text-foreground xl:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{subtitle}</p>

        {/* Product preview: glass inbox mock */}
        <div className="glass mt-10 w-full max-w-md overflow-hidden rounded-3xl text-start shadow-glow">
          <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
            <div className="bg-brand flex h-8 w-8 items-center justify-center rounded-xl text-primary-foreground shadow-sm">
              <WebyarMark className="h-4 w-4" />
            </div>
            <div className="h-2 w-20 rounded-full bg-foreground/20" />
            <span className="ms-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> online
            </span>
          </div>

          <div className="divide-y divide-border/50">
            {ROWS.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-3 ${r.active ? 'bg-primary/[0.07]' : ''}`}>
                <div className={`h-9 w-9 shrink-0 rounded-full ${r.tone}`} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className={`h-2 ${r.w1} rounded-full bg-foreground/25`} />
                  <div className={`h-1.5 ${r.w2} rounded-full bg-muted-foreground/20`} />
                </div>
                {r.unread ? (
                  <span className="bg-brand flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {r.unread}
                  </span>
                ) : (
                  <CheckCheck className="h-3.5 w-3.5 text-primary/70" />
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
              <div key={s.l} dir="ltr" className="border-e border-border/50 px-4 py-3 text-center last:border-e-0">
                <div className="text-brand text-sm font-bold">{s.v}</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        <div dir="ltr" className="relative mt-10 w-full max-w-lg overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
          <div className="animate-marquee flex w-max gap-2" style={{ animationDirection: 'reverse' }}>
            {[...CHIPS, ...CHIPS].map(({ icon: Icon, label }, i) => (
              <span key={i} className="glass inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium text-foreground/80">
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
