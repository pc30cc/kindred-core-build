/**
 * This tab's device id for colleague calls (TEAM_CALLS.md, "Web panel"):
 * `web-<random>`, kept in sessionStorage, so every open panel tab is its own
 * device and a reload keeps it. Sent as `device_id` on accept; the server
 * records the device that answered (`answered_device_id`), and the first
 * answer wins on every surface: a tab, an iPhone or an Android phone.
 *
 * When sessionStorage cannot be used (a private window that refuses it), the
 * id lives in this module for the tab's lifetime instead.
 */
const KEY = 'team_call_device_id';
const VALID = /^web-[a-z0-9]{8,64}$/;

let memo: string | null = null;

function randomPart(): string {
  try {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  } catch {
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20).padEnd(8, '0');
  }
}

export function teamCallDeviceId(): string {
  if (memo) return memo;
  let stored: string | null = null;
  try { stored = window.sessionStorage.getItem(KEY); } catch { stored = null; }
  if (stored && VALID.test(stored)) {
    memo = stored;
    return stored;
  }
  const id = `web-${randomPart()}`;
  try { window.sessionStorage.setItem(KEY, id); } catch { /* kept in memory */ }
  memo = id;
  return id;
}

/** Tests only: forget the id held in memory. */
export function __resetTeamCallDeviceIdForTests(): void {
  memo = null;
}
