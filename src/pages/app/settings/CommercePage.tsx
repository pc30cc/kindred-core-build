/**
 * Settings → Commerce → WooCommerce.
 *
 * Thin page wrapper — all the actual logic lives in
 * WooCommerceConfigPanel (src/components/plugins/WooCommerceConfigPanel.tsx),
 * shared with the Plugin Platform detail page (Plugins → WooCommerce) so
 * both entry points can never drift apart.
 */
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { WooCommerceConfigPanel } from '@/components/plugins/WooCommerceConfigPanel';

export default function CommercePage() {
  const workspace = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Commerce — WooCommerce</h1>
      <WooCommerceConfigPanel workspaceId={workspaceId} />
    </div>
  );
}
