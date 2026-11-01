import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Bot, Eye, FlaskConical } from 'lucide-react';
import TestAiPanel from '../TestAiPanel';
import type { AnswerLength, Tone } from './personaForm';
import { defaultIntro, localeDir } from './defaults';

function Bubble({ from, dir, children }: { from: 'assistant' | 'visitor'; dir?: 'rtl' | 'ltr'; children: ReactNode }) {
  return (
    <div
      data-bubble={from}
      dir={dir}
      className={cn(
        'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed',
        from === 'assistant'
          ? 'rounded-ss-sm bg-muted text-foreground'
          : 'ms-auto rounded-se-sm bg-primary text-primary-foreground',
      )}
    >
      {children}
    </div>
  );
}

/**
 * The page's preview: the avatar, the name and the welcome message as typed
 * (unsaved included), and one sample exchange in the chosen tone and length,
 * marked as a sample. Under it the real test (TestAiPanel, the server's own
 * test of the saved settings).
 */
export function PersonaPreview({
  agentName, avatarUrl, welcomeEnabled, welcome, primary, tone, length,
}: {
  agentName: string;
  avatarUrl: string | null;
  welcomeEnabled: boolean;
  welcome: string;
  primary: string;
  tone: Tone;
  length: AnswerLength;
}) {
  const { t } = useTranslation();
  const name = agentName.trim() || t('aiAgent.persona.preview.defaultName');
  const greeting = welcome.trim() || defaultIntro(primary, agentName);
  const opener = tone === 'formal'
    ? t('aiAgent.persona.preview.openerFormal')
    : tone === 'professional'
      ? t('aiAgent.persona.preview.openerProfessional')
      : t('aiAgent.persona.preview.openerFriendly');
  const body = length === 'short'
    ? t('aiAgent.persona.preview.bodyShort')
    : length === 'long'
      ? t('aiAgent.persona.preview.bodyLong')
      : t('aiAgent.persona.preview.bodyMedium');

  return (
    <div className="space-y-4">
      <Card data-persona-preview className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4 text-primary" /> {t('aiAgent.persona.preview.title')}
          </CardTitle>
          <CardDescription>{t('aiAgent.persona.preview.hint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 rounded-xl border border-border/60 bg-background p-4 shadow-sm">
            <div className="flex items-center gap-2.5 border-b pb-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10">
                {avatarUrl
                  ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                  : <Bot className="h-4 w-4 text-primary" aria-hidden />}
              </div>
              <div className="min-w-0">
                <p data-preview-name className="truncate text-sm font-semibold" dir="auto">{name}</p>
                <p className="text-[11px] text-success">● {t('aiAgent.settings.online')}</p>
              </div>
            </div>
            {welcomeEnabled ? (
              <div data-preview-welcome>
                <Bubble from="assistant" dir={localeDir(primary)}>{greeting}</Bubble>
              </div>
            ) : (
              <p className="text-center text-[11px] text-muted-foreground">{t('aiAgent.persona.preview.welcomeOff')}</p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Badge variant="outline" className="shrink-0 text-[10px]">{t('aiAgent.persona.preview.sample')}</Badge>
              <span className="text-[11px] text-muted-foreground">{t('aiAgent.persona.preview.sampleNote')}</span>
            </div>
            <div data-preview-sample className="space-y-2">
              <Bubble from="visitor">{t('aiAgent.persona.preview.sampleQuestion')}</Bubble>
              <Bubble from="assistant">{`${opener} ${body}`}</Bubble>
            </div>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="persona-real-test" className="space-y-2">
        <div>
          <h3 id="persona-real-test" className="flex items-center gap-2 text-sm font-semibold">
            <FlaskConical className="h-4 w-4 text-primary" /> {t('aiAgent.persona.preview.realTest')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('aiAgent.persona.preview.realTestHint')}</p>
        </div>
        <TestAiPanel />
      </section>
    </div>
  );
}
