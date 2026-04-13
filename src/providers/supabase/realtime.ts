import { supabase } from '@/lib/supabase';
import type { RealtimeProvider, RealtimeChannel } from '@/types/providers';

export const supabaseRealtimeProvider: RealtimeProvider = {
  channel(name: string): RealtimeChannel {
    const ch = supabase.channel(name);
    return {
      subscribe() { ch.subscribe(); },
      unsubscribe() { supabase.removeChannel(ch); },
      on(event: string, callback: (payload: unknown) => void) {
        ch.on('broadcast' as any, { event }, callback);
        return this;
      },
    };
  },

  removeChannel(channel: RealtimeChannel) {
    channel.unsubscribe();
  },

  onPresenceSync(channelName: string, callback: (state: Record<string, unknown>) => void) {
    const ch = supabase.channel(channelName);
    ch.on('presence', { event: 'sync' }, () => {
      callback(ch.presenceState() as Record<string, unknown>);
    });
    ch.subscribe();
    return () => { supabase.removeChannel(ch); };
  },

  async trackPresence(channelName: string, data: Record<string, unknown>) {
    const ch = supabase.channel(channelName);
    await ch.track(data);
  },
};
