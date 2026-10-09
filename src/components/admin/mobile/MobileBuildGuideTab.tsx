/**
 * Build & ship: the end-to-end procedure from an empty Apple Developer account
 * to a submitted build, and the commands that build the native app
 * (ios/Webyar) on a Mac — the edition's own app: the `Webyar` scheme in Iran,
 * `Respok` in the International edition (nativeBuild.ts).
 *
 * The Xcode project is generated from ios/Webyar/project.yml by
 * XcodeGen and is not committed; the version and build number go in on the
 * archive's command line, taken here from the Release tab.
 */
import { useState } from 'react';
import { Check, Copy, Terminal, ListOrdered } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useEdition } from '@/hooks/useEdition';
import { SettingsSection, CodeBlock } from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';
import { iosBuildCommands } from './nativeBuild';

/** The ordered procedure; the copy for each step lives in i18n. */
const STEPS = [
  'appleAccount', 'identifier', 'capabilities', 'apnsKey',
  'appStoreConnect', 'configure', 'build', 'archive', 'upload', 'testflight', 'submit',
] as const;

export function MobileBuildGuideTab({ settings }: { settings: MobileAppSettings }) {
  const { t } = useTranslation();
  const { edition } = useEdition();
  const commands = iosBuildCommands(settings, edition).join('\n');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ListOrdered className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">{t('admin.mobileApp.buildGuide.title')}</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.mobileApp.buildGuide.subtitle')}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {STEPS.map((step, index) => (
            <div key={step} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {t(`admin.mobileApp.buildGuide.steps.${step}.title` as TranslationKey)}
                </p>
                <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                  {t(`admin.mobileApp.buildGuide.steps.${step}.body` as TranslationKey)}
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <SettingsSection
        icon={Terminal}
        heading={t('admin.mobileApp.buildGuide.commands')}
        caption={t('admin.mobileApp.buildGuide.commandsHint')}
        action={<CopyButton value={commands} />}
      >
        <CodeBlock value={commands} />
      </SettingsSection>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard is unavailable over plain HTTP; the text is on screen
          // and selectable either way, so this is not worth an error toast.
        }
      }}
    >
      {copied ? <Check className="me-1.5 h-3.5 w-3.5" /> : <Copy className="me-1.5 h-3.5 w-3.5" />}
      {copied ? t('admin.mobileApp.common.copied') : t('admin.mobileApp.common.copy')}
    </Button>
  );
}
