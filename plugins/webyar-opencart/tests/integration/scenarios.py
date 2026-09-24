#!/usr/bin/env python3
"""
Acceptance scenarios against a REAL OpenCart install with the extension
installed through OpenCart's own installer (see run.sh). Real HTTP, real
storefront sessions, real database — nothing here is mocked.

    scenarios.py <4|3> <store0_base> <store1_base> <db>

Exit code 0 only when every check passes. Writes a JSON summary to stdout.
"""
import base64, hashlib, hmac, json, subprocess, sys, time

from client import call
from storefront import context, login, logout

MAJOR, BASE0, BASE1, DB = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
INST0, SECRET0 = '11111111-1111-4111-8111-111111111111', f'test-secret-oc{MAJOR}-store0-aaaaaaaaaaaaaaaaaaaa'
INST1, SECRET1 = '22222222-2222-4222-8222-222222222222', f'test-secret-oc{MAJOR}-store1-bbbbbbbbbbbbbbbbbbbb'

results = []


def check(name, ok, detail=None):
    results.append({'scenario': name, 'ok': bool(ok), **({'detail': detail} if detail is not None and not ok else {})})


def sql(query):
    subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '--default-character-set=utf8mb4', '-uroot', DB, '-e', query], check=True)
    subprocess.run(f'rm -f /tmp/wyoc/sp/sites/oc{MAJOR}/system/storage/cache/cache.*', shell=True)


def api(op, body=None, store='0', base=None, inst=INST0, secret=SECRET0, **kw):
    body = dict(body or {})
    body.setdefault('store_id', store)
    return call(base or BASE0, MAJOR, store, inst, secret, op, body, **kw)


def ref_from(assertion):
    payload = json.loads(base64.urlsafe_b64decode(assertion.split('.')[0] + '==='))
    return {'id': payload['external_customer_id'], 'session_ref': payload['session_ref']}, payload


# ── signature, replay, schema ───────────────────────────────────────────
st, js, nonce = api('health')
check('health_signed_ok', st == 200 and js.get('platform') == 'opencart', js)
st, js, _ = api('health', nonce=nonce)
check('replayed_nonce_rejected', st == 401 and js.get('error') == 'replay', js)
st, js, _ = api('health', ts=int(time.time()) - 3600)
check('expired_timestamp_rejected', st == 401 and js.get('error') == 'clock_skew', js)
st, js, _ = api('health', secret='wrong-secret')
check('forged_signature_rejected', st == 401 and js.get('error') == 'bad_signature', js)
st, js, _ = api('health', inst='99999999-9999-4999-8999-999999999999')
check('unknown_installation_rejected', st == 401 and js.get('error') == 'unknown_installation', js)
st, js, _ = api('does/not/exist')
check('unknown_operation_rejected', st == 404, js)
st, js, _ = api('health', method='GET')
check('get_rejected', st == 405, js)
st, js, _ = api('products/search', {'store_id': '1', 'terms': ['mac']})
check('body_store_mismatch_rejected', st == 403 and js.get('error') == 'store_mismatch', js)
st, js, _ = api('products/search', {'terms': ['mac']}, store='1', base=BASE1)
check('store0_credential_refused_on_store1', st in (401, 403) and js.get('error') in ('not_connected', 'unknown_installation'), js)

