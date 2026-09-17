/**
 * App Review: the demo account and contact details Apple's reviewer needs,
 * plus the account-deletion requirement (5.1.1(v)) that an app with sign-in
 * cannot ship without.
 *
 * The demo PASSWORD is deliberately not a field here. Apple reads it from App
 * Store Connect, and a reviewer credential sitting in the product database is
 * a standing liability for no benefit.
 */
import { UserCheck, Trash2, Lock } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

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
