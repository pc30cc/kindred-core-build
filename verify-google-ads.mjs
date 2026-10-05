import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
const scripts = [];
let cookie = '';
globalThis.window = { location: new URL('https://app.webyar.ai/auth/signup?email=secret%40example.com&token=SECRET&gclid=TEST_CLICK') };
Object.defineProperty(globalThis, 'navigator', { value: { globalPrivacyControl: false }, configurable: true });
globalThis.document = {
  get cookie() { return cookie; }, set cookie(value) { cookie = value.split(';')[0]; },
  referrer: 'https://webyar.ai/?email=private%40example.com',
  querySelector: () => scripts.length ? scripts[0] : null,
  createElement: () => ({}), head: { appendChild: script => scripts.push(script) },
};
const ads = await import('./src/lib/googleAds.ts');
const id = webcrypto.randomUUID();
assert.equal(ads.initGoogleAds(), false);
assert.equal(scripts.length, 0, 'No Google request before consent');
assert.equal(ads.trackSuccessfulSignup(id), false);
ads.setAdsConsent('granted');
assert.equal(scripts.length, 1);
assert.equal(ads.initGoogleAds(), true);
assert.equal(scripts.length, 1, 'Only one script');
const events = () => window.dataLayer.map(args => Array.from(args)).filter(args => args[0] === 'event');
assert.equal(events().length, 1, 'Pending successful signup sent after consent');
assert.equal(ads.trackSuccessfulSignup(id), false);
assert.equal(events().length, 1, 'Duplicate suppressed');
const payload = events()[0][2];
assert.equal(payload.send_to, 'AW-11183167040/_HRMCLijlJIdEMCsxtQp');
assert.equal(payload.transaction_id, id);
assert.equal(payload.value, 0);
assert.ok(!JSON.stringify(window.dataLayer).includes('SECRET'));
assert.ok(!JSON.stringify(window.dataLayer).includes('example.com'));
assert.ok(payload.page_location.includes('gclid=TEST_CLICK'));
ads.setAdsConsent('denied');
assert.equal(ads.trackSuccessfulSignup(webcrypto.randomUUID()), false);
assert.equal(events().length, 1);
ads.setAdsConsent('granted');
assert.equal(ads.trackSuccessfulSignup(webcrypto.randomUUID()), true);
navigator.globalPrivacyControl = true;
assert.equal(ads.trackSuccessfulSignup(webcrypto.randomUUID()), false);
navigator.globalPrivacyControl = false;
window.location = new URL('https://customer.example/auth/signup');
assert.equal(ads.trackSuccessfulSignup(webcrypto.randomUUID()), false);
window.location = new URL('http://app.webyar.ai/auth/signup');
assert.equal(ads.initGoogleAds(), false);
console.log('PASS: consent, deduplication, attribution, no personal fields, GPC, production scope');
