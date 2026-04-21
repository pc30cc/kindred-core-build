/**
 * Account API — self-service profile, avatar, and password
 * for the currently authenticated user. Auth is the user's Supabase JWT,
 * which is fetched fresh on each call to avoid stale tokens.
 */
import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function userAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await userAuthHeaders()),
    ...((init?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as T;
}

export interface AccountMe {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  phone: string | null;
  created_at: string;
  profile: {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
    preferred_locale: string | null;
    company_name: string | null;
    website_domain: string | null;
    [k: string]: unknown;
  } | null;
}

export function fetchAccountMe() {
  return request<AccountMe>('/api/account/me');
}

export interface AccountUpdate {
  full_name?: string | null;
  first_name?: string;
  last_name?: string;
  preferred_locale?: string | null;
  company_name?: string | null;
  website_domain?: string | null;
  phone?: string | null;
}

export function updateAccount(updates: AccountUpdate) {
  return request<{ success: boolean; profile: AccountMe['profile'] }>('/api/account/me', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/** Read a File as a base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export async function uploadAccountAvatar(file: File) {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Avatar must be smaller than 10 MB');
  }
  const data = await fileToBase64(file);
  return request<{ success: boolean; url: string; fileKey: string }>('/api/account/avatar', {
    method: 'POST',
    body: JSON.stringify({
      data,
      contentType: file.type || 'image/jpeg',
      fileName: file.name,
    }),
  });
}

export function removeAccountAvatar() {
  return request<{ success: boolean }>('/api/account/avatar', { method: 'DELETE' });
}

export function changeAccountPassword(currentPassword: string, newPassword: string) {
  return request<{ success: boolean }>('/api/account/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}