# ── public catalogue ────────────────────────────────────────────────────
st, js, _ = api('products/search', {'terms': ['iphone'], 'page_size': 3})
p = (js.get('products') or [{}])[0]
check('guest_search_finds_product', st == 200 and p.get('id') == '40', js)
check('guest_search_one_catalogue_query', js.get('_meta', {}).get('db', {}).get('reads', 99) <= 2, js.get('_meta'))
check('guest_sees_public_price_and_special', 'price' in p and 'special' in p, p)
st, js, _ = api('products/search', {'terms': ['phones']})
check('a_category_name_finds_its_products', st == 200 and [x['id'] for x in js.get('products', [])] == ['40'] and js.get('_meta', {}).get('db', {}).get('reads', 99) <= 2, js)
st, js, _ = api('products/get', {'ids': [28, 29, 33, 40]})
check('disabled_future_and_other_store_hidden', st == 200 and sorted(js.get('not_found', [])) == [28, 29, 33] and [x['id'] for x in js['products']] == ['40'], js)
check('get_is_not_n_plus_one', js.get('_meta', {}).get('db', {}).get('reads', 99) <= 4, js.get('_meta'))
st, js, _ = api('products/search', {'page_size': 2, 'page': 1})
page1 = [x['id'] for x in js.get('products', [])]
st2, js2, _ = api('products/search', {'page_size': 2, 'page': 2})
page2 = [x['id'] for x in js2.get('products', [])]
check('pagination_disjoint_pages', js.get('has_more') is True and page1 and page2 and not set(page1) & set(page2), [page1, page2])
st, js, _ = api('products/search', {'page_size': 50})
check('page_size_capped', len(js.get('products', [])) <= 10 and js.get('page_size') == 10, js.get('page_size'))
st, js, _ = api('products/search', {'terms': ['آیفون'], 'language': 'fa', 'currency': 'IRT'})
p = (js.get('products') or [{}])[0]
check('persian_language_and_toman', p.get('id') == '40' and 'تومان' in p.get('price', {}).get('formatted', '') and js['context']['language'] == 'fa-ir', js)
st, js, _ = api('products/search', {'terms': ['iphone'], 'language': 'tr'})
check('unknown_language_falls_back_to_store_default', js.get('context', {}).get('language') == 'en-gb', js.get('context'))
st, js, _ = api('products/get', {'ids': [42]})
p = (js.get('products') or [{}])[0]
opt_names = [o['name'] for o in p.get('options', [])]
check('options_from_real_structure', 'Select' in opt_names and any(o['required'] for o in p.get('options', [])), opt_names)
check('option_quantities_not_exposed', all('quantity' not in v for o in p.get('options', []) for v in o['values']), None)
check('quantity_discounts_from_store_model', len(p.get('quantity_discounts', [])) == 3, p.get('quantity_discounts'))
check('minimum_quantity_reported', p.get('minimum') == 2, p.get('minimum'))
st, js, _ = api('products/reviews', {'product_id': 42})
check('only_approved_reviews', js.get('review_count') == 1 and [r['author'] for r in js.get('reviews', [])] == ['Sara'], js)
check('review_markup_stripped', '<b>' not in json.dumps(js), None)
check('review_has_no_customer_fields', all(set(r) == {'author', 'rating', 'text', 'date'} for r in js.get('reviews', [])), js.get('reviews'))
st, js, _ = api('products/reviews', {'product_id': 28})
check('reviews_of_hidden_product_refused', st == 404, js)
# time-limited special: 41's special expired, 40's active
st, js, _ = api('products/get', {'ids': [40, 41]})
by = {x['id']: x for x in js.get('products', [])}
check('expired_special_not_applied', 'special' not in by.get('41', {}), by.get('41'))
check('active_special_with_end_date', by.get('40', {}).get('special_ends', '').startswith('2099-12-31'), by.get('40'))
# out of stock + stock_checkout
sql("UPDATE oc_product SET quantity = 0 WHERE product_id = 43")
st, js, _ = api('products/get', {'ids': [43]})
check('out_of_stock_state', js['products'][0]['stock']['state'] == 'out_of_stock', js['products'][0]['stock'])
sql("UPDATE oc_setting SET value = '1' WHERE `key` = 'config_stock_checkout' AND store_id = 0")
st, js, _ = api('products/get', {'ids': [43]})
check('backorder_when_store_allows_checkout', js['products'][0]['stock']['state'] == 'backorder', js['products'][0]['stock'])
sql("UPDATE oc_setting SET value = '0' WHERE `key` = 'config_stock_checkout' AND store_id = 0; UPDATE oc_product SET quantity = 3 WHERE product_id = 43")
st, js, _ = api('products/get', {'ids': [43]})
check('stock_quantity_hidden_when_store_hides_it', 'quantity' not in js['products'][0]['stock'], js['products'][0]['stock'])
sql("UPDATE oc_setting SET value = '1' WHERE `key` = 'config_stock_display' AND store_id = 0")
st, js, _ = api('products/get', {'ids': [43]})
check('stock_quantity_shown_when_store_shows_it', js['products'][0]['stock'].get('quantity') == 3, js['products'][0]['stock'])
sql("UPDATE oc_setting SET value = '0' WHERE `key` = 'config_stock_display' AND store_id = 0")
# prices hidden for guests
sql("UPDATE oc_setting SET value = '1' WHERE `key` = 'config_customer_price' AND store_id = 0")
st, js, _ = api('products/search', {'terms': ['iphone']})
p = (js.get('products') or [{}])[0]
check('guest_price_hidden_when_login_required', 'price' not in p and p.get('price_hidden') == 'login_required', p)
st, js, _ = api('products/search', {'terms': ['iphone'], 'max_price': 50})
check('price_filter_refused_when_prices_hidden', any('prices_hidden' in u for u in js.get('unsupported_filters', [])), js.get('unsupported_filters'))
sql("UPDATE oc_setting SET value = '0' WHERE `key` = 'config_customer_price' AND store_id = 0")

