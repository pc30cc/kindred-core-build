/**
 * Async error safety for Express 4 — no extra dependency.
 *
 * Express 4 only catches errors THROWN synchronously by a handler; a handler
 * that is an `async` function and rejects (an `await` that throws outside a
 * try/catch) produces an unhandled promise rejection instead of reaching the
 * error-handling middleware. On Node >= 15 an unhandled rejection terminates
 * the process, i.e. one bad request anywhere takes the API down for every
 * tenant.
 *
 * `installExpressAsyncErrors()` uses the same technique as the
 * `express-async-errors` package: it patches the shared `Layer` prototype
 * (every `app.use`, `router.use`, `router.get`, route-level handler … is a
 * Layer) so that when a handler returns a thenable that rejects, the error
 * is forwarded to `next(err)` exactly like a synchronous throw would be.
 *
 * Guarantees:
 *  - Handlers that don't return a promise behave exactly as before (the
 *    method bodies below mirror express/lib/router/layer.js 4.x).
 *  - `next` is never called twice by the patch: if the handler already
 *    called `next` (with or without an error) before its promise rejected,
 *    or the response has already been fully written, the rejection is only
 *    logged.
 *  - Handlers that catch their own errors are unaffected (their promise
 *    resolves).
 *
 * Patching the prototype affects Layers created before AND after the call,
 * so import order is not load-bearing, but server/index.ts imports this first
 * anyway. Idempotent.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

const PATCHED = Symbol.for('webyar.expressAsyncErrors.patched');

type AnyFn = (...args: unknown[]) => unknown;

/**
 * True for real promises (what an `async` handler returns). Deliberately NOT
 * any bare thenable: lazy thenables such as an un-awaited Supabase query
 * builder only execute when `.then` is called, so touching them would change
 * behaviour. Same rule as express-async-errors (`then` + `catch`).
 */
function isPromise(value: unknown): value is Promise<unknown> {
  if (value instanceof Promise) return true;
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function'
  );
}

/** Resolves Express's internal Layer prototype without a deep import. */
function getLayerPrototype(): Record<PropertyKey, unknown> | null {
  const probe = express.Router();
  probe.use((_req: Request, _res: Response, next: NextFunction) => next());
  const layer = (probe as unknown as { stack?: unknown[] }).stack?.[0];
  return layer ? (Object.getPrototypeOf(layer) as Record<PropertyKey, unknown>) : null;
}

/**
 * Calls `fn`, handing it a `next` that records whether it was invoked, and
 * forwards a rejection of the returned promise to `next` (once).
 */
function invoke(
  fn: AnyFn,
  args: unknown[],
  res: Response,
  next: NextFunction,
  setNext: (guarded: NextFunction) => void,
): void {
  let nextCalled = false;
  const guardedNext = ((err?: unknown) => {
    nextCalled = true;
    return next(err as never);
  }) as NextFunction;
  setNext(guardedNext);

  let ret: unknown;
  try {
    ret = fn(...args);
  } catch (err) {
    // Unchanged Express 4 semantics for synchronous throws.
    next(err);
    return;
  }

  if (!isPromise(ret)) return;
  ret.then(undefined, (reason: unknown) => {
    // `next(undefined|null|false)` would mean "no error" to Express, so a
    // falsy rejection reason must be normalised into a real error.
    const err = reason || new Error('Async handler rejected without a reason');
    if (nextCalled || res.writableEnded) {
      // The request has already moved on (next() was called) or the
      // response is complete — forwarding would double-handle it. Log so
      // the failure is never silent.
      console.error('[express] async handler rejected after the response was handled:', err);
      return;
    }
    next(err);
  });
}

export function installExpressAsyncErrors(): boolean {
  const proto = getLayerPrototype();
  if (!proto) {
    console.error('[express] async error patch NOT installed: Layer prototype not found');
    return false;
  }
  if (proto[PATCHED]) return true;

  proto.handle_request = function handle(this: { handle: AnyFn }, req: Request, res: Response, next: NextFunction) {
    const fn = this.handle;
    if (fn.length > 3) {
      // not a standard request handler
      return next();
    }
    const args: unknown[] = [req, res, next];
    invoke(fn, args, res, next, (g) => {
      args[2] = g;
    });
  };

  proto.handle_error = function handle_error(
    this: { handle: AnyFn },
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const fn = this.handle;
    if (fn.length !== 4) {
      // not a standard error handler
      return next(error);
    }
    const args: unknown[] = [error, req, res, next];
    invoke(fn, args, res, next, (g) => {
      args[3] = g;
    });
  };

  proto[PATCHED] = true;
  return true;
}

/**
 * Process-level last-resort handlers for an HTTP entrypoint.
 *
 * unhandledRejection: log and keep running. Node's default (>= 15) is to
 * crash, which for this multi-tenant API meant any stray rejected promise
 * was a full outage for every workspace.
 *
 * uncaughtException: log (with stack) and keep running, for the same reason
 * — a single request-scoped bug must not take the whole API down. The one
 * exception is a failure to bind the listening socket (EADDRINUSE / EACCES
 * on `listen`): the process could never serve traffic, so it exits and lets
 * the orchestrator restart it instead of lingering as a zombie that only
 * runs background tickers. Nothing is swallowed silently: every event is
 * logged with its full error.
 */
export function installProcessErrorHandlers(tag: string): void {
  const flag = Symbol.for(`webyar.processErrorHandlers.${tag}`);
  const g = globalThis as Record<symbol, unknown>;
  if (g[flag]) return;
  g[flag] = true;

  process.on('unhandledRejection', (reason) => {
    console.error(`[${tag}] unhandledRejection:`, reason);
  });
  process.on('uncaughtException', (err, origin) => {
    console.error(`[${tag}] uncaughtException (${origin}):`, err);
    if ((err as NodeJS.ErrnoException)?.syscall === 'listen') {
      console.error(`[${tag}] cannot bind the listening socket — exiting`);
      process.exit(1);
    }
  });
}

installExpressAsyncErrors();
