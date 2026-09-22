/**
 * What Settings → Security calls each of your own sessions.
 *
 * The screen exists so somebody can look down the list for a device they do
 * not recognise and sign it out. Every label being roughly right is the whole
 * value of it — and two of them were wrong in a way that made the list read
 * as somebody else's:
 *
 *  - the native iOS app was "Desktop", because its user agent names itself
 *    and nothing else, so no rule matched and Desktop was the default;
 *  - every browser on an iPhone was "macOS", because an iPhone announces
 *    "CPU iPhone OS 18_7 like Mac OS X" and the Mac was tested for first.
 *
 * Both were found by reading a real account's list against the user agents
 * behind it: eighty-one live sessions, six rows, and the top row — the phone
 * in the operator's hand — labelled a desktop computer.
 */
import { describe, it, expect } from 'vitest';
import { parseUserAgent } from '../../../server/routes/account.js';

/** Real strings, as `auth_sessions.user_agent` stores them. */
const UA = {
  nativeApp: 'WebyarNative/1 CFNetwork/3860.500.112 Darwin/25.6.0',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/156.0 Mobile/15E148 Safari/605.1.15',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.0.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  curl: 'curl/8.7.1',
};

describe('session device labels', () => {
  it('names the native app as the phone it runs on', () => {
    expect(parseUserAgent(UA.nativeApp)).toEqual({
      browser: 'Webyar',
      os: 'iOS',
      device: 'Mobile',
    });
  });

  it('an iPhone is not a Mac, whatever its user agent says about Mac OS X', () => {
    for (const ua of [UA.iphoneSafari, UA.iphoneFirefox, UA.iphoneChrome]) {
      expect(parseUserAgent(ua).os).toBe('iOS');
      expect(parseUserAgent(ua).device).toBe('Mobile');
    }
  });

  it('tells the browsers on an iPhone apart, which are all WebKit underneath', () => {
    expect(parseUserAgent(UA.iphoneSafari).browser).toBe('Safari');
    expect(parseUserAgent(UA.iphoneFirefox).browser).toBe('Firefox');
    expect(parseUserAgent(UA.iphoneChrome).browser).toBe('Chrome');
  });

  it('still reads the desktop browsers it always read', () => {
    expect(parseUserAgent(UA.macSafari)).toEqual({ browser: 'Safari', os: 'macOS', device: 'Desktop' });
    expect(parseUserAgent(UA.macFirefox)).toEqual({ browser: 'Firefox', os: 'macOS', device: 'Desktop' });
    expect(parseUserAgent(UA.windowsChrome)).toEqual({ browser: 'Chrome', os: 'Windows', device: 'Desktop' });
  });

  it('an iPad is a tablet, though its user agent claims Mobile too', () => {
    expect(parseUserAgent(UA.ipad).device).toBe('Tablet');
    expect(parseUserAgent(UA.ipad).os).toBe('iOS');
  });

  it('reads Android', () => {
    expect(parseUserAgent(UA.android)).toEqual({ browser: 'Chrome', os: 'Android', device: 'Mobile' });
  });

  it('does not call an unrecognised client a desktop', () => {
    // It used to, which put every script in the same row as every other one
    // — and, while the app went unrecognised too, in the same row as the
    // operator's own phone, where it could not be signed out because that
    // row was the current session.
    expect(parseUserAgent(UA.curl)).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'Unknown' });
    expect(parseUserAgent(null)).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'Unknown' });
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'Unknown' });
  });

  it('the app and a script are no longer the same row', () => {
    const key = (ua: string) => {
      const { device, os, browser } = parseUserAgent(ua);
      return `${device}|${os}|${browser}`;
    };
    expect(key(UA.nativeApp)).not.toBe(key(UA.curl));
  });
});
