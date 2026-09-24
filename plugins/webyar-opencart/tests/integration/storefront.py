#!/usr/bin/env python3
"""TEST ONLY: a real storefront session — log in as a customer through OpenCart's own login, then call the lazy identity endpoint."""
import json, re, sys
import requests

def login(major, base, email, password):
    s = requests.Session()
    if major == 4:
        page = s.get(f'{base}index.php?route=account/login&language=en-gb').text
        action = re.search(r'action="([^"]*account/login\.login[^"]*)"', page).group(1).replace('&amp;', '&')
        res = s.post(action, data={'email': email, 'password': password}).json()
        assert 'redirect' in res, res
    else:
        s.get(f'{base}index.php?route=account/login')
        res = s.post(f'{base}index.php?route=account/login', data={'email': email, 'password': password}, allow_redirects=False)
        assert res.status_code in (301, 302), res.status_code
    return s

def logout(major, base, s):
    s.get(f'{base}index.php?route=account/logout' + ('&language=en-gb' if major == 4 else ''))

def context(major, base, s, headers=None):
    route = 'extension/webyar/module/webyar.context' if major == 4 else 'extension/module/webyar/context'
    res = s.get(f'{base}index.php?route={route}', headers=headers or {'Sec-Fetch-Site': 'same-origin'})
    return res.status_code, res.headers.get('Cache-Control'), res.json()

if __name__ == '__main__':
    major, base = int(sys.argv[1]), sys.argv[2]
    s = login(major, base, sys.argv[3], sys.argv[4]) if len(sys.argv) > 3 else requests.Session()
    print(json.dumps(context(major, base, s), ensure_ascii=False))
