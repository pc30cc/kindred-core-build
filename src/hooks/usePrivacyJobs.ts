/**
 * React Query hooks for privacy jobs.
 * Lists are polled every 5s while a non-terminal job exists.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listJobs, createJob, cancelJob, mintDownloadToken, exportDownloadUrl,
  type PrivacyJob, type CreateJobInput,
} from '@/lib/privacy-api';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function usePrivacyJobs(workspaceId?: string, enabled = true) {
  return useQuery({
    queryKey: ['privacy-jobs', workspaceId ?? 'self'],
    queryFn: () => listJobs(workspaceId),
    enabled,
    refetchInterval: (q) => {
      const data = q.state.data as { jobs: PrivacyJob[] } | undefined;
      if (!data) return 5000;
      return data.jobs.some((j) => !TERMINAL.has(j.status)) ? 5000 : false;
    },
  });
}

export function useCreatePrivacyJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJobInput) => createJob(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['privacy-jobs'] }),
  });
}

export function useCancelPrivacyJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['privacy-jobs'] }),
  });
}

export async function downloadExport(jobId: string): Promise<void> {
  const { token } = await mintDownloadToken(jobId);
  const url = exportDownloadUrl(jobId, token);
  // Trigger browser download via temporary anchor; backend returns Content-Disposition.
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
