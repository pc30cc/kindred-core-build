#!/usr/bin/env python3
"""
Drives a REAL OpenCart admin over HTTP the way a merchant does in the browser:
log in, upload the .ocmod.zip through Extensions → Installer, install it,
then install the module under Extensions → Modules (or the reverse).

    oc_admin.py <4|3> <base_url> <username> <password> <action> [zip]

actions: install <zip> | module-install | module-uninstall | uninstall | page | save <json-form>

This is NOT a mock: every step goes through OpenCart's own controllers,
permission checks and installer. Prints one JSON line per step.
"""
import json
import re
import sys

import requests


def log(step, **data):
    print(json.dumps({'step': step, **data}, ensure_ascii=False))


class Admin:
    def __init__(self, major, base, user, password):
        self.major = major
        self.base = base.rstrip('/') + '/admin/index.php'
        self.s = requests.Session()
        self.token = self.login(user, password)

    def sep(self, route, method):
        return f'{route}.{method}' if self.major == 4 else f'{route}/{method}'

    def url(self, route, **params):
        query = '&'.join(f'{k}={v}' for k, v in params.items())
        return f'{self.base}?route={route}&user_token={self.token}' + (f'&{query}' if query else '')

    def login(self, user, password):
        if self.major == 4:
            page = self.s.get(self.base + '?route=common/login').text
            action = re.search(r'action="([^"]*common/login\.login[^"]*)"', page).group(1).replace('&amp;', '&')
            res = self.s.post(action, data={'username': user, 'password': password}).json()
            token = re.search(r'user_token=([a-f0-9]+)', res['redirect']).group(1)
        else:
            res = self.s.post(self.base + '?route=common/login', data={'username': user, 'password': password}, allow_redirects=False)
            token = re.search(r'user_token=([a-zA-Z0-9]+)', res.headers['Location']).group(1)
        log('login', ok=True)
        return token

    def upload_and_install(self, zip_path):
        with open(zip_path, 'rb') as fh:
            files = {'file': (zip_path.split('/')[-1], fh, 'application/zip')}
            route = self.sep('marketplace/installer', 'upload')
            res = self.s.post(self.url(route), files=files).json()
        log('upload', response=res)
        if self.major == 4:
            listing = self.s.get(self.url('marketplace/installer.list')).text
            match = re.findall(r'installer\.install&amp;user_token=[a-f0-9]+&amp;extension_install_id=(\d+)', listing)
            install_id = match[-1]
            nxt = self.url('marketplace/installer.install', extension_install_id=install_id)
            while nxt:
                res = self.s.get(nxt).json()
                log('installer', response=res)
                if res.get('error'):
                    raise SystemExit(1)
                nxt = res.get('next', '').replace('&amp;', '&') or None
        else:
            nxt = res.get('next', '').replace('&amp;', '&') or None
            while nxt:
                res = self.s.post(nxt).json()
                log('installer', response=res)
                if res.get('error'):
                    raise SystemExit(1)
                nxt = res.get('next', '').replace('&amp;', '&') or None

    def module(self, action):
        if self.major == 4:
            res = self.s.get(self.url(f'extension/module.{action}', extension='webyar', code='webyar')).json()
        else:
            res = self.s.get(self.url(f'extension/extension/module/{action}', extension='webyar')).text[:200]
        log('module-' + action, response=res)

    def installer_uninstall(self):
        if self.major == 4:
            listing = self.s.get(self.url('marketplace/installer.list')).text
            ids = re.findall(r'installer\.uninstall&amp;user_token=[a-f0-9]+&amp;extension_install_id=(\d+)', listing)
            res = self.s.get(self.url('marketplace/installer.uninstall', extension_install_id=ids[-1])).json()
            log('installer-uninstall', response=res)

    def page(self):
        route = 'extension/webyar/module/webyar' if self.major == 4 else 'extension/module/webyar'
        html = self.s.get(self.url(route)).text
        csrf = re.search(r'name="webyar_csrf" value="([a-f0-9]+)"', html)
        log('page', status='ok' if csrf else 'no-form', csrf=csrf.group(1) if csrf else None, length=len(html),
            title=(re.search(r'<h1>(.*?)</h1>', html) or [None, None])[1])
        return html, csrf.group(1) if csrf else None

    def post(self, method, data):
        route = 'extension/webyar/module/webyar' if self.major == 4 else 'extension/module/webyar'
        res = self.s.post(self.url(self.sep(route, method)), data=data)
        try:
            body = res.json()
        except ValueError:
            body = res.text[:300]
        log('post-' + method, response=body)
        return body


if __name__ == '__main__':
    major, base, user, password, action = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    admin = Admin(major, base, user, password)
    if action == 'install':
        admin.upload_and_install(sys.argv[6])
    elif action in ('module-install', 'module-uninstall'):
        admin.module(action.split('-')[1])
    elif action == 'uninstall':
        admin.installer_uninstall()
    elif action == 'page':
        admin.page()
    elif action == 'post':
        _, csrf = admin.page()
        data = json.loads(sys.argv[7]) if len(sys.argv) > 7 else {}
        data['webyar_csrf'] = data.get('webyar_csrf', csrf)
        admin.post(sys.argv[6], data)
