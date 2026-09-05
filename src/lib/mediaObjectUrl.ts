/**
 * Authenticated media source resolver.
 *
 * On the WEB nothing changes: the browser sends the HttpOnly session cookie
 * with `<img src>` / `<video src>` requests, so the proxy URL is used as-is.
 *
 * Inside the NATIVE shell there is no cookie — auth is a Bearer token from the
 * Keychain — and a raw `src` attribute cannot carry a header, so media used to
 * silently 401 and render as "file" placeholders. There we fetch the bytes
 * through `authFetch` once and hand the element a blob: URL instead.
 */
import { useEffect, useState } from 'react';
import { authFetch } from './authFetch';
import { isNativePlatform } from './native';

export function useAuthedMediaSrc(url: string): { src: string | null; failed: boolean } {
  const native = isNativePlatform();
  const [src, setSrc] = useState<string | null>(native ? null : url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!native) {
      setSrc(url);
      setFailed(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setFailed(false);

    authFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, native]);

  return { src, failed };
}

/** Download/open an attachment through the authenticated transport. */
export async function openAuthedAttachment(url: string, fileName: string): Promise<void> {
  if (!isNativePlatform()) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    return;
  }
  const res = await authFetch(url);
  if (!res.ok) return;
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
