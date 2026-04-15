import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';

export default function SettingsProfilePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user!.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const update = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const { error } = await supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: 'Saved' });
    },
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.profile')}</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Full Name</CardTitle></CardHeader>
        <CardContent>
          <Input
            defaultValue={profile?.full_name || ''}
            onBlur={e => update.mutate({ full_name: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Email</CardTitle></CardHeader>
        <CardContent>
          <Input value={profile?.email || ''} disabled />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Preferred Language</CardTitle></CardHeader>
        <CardContent>
          <Select
            value={profile?.preferred_locale || 'en'}
            onValueChange={v => update.mutate({ preferred_locale: v })}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fa">فارسی</SelectItem>
              <SelectItem value="tr">Türkçe</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Avatar URL</CardTitle></CardHeader>
        <CardContent>
          <Input
            defaultValue={profile?.avatar_url || ''}
            onBlur={e => update.mutate({ avatar_url: e.target.value })}
            placeholder="https://..."
          />
        </CardContent>
      </Card>
    </div>
  );
}
