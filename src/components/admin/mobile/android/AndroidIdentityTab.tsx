/**
 * The Android app as Google Play knows it: its name, its package and where
 * its listing is. The privacy policy and support links are the same for
 * both platforms, so they are edited here and on iOS alike.
 *
 * And the Firebase project it receives push through: the four client
 * identifiers of the package's google-services.json, which the app reads
 * from the server and starts Firebase with — no new build needed. The key
 * that sends (the FCM service account) is not here: it stays in the server's
 * environment, and this card only says whether it is there.
 */
import { useRef, useState } from 'react';
import { BellRing, CheckCircle2, FileJson, Fingerprint, Link2, TriangleAlert } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { SettingsSection, FieldGrid, TextField } from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';
import {
  FIREBASE_ANDROID_APP_ID,
  FIREBASE_API_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_SENDER_ID,
  firebaseProjectsMatch,
  readGoogleServices,
} from './googleServices';

const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const HTTPS = /^https:\/\//i;

export function AndroidIdentityTab({
  draft,
  set,
  pushConfigured,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
  /** Whether this server has the FCM service account that actually sends. */
  pushConfigured: boolean;
}) {
  const { t } = useTranslation();
  const httpsInvalid = (value: string | null) => Boolean(value) && !HTTPS.test(value ?? '');
  const file = useRef<HTMLInputElement>(null);
  const [fileNote, setFileNote] = useState<{ ok: boolean; text: string } | null>(null);
  const formatInvalid = (value: string | null, pattern: RegExp) => Boolean(value) && !pattern.test(value ?? '');

  const readFile = async (picked: File | undefined) => {
    if (!picked) return;
    const result = readGoogleServices(await picked.text(), draft.android_package_name);
    if ('patch' in result) {
      set(result.patch);
      setFileNote({ ok: true, text: t('admin.mobileApp.android.identity.firebaseRead', { package: draft.android_package_name }) });
    } else if (result.reason === 'noPackage') {
      setFileNote({
        ok: false,
        text: t('admin.mobileApp.android.identity.firebaseNoPackage', {
          package: draft.android_package_name,
          found: result.found.join(', ') || '—',
        }),
      });
    } else {
      setFileNote({ ok: false, text: t('admin.mobileApp.android.identity.firebaseInvalidFile') });
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Fingerprint}
        heading={t('admin.mobileApp.android.identity.heading')}
        caption={t('admin.mobileApp.android.identity.caption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.identity.appName')}
            hint={t('admin.mobileApp.android.identity.appNameHint')}
            value={draft.android_app_name}
            maxLength={50}
            onChange={(android_app_name) => set({ android_app_name })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.packageName')}
            hint={t('admin.mobileApp.android.identity.packageNameHint')}
            value={draft.android_package_name}
            dir="ltr"
            invalid={!PACKAGE.test(draft.android_package_name)}
            onChange={(android_package_name) => set({ android_package_name })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Link2}
        heading={t('admin.mobileApp.android.identity.linksHeading')}
        caption={t('admin.mobileApp.android.identity.linksCaption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.identity.playStoreUrl')}
            hint={t('admin.mobileApp.android.identity.playStoreUrlHint')}
            value={draft.android_play_store_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.android_play_store_url)}
            onChange={(value) => set({ android_play_store_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.privacyPolicyUrl')}
            hint={t('admin.mobileApp.android.identity.sharedWithIos')}
            value={draft.privacy_policy_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.privacy_policy_url)}
            onChange={(value) => set({ privacy_policy_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.supportUrl')}
            hint={t('admin.mobileApp.android.identity.sharedWithIos')}
            value={draft.support_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.support_url)}
            onChange={(value) => set({ support_url: value || null })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={BellRing}
        heading={t('admin.mobileApp.android.identity.firebaseHeading')}
        caption={t('admin.mobileApp.android.identity.firebaseCaption')}
        action={
          <>
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                // The same file picked again after an edit is read again.
                e.target.value = '';
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
              <FileJson className="me-1.5 h-4 w-4" />
              {t('admin.mobileApp.android.identity.firebaseReadButton')}
            </Button>
          </>
        }
      >
        {fileNote && (
          <p className={fileNote.ok ? 'mb-3 text-sm text-emerald-600' : 'mb-3 text-sm text-destructive'} role="status">
            {fileNote.text}
          </p>
        )}
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.identity.firebaseAppId')}
            hint={t('admin.mobileApp.android.identity.firebaseAppIdHint')}
            value={draft.android_firebase_app_id ?? ''}
            dir="ltr"
            invalid={formatInvalid(draft.android_firebase_app_id, FIREBASE_ANDROID_APP_ID)}
            onChange={(value) => set({ android_firebase_app_id: value.trim() || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.firebaseApiKey')}
            hint={t('admin.mobileApp.android.identity.firebaseApiKeyHint')}
            value={draft.android_firebase_api_key ?? ''}
            dir="ltr"
            invalid={formatInvalid(draft.android_firebase_api_key, FIREBASE_API_KEY)}
            onChange={(value) => set({ android_firebase_api_key: value.trim() || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.firebaseProjectId')}
            value={draft.android_firebase_project_id ?? ''}
            dir="ltr"
            invalid={formatInvalid(draft.android_firebase_project_id, FIREBASE_PROJECT_ID)}
            onChange={(value) => set({ android_firebase_project_id: value.trim() || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.firebaseSenderId')}
            hint={
              firebaseProjectsMatch(draft)
                ? t('admin.mobileApp.android.identity.firebaseSenderIdHint')
                : t('admin.mobileApp.android.identity.firebaseProjectsDiffer')
            }
            value={draft.android_firebase_sender_id ?? ''}
            dir="ltr"
            invalid={formatInvalid(draft.android_firebase_sender_id, FIREBASE_SENDER_ID) || !firebaseProjectsMatch(draft)}
            onChange={(value) => set({ android_firebase_sender_id: value.trim() || null })}
          />
        </FieldGrid>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          {pushConfigured ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ) : (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          )}
          <span>
            {pushConfigured
              ? t('admin.mobileApp.android.identity.firebaseServerReady')
              : t('admin.mobileApp.android.identity.firebaseServerMissing')}
          </span>
        </p>
      </SettingsSection>
    </div>
  );
}
