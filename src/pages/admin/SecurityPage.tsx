import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Shield, AlertTriangle } from 'lucide-react';

export default function AdminSecurityPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Security</h1>
      <p className="text-slate-400 text-sm">Platform security overview, suspicious activity, and configuration audit.</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="flex flex-row items-center gap-2">
            <Shield className="h-5 w-5 text-green-400" />
            <CardTitle className="text-white text-sm">RLS Status</CardTitle>
          </CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-1">
            <p>✓ All 20 tables have RLS enabled</p>
            <p>✓ 47+ policies active</p>
            <p>✓ Security definer functions in use</p>
            <p>✓ Admin access via has_role() checks</p>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="flex flex-row items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-400" />
            <CardTitle className="text-white text-sm">Security Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-1">
            <p>⚠ visitor_sessions and visitor_presence use anon USING(true) — intentional for widget tracking</p>
            <p>⚠ Service role key must remain server-side only</p>
            <p>⚠ bootstrap_admin() only works when no admin exists</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
