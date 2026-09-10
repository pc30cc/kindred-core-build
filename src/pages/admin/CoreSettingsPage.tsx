/**
 * Super Admin → Core settings.
 *
 * A tabbed home for platform-wide behaviour switches that are not tied to a
 * single subsystem. First tab: signup (email verification method + gate),
 * which is stored on `platform_settings` and resolved server-side.
 */
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SlidersHorizontal } from 'lucide-react';
import { useTranslation } from '@/i18n';
import SignupDeliveryCard from './verification/SignupDeliveryCard';
import SignupPlanCard from './verification/SignupPlanCard';

export default function CoreSettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('signup');

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <SlidersHorizontal className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-bold">{t('admin.coreSettings.title' as any)}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.coreSettings.subtitle' as any)}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="signup">{t('admin.coreSettings.tabSignup' as any)}</TabsTrigger>
        </TabsList>

        <TabsContent value="signup" className="space-y-4">
          <SignupDeliveryCard />
          <SignupPlanCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
