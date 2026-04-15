import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ArrowRight, Loader2, Bot, Users, Sparkles, Shield } from 'lucide-react';

interface SignupStepAIProps {
  aiMode: 'ai_first' | 'human_first' | '';
  setAiMode: (v: 'ai_first' | 'human_first' | '') => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  brandName: string;
}

export default function SignupStepAI({
  aiMode, setAiMode, loading, onSubmit, brandName,
}: SignupStepAIProps) {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {t('auth.step3Subtitle')}
      </p>

      <div className="grid grid-cols-1 gap-4">
        {/* AI-First */}
        <button
          type="button"
          onClick={() => setAiMode('ai_first')}
          className={`group relative flex flex-col gap-3 p-5 rounded-2xl border-2 text-start transition-all duration-200 ${
            aiMode === 'ai_first'
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20 shadow-md'
              : 'border-border bg-background hover:border-primary/40 hover:shadow-sm'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
              aiMode === 'ai_first' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>
              <Bot className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-foreground">{t('auth.aiFirstTitle', { brand: brandName })}</span>
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-primary/10 text-primary rounded-full flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  AI
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{t('auth.aiFirstLabel')}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('auth.aiFirstDesc', { brand: brandName })}
          </p>
        </button>

        {/* Human-First */}
        <button
          type="button"
          onClick={() => setAiMode('human_first')}
          className={`group relative flex flex-col gap-3 p-5 rounded-2xl border-2 text-start transition-all duration-200 ${
            aiMode === 'human_first'
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20 shadow-md'
              : 'border-border bg-background hover:border-primary/40 hover:shadow-sm'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
              aiMode === 'human_first' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>
              <Users className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-foreground">{t('auth.humanFirstTitle', { brand: brandName })}</span>
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground rounded-full flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  {t('auth.humanFirstBadge')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{t('auth.humanFirstLabel')}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('auth.humanFirstDesc', { brand: brandName })}
          </p>
        </button>
      </div>

      <p className="text-xs text-center text-muted-foreground">
        {t('auth.aiModeHint')}
      </p>

      <Button type="submit" className="w-full h-12 text-base font-semibold gap-2" disabled={loading || !aiMode}>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            {t('auth.continue')}
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </Button>
    </form>
  );
}
