import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listWidgetTemplates,
  updateWidgetTemplate,
  type WidgetTemplate,
} from '@/lib/widget-templates-api';

const QUERY_KEY = ['admin', 'widget-templates'] as const;

export function useWidgetTemplates() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: listWidgetTemplates,
  });
}

export function useUpdateWidgetTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<WidgetTemplate> }) =>
      updateWidgetTemplate(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}