# ── identity ───────────────────────────────────────────────────────────
ali = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
code, cache, body = context(MAJOR, BASE0, ali)
check('context_not_cacheable', 'no-store' in (cache or ''), cache)
ali_ref, payload = ref_from(body['assertion'])
check('assertion_has_no_session_id_in_clear', 'session' not in json.dumps({k: v for k, v in payload.items() if k != 'session_ref'}), payload)
check('assertion_short_lived', payload['expires_at'] - payload['issued_at'] <= 120, payload)
sig_ok = hmac.new(SECRET0.encode(), body['assertion'].split('.')[0].encode(), hashlib.sha256).hexdigest() == body['assertion'].split('.')[1]
check('assertion_signed_with_installation_secret', sig_ok, None)
code, _, body2 = context(MAJOR, BASE0, ali, headers={'Sec-Fetch-Site': 'cross-site'})
check('cross_site_context_refused', code == 403, body2)

st, js, _ = api('orders/list', {'customer': ali_ref})
ids = [o['id'] for o in js.get('orders', [])]
check('customer_sees_own_orders_only_this_store', st == 200 and ids == ['5002', '5001'], js)
statuses = {o['id']: o['status'] for o in js.get('orders', [])}
check('custom_status_not_misread', statuses.get('5002', {}).get('category') == 'other' and statuses.get('5002', {}).get('name') == 'Packed for courier', statuses)
check('complete_status_from_store_settings', statuses.get('5001', {}).get('category') == 'complete', statuses)
st, js, _ = api('orders/get', {'customer': ali_ref, 'order_id': 5001})
o = js.get('order', {})
dump = json.dumps(js)
check('order_details', st == 200 and len(o.get('items', [])) == 2 and o.get('payment_status') == 'not_reported_by_store', js)
check('internal_comment_hidden', 'INTERNAL' not in dump and any(h['comment'] == 'Delivered to courier' for h in o.get('history', [])), o.get('history'))
check('no_pii_or_affiliate_tracking', all(x not in dump for x in ['Secret street', 'ali@example.test', '0912', '10.1.2.3', 'AFFILIATE-CODE']), None)
check('order_view_link', 'order' in (o.get('view_url') or ''), o.get('view_url'))
st, js, _ = api('orders/get', {'customer': ali_ref, 'order_id': 5002})
check('order_in_own_currency', js.get('order', {}).get('total', {}).get('currency') == 'EUR', js.get('order', {}).get('total'))
for other, why in [(5005, 'another_customer'), (5003, 'another_store'), (5004, 'missing_status'), (999999, 'nonexistent')]:
    st, js, _ = api('orders/get', {'customer': ali_ref, 'order_id': other})
    check(f'order_id_tampering_{why}', st == 404 and js.get('error') == 'order_not_found', js)
