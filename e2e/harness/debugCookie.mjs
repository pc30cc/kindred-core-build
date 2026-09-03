import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const runtime = JSON.parse(readFileSync('/home/user/kindred-core-build/e2e/harness/.runtime.json', 'utf8'));
const token = runtime.superAdmin.token;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext();
await context.addCookies([
  { name: 'gs_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
]);
console.log('cookies after addCookies:', await context.cookies());

const page = await context.newPage();
page.on('request', (req) => {
  if (req.url().includes('/api/')) {
    console.log('>>', req.method(), req.url(), 'cookie header:', req.headers()['cookie']);
  }
});
page.on('response', async (res) => {
  if (res.url().includes('/api/')) {
    console.log('<<', res.status(), res.url());
    if (res.url().includes('/api/auth/session')) {
      console.log('   body:', await res.text().catch(() => '<err>'));
    }
  }
});

await page.goto('http://localhost:8080/admin/verification', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
console.log('final url:', page.url());
await browser.close();
