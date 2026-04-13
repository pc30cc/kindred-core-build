import { Activity } from 'lucide-react';
import { useProviderSummary, PROVIDER_TYPE_KEYS } from '@/providers';
import { PROVIDER_SCHEMAS } from '@/features/providers/schemas';
import { AdminProviderCard } from '@/features/providers/AdminProviderCard';

export default function AdminProvidersPage() {
  const summary = useProviderSummary();
  const configured = Object.entries(summary).filter(
    ([, s]) => s.registered.length > 0 && s.active
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Provider Control Center</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {configured}/{PROVIDER_TYPE_KEYS.length} provider types have an active default.
            Configure global providers for the entire platform.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Live Registry</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDER_TYPE_KEYS.map((type) => (
          <AdminProviderCard key={type} type={type} />
        ))}
      </div>
    </div>
  );
}
