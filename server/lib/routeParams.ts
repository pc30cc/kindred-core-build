/**
 * Route parameter helpers.
 *
 * The project builds against `@types/express@5`, where `req.params.*` is
 * typed as `string | string[]`. The Express 4 runtime actually in use only
 * ever produces a single string for a path parameter, so an array value is
 * treated as invalid input rather than silently coerced.
 *
 * Contract:
 *   - string        → returned as-is (including the empty string)
 *   - string[]      → `undefined` (never blindly collapsed to one element)
 *   - undefined     → `undefined`
 *
 * Use only for route params. Do not reuse for query strings or bodies,
 * where arrays are a legitimate, documented shape.
 */
export function routeParam(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
