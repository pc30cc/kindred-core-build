import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { WidgetSettings } from '@/types/models';

export function useWidgetSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-settings', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetSettings>) => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}

/**
 * Upload the widget launcher image.
 *
 * The browser hands the BYTES to the backend and nothing else. It does not
 * choose the object key and it never sees — let alone persists — a storage
 * provider URL: the server builds the canonical key, stores the file, and
 * records only that key. The `fab_image_url` that comes back on `settings`
 * is derived from the key for whichever provider is primary, so it changes
 * by itself when the platform promotes a new one.
 */
export function useUploadWidgetFabImage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/fab-image`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: file.type,
          data: btoa(binary),
          fileName: file.name,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Upload failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}

/** Remove the launcher image — clears the stored key and deletes the object. */
export function useRemoveWidgetFabImage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/fab-image`, {
        credentials: 'include',
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Remove failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}
