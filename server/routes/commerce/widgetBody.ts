/**
 * The widget-facing commerce routers are mounted on `/api/widget/...` AFTER
 * `app.use('/api/widget', …, widgetRouter)`, so every request to them passes
 * through widgetRouter's middleware first and only falls through to them when
 * no widgetRouter route matches.
 *
 * One of those middlewares is a compatibility shim: when the request carries a
 * `dvsid` cookie it writes the visitor id INTO THE BODY (`req.body.visitor_id`)
 * for older handlers that still read it from there. It runs before route
 * matching, so it rewrites the bodies of requests it does not own.
 *
 * Both routers here validate with `z.object({...}).strict()`, and strict()
 * rejects unknown keys — so that injected key made every well-formed request
 * fail as `invalid_request`. Against the live API, the same body was rejected
 * with a cookie and accepted without one:
 *
 *   A) with dvsid    → 400 {"error":"invalid_request"}
 *   B) without dvsid → 200 {"ok":true,"linked":true,"externalCustomerId":"2"}
 *
 * Every real visitor has that cookie, so in production the customer identity
 * bridge and the whole guest order-verification flow were unreachable.
 *
 * The key is ours, not the caller's, so it is removed before validation rather
 * than by loosening strict() — which still has to reject client-supplied junk.
 */
const WIDGET_SHIM_KEYS = ['visitor_id'] as const;

export function withoutWidgetShimKeys(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const clone = { ...(body as Record<string, unknown>) };
  for (const key of WIDGET_SHIM_KEYS) delete clone[key];
  return clone;
}
