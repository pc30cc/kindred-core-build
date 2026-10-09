/**
 * App Review: the demo account and contact details Apple's reviewer needs,
 * plus the account-deletion requirement (5.1.1(v)) that an app with sign-in
 * cannot ship without.
 *
 * The demo PASSWORD is deliberately not a field here. Apple reads it from App
 * Store Connect, and a reviewer credential sitting in the product database is
 * a standing liability for no benefit.
 */
import { useState } from 'react';
import { UserCheck, Trash2, Lock, Apple } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useEdition } from '@/hooks/useEdition';
import { Button } from '@/components/ui/button';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import {
  useAppReviewAccount, useSeedAppReviewAccount, useSetAppReviewEnabled,
  type MobileAppSettings,
} from '@/hooks/useMobileApp';
import { appReviewAccountFallback } from './nativeBuild';

/**
 * The account Apple signs in with (migration 248): whether it may sign in,
 * and a button that makes — or, before each submission, remakes — it and
 * its English demo workspace. The password is sent once, to be hashed; it
 * is never shown again.
 */
function AppReviewAccountSection() {
  const { t, locale } = useTranslation();
  const account = useAppReviewAccount();
  const seed = useSeedAppReviewAccount();
  const toggle = useSetAppReviewEnabled();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const { edition } = useEdition();
  const status = account.data;
  const exists = status?.exists === true;

  const describe = (error: unknown) => {
    const code = (error as Error).message;
    if (code === 'password_required') return t('admin.mobileApp.reviewAccount.passwordRequired');
    if (code === 'password_too_short') return t('admin.mobileApp.reviewAccount.passwordTooShort');
    return t('admin.mobileApp.reviewAccount.failed', { error: code });
  };

  const runSeed = () => {
    setMessage(null);
    seed.mutate(password ? { password } : {}, {
      onSuccess: () => {
        setPassword('');
        setMessage(t('admin.mobileApp.reviewAccount.done'));
      },
      onError: (error) => setMessage(describe(error)),
    });
  };

  const seededAt = status?.seeded_at
    ? t('admin.mobileApp.reviewAccount.seededAt', {
        when: new Date(status.seeded_at).toLocaleString(locale),
      })
    : t('admin.mobileApp.reviewAccount.neverSeeded');

  return (
    <SettingsSection
      icon={Apple}
      heading={t('admin.mobileApp.reviewAccount.heading')}
      caption={t('admin.mobileApp.reviewAccount.caption')}
    >
      {exists ? (
        <SwitchField
          label={t('admin.mobileApp.reviewAccount.enabled')}
          hint={t('admin.mobileApp.reviewAccount.enabledHint')}
          checked={status?.enabled === true}
          disabled={toggle.isPending}
          onChange={(enabled) => {
            setMessage(null);
            toggle.mutate(enabled, { onError: (error) => setMessage(describe(error)) });
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('admin.mobileApp.reviewAccount.missing')}</p>
      )}

      <div className="space-y-1 text-xs text-muted-foreground">
        <p dir="ltr" className="text-start font-mono">{status?.email ?? appReviewAccountFallback(edition)}</p>
        {status?.workspace_name && (
          <p>{t('admin.mobileApp.reviewAccount.workspace')}: {status.workspace_name}</p>
        )}
        <p>{seededAt}</p>
      </div>

      <TextField
        label={t('admin.mobileApp.reviewAccount.password')}
        hint={t('admin.mobileApp.reviewAccount.passwordHint')}
        type="password"
        value={password}
        dir="ltr"
        onChange={setPassword}
      />

      <div className="space-y-1">
        <Button onClick={runSeed} disabled={seed.isPending || account.isLoading}>
          {exists ? t('admin.mobileApp.reviewAccount.refresh') : t('admin.mobileApp.reviewAccount.seed')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('admin.mobileApp.reviewAccount.refreshHint')}</p>
      </div>

      {message && <p className="text-sm" role="status">{message}</p>}
    </SettingsSection>
  );
}

export function MobileReviewTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <AppReviewAccountSection />

      <SettingsSection
        icon={UserCheck}
        heading={t('admin.mobileApp.review.contact')}
        caption={t('admin.mobileApp.review.contactHint')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.review.contactName')}
            value={draft.review_contact_name ?? ''}
            onChange={(value) => set({ review_contact_name: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.review.contactEmail')}
            hint={t('admin.mobileApp.review.contactEmailHint')}
            value={draft.review_contact_email ?? ''}
            dir="ltr"
            onChange={(value) => set({ review_contact_email: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.review.contactPhone')}
            hint={t('admin.mobileApp.review.contactPhoneHint')}
            value={draft.review_contact_phone ?? ''}
            dir="ltr"
            onChange={(value) => set({ review_contact_phone: value || null })}
          />
        </FieldGrid>
        <TextAreaField
          label={t('admin.mobileApp.review.notes')}
          hint={t('admin.mobileApp.review.notesHint')}
          value={draft.review_notes ?? ''}
          rows={6}
          onChange={(value) => set({ review_notes: value || null })}
        />
      </SettingsSection>

      <SettingsSection
        icon={Lock}
        heading={t('admin.mobileApp.review.demoAccount')}
        caption={t('admin.mobileApp.review.demoAccountHint')}
      >
        <SwitchField
          label={t('admin.mobileApp.review.demoRequired')}
          hint={t('admin.mobileApp.review.demoRequiredHint')}
          checked={draft.demo_account_required}
          onChange={(demo_account_required) => set({ demo_account_required })}
        />
        {draft.demo_account_required && (
          <>
            <TextField
              label={t('admin.mobileApp.review.demoUsername')}
              hint={t('admin.mobileApp.review.demoUsernameHint')}
              value={draft.demo_account_username ?? ''}
              dir="ltr"
              onChange={(value) => set({ demo_account_username: value || null })}
            />
            <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              {t('admin.mobileApp.review.demoPasswordNotice')}
            </p>
            <TextAreaField
              label={t('admin.mobileApp.review.demoNotes')}
              hint={t('admin.mobileApp.review.demoNotesHint')}
              value={draft.demo_account_notes ?? ''}
              rows={4}
              onChange={(value) => set({ demo_account_notes: value || null })}
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        icon={Trash2}
        heading={t('admin.mobileApp.review.accountDeletion')}
        caption={t('admin.mobileApp.review.accountDeletionHint')}
      >
        <SwitchField
          label={t('admin.mobileApp.review.accountDeletionSupported')}
          hint={t('admin.mobileApp.review.accountDeletionSupportedHint')}
          checked={draft.account_deletion_supported}
          onChange={(account_deletion_supported) => set({ account_deletion_supported })}
        />
        <TextField
          label={t('admin.mobileApp.review.accountDeletionUrl')}
          hint={t('admin.mobileApp.review.accountDeletionUrlHint')}
          value={draft.account_deletion_url ?? ''}
          dir="ltr"
          onChange={(value) => set({ account_deletion_url: value || null })}
        />
      </SettingsSection>
    </div>
  );
}