st, js, _ = api('orders/get', {'customer': {'id': '102', 'session_ref': ali_ref['session_ref']}, 'order_id': 5005})
check('customer_id_swap_rejected', st == 401 and js.get('error') == 'identity_invalid', js)
st, js, _ = api('orders/get', {'customer': {'id': '101'}, 'order_id': 5001})
check('missing_session_ref_rejected', st == 401, js)
st, js, _ = api('orders/tracking', {'customer': ali_ref, 'order_id': 5001})
check('no_tracking_extension_no_fake_data', st == 200 and js.get('available') is False and js.get('reason') == 'no_tracking_source' and js.get('shipments') == [], js)
st, js, _ = api('orders/returns', {'customer': ali_ref})
check('customer_returns', st == 200 and [r['order_id'] for r in js.get('returns', [])] == ['5001'] and 'secret reason' not in json.dumps(js), js)
st, js, _ = api('orders/list', {})
check('orders_without_identity_refused', st == 401 and js.get('error') == 'identity_required', js)
# group pricing for the signed-in wholesale customer — no leak to guests
bita = login(MAJOR, BASE0, 'bita@example.test', 'Test12345!')
bita_ref, _ = ref_from(context(MAJOR, BASE0, bita)[2]['assertion'])
st, js, _ = api('products/get', {'ids': [40], 'customer': bita_ref})
wholesale = js['products'][0]
st, js, _ = api('products/get', {'ids': [40]})
guest = js['products'][0]
check('customer_group_price_applied', wholesale['price']['amount'] != guest['price']['amount'] and js['context']['customer_group_id'] == 1, [wholesale.get('price'), guest.get('price')])
check('guest_does_not_get_group_price', guest['price']['formatted'] != wholesale['price']['formatted'], None)
# logout / session end / other customer in same browser
logout(MAJOR, BASE0, ali)
st, js, _ = api('orders/list', {'customer': ali_ref})
check('logout_revokes_access', st == 401 and js.get('error') == 'identity_session_ended', js)
ali2 = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
ali2_ref, _ = ref_from(context(MAJOR, BASE0, ali2)[2]['assertion'])
logout(MAJOR, BASE0, ali2)
code, _, body = context(MAJOR, BASE0, ali2)
check('context_after_logout_is_guest', body.get('assertion') is None, body)
# another customer signs in in the SAME browser session
switch = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
ali3_ref, _ = ref_from(context(MAJOR, BASE0, switch)[2]['assertion'])
logout(MAJOR, BASE0, switch)
switch.post  # same cookie jar
bita_again = login(MAJOR, BASE0, 'bita@example.test', 'Test12345!')
st, js, _ = api('orders/list', {'customer': ali3_ref})
check('previous_customer_ref_dead_after_switch', st == 401, js)
# session expiry
ali4 = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
ali4_ref, _ = ref_from(context(MAJOR, BASE0, ali4)[2]['assertion'])
sql("UPDATE oc_session SET expire = '2000-01-01 00:00:00' WHERE data REGEXP 'customer_id.{1,3}101[^0-9]'")
st, js, _ = api('orders/list', {'customer': ali4_ref})
check('session_expiry_revokes_access', st == 401 and js.get('error') == 'identity_session_ended', js)
# disabled account
ali5 = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
ali5_ref, _ = ref_from(context(MAJOR, BASE0, ali5)[2]['assertion'])
sql("UPDATE oc_customer SET status = 0 WHERE customer_id = 101")
st, js, _ = api('orders/list', {'customer': ali5_ref})
check('disabled_account_revokes_access', st in (401, 403), js)
sql("UPDATE oc_customer SET status = 1 WHERE customer_id = 101")
# stale public reference falls back to guest pricing, not an error
st, js, _ = api('products/search', {'terms': ['iphone'], 'customer': ali_ref})
check('stale_customer_ref_public_read_is_guest', st == 200 and js['context']['customer'] is False, js.get('context'))
# merchant switched order access off
ali6 = login(MAJOR, BASE0, 'ali@example.test', 'Test12345!')
ali6_ref, _ = ref_from(context(MAJOR, BASE0, ali6)[2]['assertion'])
sql("UPDATE oc_setting SET value = '0' WHERE `key` = 'module_webyar_orders' AND store_id = 0")
st, js, _ = api('orders/list', {'customer': ali6_ref})
check('merchant_toggle_blocks_orders', st == 403 and js.get('error') == 'disabled_by_store', js)
st, js, _ = api('health')
check('health_drops_order_capabilities_when_off', 'orders.read' not in js.get('capabilities', []), js.get('capabilities'))
sql("UPDATE oc_setting SET value = '1' WHERE `key` = 'module_webyar_orders' AND store_id = 0")
# store 1: separate installation, separate data
st, js, _ = api('products/get', {'ids': [33, 42]}, store='1', base=BASE1, inst=INST1, secret=SECRET1)
check('store1_sees_only_its_products', [x['id'] for x in js.get('products', [])] == ['33'], js)
st, js, _ = api('orders/list', {'customer': ali6_ref}, store='1', base=BASE1, inst=INST1, secret=SECRET1)
check('store0_session_ref_useless_on_store1', st == 401, js)

failed = [r for r in results if not r['ok']]
print(json.dumps({'opencart': MAJOR, 'passed': len(results) - len(failed), 'failed': len(failed), 'results': results}, ensure_ascii=False, indent=1))
sys.exit(1 if failed else 0)
