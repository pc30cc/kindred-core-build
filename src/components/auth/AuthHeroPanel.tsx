import { MessageSquare, Phone, Sparkles, BarChart3, Zap, Bot, MicOff, Camera, Video, PhoneOff } from 'lucide-react';
import { LoopVideo } from '@/components/site/LoopVideo';
import callerWoman from '@/assets/caller-woman.jpg';
import operatorMan from '@/assets/operator-man.jpg';

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

        {/* Product preview: phone video call + native apps */}
        <div className="relative mt-10 flex items-center justify-center">
          <div className="relative aspect-[9/19.5] w-[230px] rounded-[44px] border border-border bg-background p-[9px] shadow-glow ring-1 ring-foreground/10">
            <div className="relative h-full w-full overflow-hidden rounded-[36px] bg-secondary">
              <div className="absolute top-2 left-1/2 z-20 h-[20px] w-[72px] -translate-x-1/2 rounded-full bg-background" />
              <LoopVideo
                src="/auth-media/caller-woman.mp4"
                poster={callerWoman}
                title="Video call"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-transparent to-background/70" />
              <div className="relative flex flex-col items-center pt-9 text-center">
                <div className="h-2 w-20 rounded-full bg-foreground/40" />
                <div dir="ltr" className="mt-1.5 text-[10px] text-foreground/80">02:14</div>
              </div>
              <div className="absolute bottom-20 end-3 h-20 w-14 overflow-hidden rounded-xl border-2 border-foreground/30 shadow-lg">
                <LoopVideo src="/auth-media/operator-man.mp4" poster={operatorMan} title="Operator" className="h-full w-full object-cover" />
              </div>
              <div className="absolute inset-x-0 bottom-6 flex justify-center gap-2.5">
                {[MicOff, Camera, Video].map((I, i) => (
                  <span key={i} className="glass flex h-10 w-10 items-center justify-center rounded-full">
                    <I className="h-4 w-4 text-foreground" />
                  </span>
                ))}
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive">
                  <PhoneOff className="h-4 w-4 text-destructive-foreground" />
                </span>
              </div>
            </div>
          </div>

          {/* Native app badges */}
          <div className="absolute -start-20 top-12 flex flex-col gap-3">
            {['ios', 'android', 'windows'].map((p, i) => (
              <div key={p} className="glass flex items-center gap-2 rounded-2xl px-3 py-2 shadow-sm" style={{ transform: `translateX(${i % 2 ? -12 : 0}px)` }}>
                <img src={`/auth-media/${p}.png`} alt="" className="h-7 w-7 rounded-lg" loading="lazy" />
                <span dir="ltr" className="text-xs font-semibold text-foreground">{p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : 'Windows'}</span>
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
