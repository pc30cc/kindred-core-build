// ============================================================
// INTERNAL TEST GATEWAY PAGE
//
// Serves the simulated "bank page" for the `internal_test` billing provider.
// It is a plain, self-hosted HTML page with two outcomes (pay / cancel) that
// redirects back to the same callback URL a real Iranian gateway would use.
//
// No money, no external call, no persistence: the financial truth stays in
// the payment intent + verify pipeline. Every hop is HMAC-signed so a browser
// cannot forge a successful outcome.
// ============================================================

import { Router } from 'express';
import {
  signOutcome,
  verifyCheckoutSignature,
} from '../services/billing/providers/internal-test.js';

export const internalTestGatewayRouter = Router();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** Only same-deployment (relative-safe absolute) callbacks are ever followed. */
function isSameOriginCallback(req: { protocol: string; get(name: string): string | undefined }, raw: string): boolean {
  try {
    const target = new URL(raw);
    const host = req.get('host');
    if (!host) return false;
    return target.host === host;
  } catch {
    return false;
  }
}

function withParams(callbackUrl: string, params: Record<string, string>): string {
  const url = new URL(callbackUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function formatToman(rials: number): string {
  return new Intl.NumberFormat('fa-IR').format(Math.round(rials / 10));
}

internalTestGatewayRouter.get('/', (req, res) => {
  const ref = String(req.query.ref || '');
  const amount = String(req.query.amount || '');
  const cb = String(req.query.cb || '');
  const sig = String(req.query.sig || '');

  if (!ref || !amount || !cb || !verifyCheckoutSignature(ref, amount, cb, sig)) {
    return res.status(400).type('html').send('<h1>Invalid test gateway request</h1>');
  }
  if (!isSameOriginCallback(req, cb)) {
    return res.status(400).type('html').send('<h1>Invalid callback URL</h1>');
  }

  const successUrl = withParams(cb, {
    authority: ref,
    status: 'OK',
    rsig: signOutcome(ref, 'OK'),
  });
  const failureUrl = withParams(cb, {
    authority: ref,
    status: 'NOK',
    rsig: signOutcome(ref, 'NOK'),
  });

  res.type('html').send(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>درگاه تست داخلی</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f1f5f9; font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; }
  .card { background:#fff; width:min(420px, 92vw); border-radius:18px; padding:28px;
          box-shadow:0 20px 45px rgba(15,23,42,.12); border:1px solid #e2e8f0; }
  .badge { display:inline-block; font-size:12px; font-weight:600; color:#1d4ed8; background:#dbeafe;
           border-radius:999px; padding:5px 12px; margin-bottom:14px; }
  h1 { font-size:19px; margin:0 0 6px; color:#0f172a; }
  p { color:#64748b; font-size:13px; margin:0 0 18px; line-height:1.7; }
  .row { display:flex; justify-content:space-between; font-size:13px; color:#334155;
         padding:10px 0; border-top:1px solid #f1f5f9; }
  .amount { font-size:24px; font-weight:700; color:#0f172a; margin:6px 0 14px; }
  .ref { font-family: ui-monospace, monospace; font-size:12px; color:#64748b; }
  a.btn { display:block; text-align:center; text-decoration:none; padding:13px; border-radius:12px;
          font-weight:600; font-size:15px; margin-top:10px; transition:transform .12s ease, opacity .12s ease; }
  a.btn:active { transform:scale(.985); }
  .pay { background:#3B82F6; color:#fff; }
  .cancel { background:#f8fafc; color:#475569; border:1px solid #e2e8f0; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">محیط تست — پول واقعی جابه‌جا نمی‌شود</span>
    <h1>درگاه پرداخت تست داخلی</h1>
    <p>این صفحه فقط برای آزمایش سیستم مالی است. نتیجهٔ پرداخت را خودتان انتخاب کنید.</p>
    <div class="amount">${escapeHtml(formatToman(Number(amount) || 0))} تومان</div>
    <div class="row"><span>شمارهٔ پیگیری</span><span class="ref">${escapeHtml(ref)}</span></div>
    <a class="btn pay" href="${escapeHtml(successUrl)}">پرداخت موفق</a>
    <a class="btn cancel" href="${escapeHtml(failureUrl)}">انصراف / پرداخت ناموفق</a>
  </main>
</body>
</html>`);
});
