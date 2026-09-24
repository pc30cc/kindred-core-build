#!/usr/bin/env python3
"""TEST ONLY: every SQL statement MariaDB executes for one extension request
(OpenCart's own startup included), split into core vs extension, per op.
    measure_sql.py <4|3> <base> <db> <secret>"""
import json, os, subprocess, sys, time, base64
from client import call
from storefront import login, context

MAJOR, BASE, DB, SECRET = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
INST = '11111111-1111-4111-8111-111111111111'

def logged(fn):
    path = f'/tmp/wyoc/sp/sql-{time.time_ns()}.log'
    subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-e', f"SET GLOBAL general_log_file='{path}'; SET GLOBAL general_log=1;"])
    out = fn()
    subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-e', 'SET GLOBAL general_log=0;'])
    lines = [l.split('Query\t', 1)[1].strip() for l in open(path, errors='ignore') if 'Query\t' in l and 'general_log' not in l]
    os.remove(path)
    writes = [l for l in lines if l.split(' ', 1)[0].upper() in ('INSERT', 'UPDATE', 'DELETE', 'REPLACE')]
    return out, {'total': len(lines), 'writes': len(writes), 'write_statements': [w[:70] for w in writes]}

ali = login(MAJOR, BASE, 'ali@example.test', 'Test12345!')
_, ctx_cost = logged(lambda: context(MAJOR, BASE, ali))
assertion = context(MAJOR, BASE, ali)[2]['assertion']
p = json.loads(base64.urlsafe_b64decode(assertion.split('.')[0] + '==='))
cust = {'id': p['external_customer_id'], 'session_ref': p['session_ref']}
report = {'widget_context_endpoint': ctx_cost}
for name, op, body in [
    ('health', 'health', {}),
    ('search (guest)', 'products/search', {'terms': ['mac'], 'page_size': 5}),
    ('product details x1', 'products/get', {'ids': [42]}),
    ('product details x5', 'products/get', {'ids': [40, 41, 42, 43, 44]}),
    ('reviews', 'products/reviews', {'product_id': 42}),
    ('orders list', 'orders/list', {'customer': cust}),
    ('order details', 'orders/get', {'customer': cust, 'order_id': 5001}),
    ('tracking', 'orders/tracking', {'customer': cust, 'order_id': 5001}),
]:
    (st, js, _), cost = logged(lambda: call(BASE, MAJOR, '0', INST, SECRET, op, {'store_id': '0', **body}))
    ext = js.get('_meta', {}).get('db', {}) if isinstance(js, dict) else {}
    report[name] = {'status': st, 'all_sql': cost['total'], 'all_writes': cost['writes'], 'extension_queries': ext.get('queries'), 'extension_writes': ext.get('writes'), 'write_statements': cost['write_statements']}
print(json.dumps(report, indent=1))
