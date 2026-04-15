import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * Loads the platform support widget on public/auth pages.
 * Reads the support workspace ID from app_runtime_config (publicly readable).
 */
export function PlatformWidget() {
  useEffect(() => {
    let scriptEl: HTMLScriptElement | null = null;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'support_widget_workspace_id')
        .maybeSingle();

      if (cancelled || !data?.value) return;

      const workspaceId = typeof data.value === 'string' ? data.value : String(data.value);
      if (!workspaceId) return;

      (window as any).__gs = [];
      (window as any).__gs_id = workspaceId;

      scriptEl = document.createElement('script');
      scriptEl.src = `${window.location.origin}/widget/loader.js`;
      scriptEl.async = true;
      document.head.appendChild(scriptEl);
    })();

    return () => {
      cancelled = true;
      if (scriptEl) scriptEl.remove();
      delete (window as any).__gs;
      delete (window as any).__gs_id;
      delete (window as any).__gs_runtime;
    };
  }, []);

  return null;
}
