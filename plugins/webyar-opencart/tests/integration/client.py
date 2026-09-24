#!/usr/bin/env python3
"""TEST ONLY: a signed Web Yar → store call, byte-compatible with server/services/commerce/signing.ts."""
import hashlib, hmac, json, os, sys, time
import requests

PROTOCOL = 'webyar-commerce/1'

def call(base, route_sep, store_id, installation, secret, op, body, nonce=None, ts=None, tamper=None, method='POST'):
    raw = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
    path = '/opencart/v1/' + op
    ts = str(ts or int(time.time()))
    nonce = nonce or os.urandom(16).hex()
    sts = '\n'.join([PROTOCOL, method, path, installation, ts, nonce, hashlib.sha256(raw.encode()).hexdigest()])
    sig = hmac.new(secret.encode(), sts.encode(), hashlib.sha256).hexdigest()
    headers = {'X-WebYar-Installation': installation, 'X-WebYar-Timestamp': ts, 'X-WebYar-Nonce': nonce,
               'X-WebYar-Signature': sig, 'X-WebYar-Protocol': PROTOCOL, 'Content-Type': 'application/json'}
    if tamper == 'body':
        raw = raw.replace('"', '"', 1) + ' '
    route = 'extension/webyar/module/webyar.api' if route_sep == 4 else 'extension/module/webyar/api'
    url = f"{base.rstrip('/')}/index.php?route={route}&op={op}&store_id={store_id}"
    res = requests.request(method, url, data=raw.encode(), headers=headers, allow_redirects=False)
    try:
        return res.status_code, res.json(), nonce
    except ValueError:
        return res.status_code, res.text[:300], nonce

if __name__ == '__main__':
    major, base, store, inst, secret, op = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    body = json.loads(sys.argv[7]) if len(sys.argv) > 7 else {}
    body.setdefault('store_id', store)
    st, js, _ = call(base, major, store, inst, secret, op, body)
    print(st, json.dumps(js, ensure_ascii=False, indent=1))
