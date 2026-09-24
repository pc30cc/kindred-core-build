#!/usr/bin/env python3
"""
TEST ONLY: the extension's admin actions through the REAL OpenCart admin
(permission + user_token + the page's own CSRF token), and what a storefront
page view costs with the widget on.

    admin_checks.py <4|3> <base> <db>
"""
import json, subprocess, sys
import requests
import oc_admin
from oc_admin import Admin

oc_admin.log = lambda *a, **k: None  # keep stdout for the summary

MAJOR, BASE, DB = int(sys.argv[1]), sys.argv[2].rstrip('/'), sys.argv[3]
results = []

def check(name, ok, detail=None):
    results.append({'check': name, 'ok': bool(ok), **({'detail': detail} if not ok else {})})

def q(sql):
    return subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-N', DB, '-e', sql], capture_output=True, text=True).stdout.strip()

def count_queries(url, cookies=None):
    """Every SQL statement MariaDB saw while serving one page view — after a
    warm-up view (a cold file cache adds currency/language/information reads),
    and without OpenCart's own probabilistic session GC (`DELETE FROM session
    WHERE expire < …` + `OPTIMIZE TABLE session`), which lands on a random
    request whether the widget is on or off."""
    import os, re, time
    requests.get(url, cookies=cookies)
    path = f'/tmp/wyoc/sp/pageview-{time.time_ns()}.log'
    subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-e', f"SET GLOBAL general_log_file='{path}'; SET GLOBAL general_log=1;"])
    html = requests.get(url, cookies=cookies).text
    subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-e', 'SET GLOBAL general_log=0;'])
    session_gc = re.compile(r'Query\t(DELETE FROM `?\w*session`? WHERE `?expire`? <|OPTIMIZE TABLE `?\w*session`?)')
    lines = [l for l in open(path, errors='ignore') if 'Query\t' in l and 'general_log' not in l and not session_gc.search(l)]
    os.remove(path)
    webyar = [l for l in lines if 'webyar' in l.lower()]
    return html, len(lines), len(webyar)

admin = Admin(MAJOR, BASE, 'admin', 'Admin12345!')
html, csrf = admin.page()
check('settings page renders for an admin', csrf is not None)
check('admin page carries no storefront widget', 'gs-widget-loader' not in html)

form = {'webyar_csrf': csrf, 'module_webyar_status': '1', 'module_webyar_app_url': 'https://app.example.test', 'module_webyar_api_url': '',
        'module_webyar_orders': '1', 'module_webyar_reviews': '1', 'module_webyar_customer_scope': 'installation', 'widget[0]': '1', 'widget[1]': '1'}
res = admin.post('save', form)
check('save with the form token succeeds', 'success' in res, res)
res = admin.post('save', {**form, 'webyar_csrf': 'forged'})
check('save with a forged token is refused', 'error' in res and 'success' not in res, res)
res = admin.post('save', {**form, 'module_webyar_app_url': 'http://evil.example'})
check('a non-https Web Yar address is refused', 'error' in res, res)
res = admin.post('connect', {'webyar_csrf': csrf, 'store_id': '0'})
check('connecting an http store explains https is required', 'error' in res and 'https' in json.dumps(res), res)
res = admin.post('connect', {'webyar_csrf': csrf, 'store_id': '99'})
check('an unknown store is refused', 'error' in res, res)

# Widget: once per storefront page, nowhere with the switch off.
store_html, total, webyar = count_queries(BASE + '/')
check('storefront has exactly one loader', store_html.count('s.id="gs-widget-loader"') == 1, store_html.count('gs-widget-loader'))
check('storefront page view: the extension runs no SQL of its own', webyar == 0, webyar)
product_html = requests.get(BASE + ('/index.php?route=product/product&language=en-gb&product_id=40' if MAJOR == 4 else '/index.php?route=product/product&product_id=40')).text
check('product page has exactly one loader', product_html.count('s.id="gs-widget-loader"') == 1)
check('the page carries no identity assertion', 'data-commerce-assertion' not in store_html and 'assertion' not in store_html.split('gs-widget-loader')[-1][:600])
res = admin.post('save', {**form, 'widget[0]': '0'})
off_html, total_off, _ = count_queries(BASE + '/')
check('widget switch off removes the loader', 'gs-widget-loader' not in off_html)
check('page-view query count identical with the widget on or off', total == total_off, [total, total_off])
admin.post('save', form)

# Disconnect store 1 only.
res = admin.post('disconnect', {'webyar_csrf': csrf, 'store_id': '1'})
check('disconnect answers', 'success' in res or 'redirect' in res, res)
check('store 1 credential removed, store 0 kept', q("SELECT COUNT(*) FROM oc_setting WHERE `key`='module_webyar_conn' AND store_id=1") == '0' and q("SELECT COUNT(*) FROM oc_setting WHERE `key`='module_webyar_conn' AND store_id=0") == '1')
enc = q("SELECT value FROM oc_setting WHERE `key`='module_webyar_conn' AND store_id=0")
check('the stored credential is encrypted at rest', 'test-secret' not in enc and 'secret_enc' in enc, enc[:120])

failed = [r for r in results if not r['ok']]
print(json.dumps({'opencart': MAJOR, 'passed': len(results) - len(failed), 'failed': len(failed), 'pageview_queries': total, 'results': results}, indent=1))
sys.exit(1 if failed else 0)
