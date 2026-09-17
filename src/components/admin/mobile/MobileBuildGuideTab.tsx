/**
 * Build & ship: the generated project files, the exact commands, and the
 * end-to-end procedure from an empty Apple Developer account to a submitted
 * build.
 *
 * The "export" block is the real handoff: the build machine has no database,
 * so `config/ios-app.json` — generated here from the saved settings — is what
 * a commit carries into CI and into `npm run ios:sync`.
 */
import { useState } from 'react';
import { Check, Copy, Terminal, FileCode2, ListOrdered } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection, CodeBlock } from '@/components/admin/settings/SettingsFields';
import { useGeneratedConfig, type MobileAppSettings } from '@/hooks/useMobileApp';

/** The ordered procedure; the copy for each step lives in i18n. */
const STEPS = [
  'appleAccount', 'identifier', 'capabilities', 'apnsKey', 'firebase',
  'appStoreConnect', 'configure', 'build', 'archive', 'upload', 'testflight', 'submit',
] as const;

export function MobileBuildGuideTab({
  active,
  settings,
}: {
  active: boolean;
  settings: MobileAppSettings;
}) {
  const { t } = useTranslation();
  const { data: generated, isLoading } = useGeneratedConfig(active);

  // Exactly the shape `scripts/ios/apply-app-settings.ts` reads.
  const exportJson = JSON.stringify(
    {
      app_name: settings.app_name,
      display_name: settings.display_name,
      bundle_id: settings.bundle_id,
      apple_team_id: settings.apple_team_id,
      primary_language: settings.primary_language,
      marketing_version: settings.marketing_version,
      build_number: settings.build_number,
      minimum_os_version: settings.minimum_os_version,
      device_family: settings.device_family,
      orientations: settings.orientations,
      requires_full_screen: settings.requires_full_screen,
      supports_dark_mode: settings.supports_dark_mode,
      url_scheme: settings.url_scheme,
      associated_domains: settings.associated_domains,
      build_configuration: settings.build_configuration,
      automatic_signing: settings.automatic_signing,
      provisioning_profile: settings.provisioning_profile,
      cap_push_notifications: settings.cap_push_notifications,
      cap_background_remote_notifications: settings.cap_background_remote_notifications,
      cap_background_fetch: settings.cap_background_fetch,
      cap_associated_domains: settings.cap_associated_domains,
      cap_app_groups: settings.cap_app_groups,
      app_group_id: settings.app_group_id,
      cap_keychain_sharing: settings.cap_keychain_sharing,
      cap_sign_in_with_apple: settings.cap_sign_in_with_apple,
      cap_camera: settings.cap_camera,
      cap_microphone: settings.cap_microphone,
      cap_photo_library: settings.cap_photo_library,
      cap_location: settings.cap_location,
      cap_face_id: settings.cap_face_id,
      usage_camera: settings.usage_camera,
      usage_microphone: settings.usage_microphone,
      usage_photo_library: settings.usage_photo_library,
      usage_photo_library_add: settings.usage_photo_library_add,
      usage_location: settings.usage_location,
      usage_face_id: settings.usage_face_id,
      usage_tracking: settings.usage_tracking,
      att_enabled: settings.att_enabled,
      collects_data: settings.collects_data,
      uses_idfa: settings.uses_idfa,
      privacy_manifest: settings.privacy_manifest,
      data_collection: settings.data_collection,
      uses_encryption: settings.uses_encryption,
      encryption_exempt: settings.encryption_exempt,
    },
    null,
    2,
  );

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
        action={<CopyButton value={(generated?.commands ?? []).join('\n')} />}
      >
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <CodeBlock value={(generated?.commands ?? []).join('\n')} />
        )}
      </SettingsSection>

      <SettingsSection
        icon={FileCode2}
        heading={t('admin.mobileApp.buildGuide.generated')}
        caption={t('admin.mobileApp.buildGuide.generatedHint')}
      >
        {isLoading || !generated ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <Tabs defaultValue="xcconfig">
            <TabsList>
              <TabsTrigger value="xcconfig">
                {t('admin.mobileApp.buildGuide.fileXcconfig')}
              </TabsTrigger>
              <TabsTrigger value="infoPlist">
                {t('admin.mobileApp.buildGuide.fileInfoPlist')}
              </TabsTrigger>
              <TabsTrigger value="entitlements">
                {t('admin.mobileApp.buildGuide.fileEntitlements')}
              </TabsTrigger>
              <TabsTrigger value="privacy">
                {t('admin.mobileApp.buildGuide.filePrivacy')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="xcconfig">
              <CodeBlock
                value={Object.entries(generated.xcconfig)
                  .map(([key, value]) => `${key} = ${value}`)
                  .join('\n')}
              />
            </TabsContent>
            <TabsContent value="infoPlist">
              <CodeBlock value={JSON.stringify(generated.infoPlist, null, 2)} />
            </TabsContent>
            <TabsContent value="entitlements">
              <CodeBlock value={JSON.stringify(generated.entitlements, null, 2)} />
            </TabsContent>
            <TabsContent value="privacy">
              <CodeBlock value={JSON.stringify(generated.privacyManifest, null, 2)} />
            </TabsContent>
          </Tabs>
        )}
      </SettingsSection>

      <SettingsSection
        icon={FileCode2}
        heading={t('admin.mobileApp.buildGuide.export')}
        caption={t('admin.mobileApp.buildGuide.exportHint')}
        action={<CopyButton value={exportJson} />}
      >
        <CodeBlock value={exportJson} />
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
