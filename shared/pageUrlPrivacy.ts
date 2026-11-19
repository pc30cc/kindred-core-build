/**
 * What a visitor's page address keeps when the server stores it (a chat's
 * page context, a call's or a callback's page, a nudge's path): never a
 * credential or a contact detail in its query.
 *
 * Query parameter names are matched case-insensitively (`?Token=`,
 * `?ACCESS_TOKEN=` are the same secret as `?token=`), and any name ending in
 * one of the credential words (`reset_token`, `client-secret`) counts too.
 *
 * The widgets carry their own copy of this list (public/widget/runtime-chat.js
 * `SENSITIVE_QS`, public/call-widget/runtime.js `SENSITIVE_QS`): they strip
 * before sending, the server again before storing.
 * src/test/widget/pageUrlPrivacy.test.ts keeps the three equal.
 */
export const SENSITIVE_URL_PARAMS: readonly string[] = [
  'token', 'access_token', 'refresh_token', 'id_token', 'code', 'otp', 'password', 'session', 'auth',
  'key', 'secret', 'api_key', 'apikey', 'sig', 'signature', 'jwt', 'email', 'phone', 'mobile',
];

/** A name ending in a credential word: `reset_token`, `client-secret`, `user_password`. */
export const SENSITIVE_URL_PARAM_TAIL = /(^|[_-])(token|secret|password|passwd|pwd|apikey|jwt)$/;

/** Whether a query parameter `name` is never kept (case-insensitive). */
export function isSensitiveUrlParam(name: string): boolean {
  const k = String(name).toLowerCase();
  return SENSITIVE_URL_PARAMS.includes(k) || SENSITIVE_URL_PARAM_TAIL.test(k);
}

/** `url` without its sensitive query parameters and its fragment (changed in place, and returned). */
export function stripSensitiveUrlParts(url: URL): URL {
  url.hash = '';
  const names = Array.from(new Set(Array.from(url.searchParams.keys())));
  for (const name of names) {
    if (isSensitiveUrlParam(name)) url.searchParams.delete(name);
  }
  return url;
}
