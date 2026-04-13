import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminBillingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Billing Management</h1>
      <p className="text-slate-400 text-sm">Platform-wide billing overview and subscription management.</p>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader><CardTitle className="text-white text-sm">Billing Status</CardTitle></CardHeader>
        <CardContent className="text-slate-400 text-sm">
          <p>Billing provider is not yet configured. Enable it in <strong>Feature Flags</strong> and configure in <strong>Providers</strong>.</p>
        </CardContent>
      </Card>
    </div>
  );
}
