/**
 * Super Admin — dunning policy.
 *
 * Grace period and the fallback plan live here and nowhere else: a workspace
 * must never be able to extend its own grace or choose where it lands. The
 * server re-validates every field, so this form is only a convenient editor.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/apiBase';

interface Policy {
  reminder_days_before_due: number[];
  send_invoice_issued_email: boolean;
  send_invoice_issued_sms: boolean;
  notify_on_due: boolean;
  notify_on_past_due: boolean;
  notify_on_fallback: boolean;
  grace_period_days: number;
  fallback_plan_id: string | null;
  notification_max_attempts: number;
  notification_retry_minutes: number;
  notification_daily_cap: number;
}

interface PlanOption {
  id: string;
  name: string;
  slug: string;
  is_free: boolean;
}

const BASE = `${API_BASE}/api/admin/billing-v2/dunning`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as T;
}

export default function DunningPolicyPage() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [remindersText, setRemindersText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [p, m] = await Promise.all([
      api<{ policy: Policy; plans: PlanOption[] }>('/policy'),
      api<{ metrics: Record<string, unknown> }>('/metrics').catch(() => ({ metrics: {} })),
    ]);
    setPolicy(p.policy);
    setPlans(p.plans);
    setRemindersText((p.policy?.reminder_days_before_due || []).join(', '));
    setMetrics(m.metrics);
  };

  useEffect(() => {
    load().catch((e) => toast.error(String(e.message || e)));
  }, []);

  const set = <K extends keyof Policy>(key: K, value: Policy[K]) =>
    setPolicy((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!policy) return;
    const days = remindersText
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 60);
    if (days.length === 0 || days.length > 6) {
      toast.error('Reminder days must be 1 to 6 whole numbers between 0 and 60.');
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ policy: Policy }>('/policy', {
        method: 'PUT',
        body: JSON.stringify({ ...policy, reminder_days_before_due: days }),
      });
      setPolicy(res.policy);
      setRemindersText((res.policy.reminder_days_before_due || []).join(', '));
      toast.success('Dunning policy saved.');
    } catch (e: any) {
      toast.error(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  if (!policy) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const toggles: Array<{ key: keyof Policy; label: string; hint: string }> = [
    { key: 'send_invoice_issued_email', label: 'Email on invoice issued', hint: 'Sent when a renewal invoice is created.' },
    { key: 'send_invoice_issued_sms', label: 'SMS on invoice issued', hint: 'Off by default; SMS carries no sensitive data.' },
    { key: 'notify_on_due', label: 'Notify on due date', hint: 'Sent on the due day, after auto-pay is attempted.' },
    { key: 'notify_on_past_due', label: 'Notify on past due', hint: 'Sent once the invoice becomes past due.' },
    { key: 'notify_on_fallback', label: 'Notify on free fallback', hint: 'Sent when the workspace moves to the fallback plan.' },
  ];

  const numbers: Array<{ key: keyof Policy; label: string; hint: string; min: number; max: number }> = [
    { key: 'grace_period_days', label: 'Grace period (days)', hint: 'Service continues during grace. Super Admin only.', min: 0, max: 30 },
    { key: 'notification_max_attempts', label: 'Notification max attempts', hint: 'Bounded retries per message.', min: 1, max: 20 },
    { key: 'notification_retry_minutes', label: 'Retry interval (minutes)', hint: 'Backoff base between delivery attempts.', min: 1, max: 720 },
    { key: 'notification_daily_cap', label: 'Daily cap per workspace', hint: 'Rate guard against notification storms.', min: 1, max: 50 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dunning policy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Reminders, grace period and free fallback for unpaid renewal invoices.
        </p>
      </div>

      {metrics && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(metrics).map(([key, value]) => (
            <Card key={key}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{key.replace(/_/g, ' ')}</p>
                <p className="mt-1 text-xl font-semibold">{String(value ?? 0)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reminders and notifications</CardTitle>
          <CardDescription>
            All messages are transactional. Delivery never blocks or rolls back a payment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="reminders">Reminder days before due</Label>
            <Input
              id="reminders"
              value={remindersText}
              onChange={(e) => setRemindersText(e.target.value)}
              placeholder="5, 1"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated whole days. Reminders already in the past are skipped, not flooded.
            </p>
          </div>

          {toggles.map((item) => (
            <div key={String(item.key)} className="flex items-start justify-between gap-4">
              <div>
                <Label>{item.label}</Label>
                <p className="text-xs text-muted-foreground">{item.hint}</p>
              </div>
              <Switch
                checked={Boolean(policy[item.key])}
                onCheckedChange={(v) => set(item.key, v as never)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Grace and fallback</CardTitle>
          <CardDescription>
            Platform-level only. A workspace can never extend its own grace or pick its fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {numbers.map((item) => (
            <div key={String(item.key)} className="space-y-1.5">
              <Label htmlFor={String(item.key)}>{item.label}</Label>
              <Input
                id={String(item.key)}
                type="number"
                min={item.min}
                max={item.max}
                value={Number(policy[item.key] ?? 0)}
                onChange={(e) => set(item.key, Number(e.target.value) as never)}
              />
              <p className="text-xs text-muted-foreground">{item.hint}</p>
            </div>
          ))}

          <div className="space-y-1.5">
            <Label>Fallback plan</Label>
            <Select
              value={policy.fallback_plan_id ?? 'none'}
              onValueChange={(v) => set('fallback_plan_id', v === 'none' ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a free plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No fallback (stay past due)</SelectItem>
                {plans
                  .filter((p) => p.is_free)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only free plans are accepted: billing a customer who already failed to pay is never
              a valid fallback. No data is deleted at fallback.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save policy'}
        </Button>
      </div>
    </div>
  );
}
