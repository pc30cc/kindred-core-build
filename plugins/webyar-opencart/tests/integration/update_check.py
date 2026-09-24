#!/usr/bin/env python3
"""
TEST ONLY: self-update on a REAL OpenCart install, against a loopback
"Web Yar" that serves signed releases (run.sh points the store at it with
WEBYAR_APP_URL / WEBYAR_UPDATE_PUBLIC_KEY in config.php; the release key here
is a throwaway test key, never the production one).

    update_check.py <4|3> <base> <db> <site_dir> <release_dir> <release_url> <secret_key_b64> <installation> <secret>

Each fake release is the real package with only its version changed, so
"updated" means the store really downloaded, verified, unpacked and swapped
its own files. Paths exercised: Web Yar's signed `connector/update`, the
admin's "check for updates" button, the admin-visit fallback, and every
refusal (foreign signature, checksum mismatch, owner switched it off).
"""
import base64, hashlib, json, os, re, subprocess, sys, zipfile, io
import requests
import oc_admin
from oc_admin import Admin
from client import call

oc_admin.log = lambda *a, **k: None

MAJOR, BASE, DB, SITE, RELEASE, RELEASE_URL, SK, INST, SECRET = int(sys.argv[1]), sys.argv[2].rstrip('/'), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7], sys.argv[8], sys.argv[9]
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
REAL_ZIP = os.path.join(REPO, 'public', 'downloads', 'opencart', '4.1/webyar.ocmod.zip' if MAJOR == 4 else '3.0/webyar-oc3.ocmod.zip')
LINE = '4.1.x' if MAJOR == 4 else '3.0.5.x'
REL_PATH = '/downloads/opencart/' + ('4.1/webyar.ocmod.zip' if MAJOR == 4 else '3.0/webyar-oc3.ocmod.zip')
PROTOCOL_IN_ZIP = 'system/library/webyar/Protocol.php' if MAJOR == 4 else 'upload/system/library/webyar/Protocol.php'
PROTOCOL_ON_DISK = os.path.join(SITE, 'extension/webyar/system/library/webyar/Protocol.php' if MAJOR == 4 else 'system/library/webyar/Protocol.php')
results = []


def check(name, ok, detail=None):
    results.append({'check': name, 'ok': bool(ok), **({'detail': detail} if not ok else {})})


def q(sql):
    return subprocess.run(['mariadb', '--socket=/tmp/wyoc/my.sock', '-uroot', '-N', DB, '-e', sql], capture_output=True, text=True).stdout.strip()


def sign(body, sk=SK):
    return subprocess.run(['php', '-r', 'echo base64_encode(sodium_crypto_sign_detached(stream_get_contents(STDIN), base64_decode($argv[1])));', sk],
                          input=body, capture_output=True, check=True).stdout.decode()


def other_key():
    return subprocess.run(['php', '-r', 'echo base64_encode(sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair()));'], capture_output=True, check=True, text=True).stdout


def publish(version, sha_override=None, sk=SK):
    """Real package with only CONNECTOR_VERSION changed, plus a signed manifest."""
    src = zipfile.ZipFile(REAL_ZIP)
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            data = src.read(info)
            if info.filename == PROTOCOL_IN_ZIP:
                data = re.sub(rb"CONNECTOR_VERSION = '[^']+'", f"CONNECTOR_VERSION = '{version}'".encode(), data)
            z.writestr(info, data)
    pkg = out.getvalue()
    os.makedirs(os.path.dirname(RELEASE + REL_PATH), exist_ok=True)
    open(RELEASE + REL_PATH, 'wb').write(pkg)
    manifest = json.dumps({'slug': 'webyar-opencart', 'version': version, 'protocol': 'webyar-commerce/1', 'packages': [
        {'opencart': LINE, 'path': REL_PATH, 'sha256': sha_override or hashlib.sha256(pkg).hexdigest()}]}, indent=2).encode()
    open(RELEASE + '/downloads/opencart/manifest.json', 'wb').write(manifest)
    open(RELEASE + '/downloads/opencart/manifest.json.sig', 'w').write(sign(manifest, sk))


def disk_version():
    m = re.search(r"CONNECTOR_VERSION = '([^']+)'", open(PROTOCOL_ON_DISK).read())
    return m.group(1) if m else None


def api(op, body=None):
    return call(BASE, MAJOR, '0', INST, SECRET, op, {'store_id': '0', **(body or {})})[:2]


start = disk_version()
st, health = api('health')
check('health advertises self-update', st == 200 and 'connector.update' in health.get('capabilities', []) and health.get('auto_update') is True, health)
check('every answer says which version is running', health.get('_meta', {}).get('connector_version') == start, health.get('_meta'))

# 1. A release signed by someone else is never installed.
publish('9.9.0', sk=other_key())
st, res = api('connector/update')
check('foreign signature refused', st == 200 and res.get('status') == 'failed' and res.get('error') == 'signature_invalid', res)
check('nothing changed on disk after a refusal', disk_version() == start)

# 2. Checksum mismatch.
publish('9.9.0', sha_override='0' * 64)
st, res = api('connector/update')
check('checksum mismatch refused', res.get('status') == 'failed' and res.get('error') == 'package_checksum_mismatch', res)
check('still the old files', disk_version() == start)

# 3. Web Yar asks, the store updates itself.
publish('9.9.0')
st, res = api('connector/update')
check('Web Yar push: updated', st == 200 and res.get('status') == 'updated' and res.get('to') == '9.9.0', res)
check('new files on disk', disk_version() == '9.9.0', disk_version())
st, health = api('health')
check('the store now answers as the new version', health.get('connector_version') == '9.9.0' and health.get('_meta', {}).get('connector_version') == '9.9.0', health)
if MAJOR == 4:
    check('OpenCart knows the files (clean uninstall later)', q("SELECT COUNT(*) FROM oc_extension_path WHERE path='webyar/system/library/webyar/Updater.php'") == '1'
          and q("SELECT version FROM oc_extension_install WHERE code='webyar'") == '9.9.0')
leftovers = subprocess.run(['find', SITE, '-name', '*.webyar-*'], capture_output=True, text=True).stdout.strip()
check('no staged or backup files left behind', leftovers == '', leftovers)
st, res = api('connector/update')
check('asking again: up to date', res.get('status') == 'up_to_date', res)

# 4. The owner's switch is respected.
admin = Admin(MAJOR, BASE, 'admin', 'Admin12345!')
html, csrf = admin.page()
check('settings page renders on the updated code', csrf is not None and 'wy-hero' in html)
check('settings page shows the running version', '9.9.0' in html)
form = {'webyar_csrf': csrf, 'module_webyar_status': '1', 'module_webyar_orders': '1', 'module_webyar_reviews': '1',
        'module_webyar_customer_scope': 'installation', 'widget[0]': '1', 'widget[1]': '1'}
admin.post('save', {**form, 'module_webyar_auto_update': '0'})
publish('9.9.1')
st, res = api('connector/update')
check('switched off: Web Yar cannot trigger an update', st == 403 and res.get('error') == 'disabled_by_store', [st, res])
st, health = api('health')
check('switched off: capability withdrawn', 'connector.update' not in health.get('capabilities', []) and health.get('auto_update') is False, health)
check('switched off: still the same files', disk_version() == '9.9.0')
admin.post('save', {**form, 'module_webyar_auto_update': '1'})

# 5. "Check for updates" button in the admin.
res = admin.post('update', {'webyar_csrf': csrf})
check('admin button: updated', 'success' in res and 'updated=1' in res.get('redirect', ''), res)
check('admin button: new files', disk_version() == '9.9.1', disk_version())
res = admin.post('update', {'webyar_csrf': 'forged'})
check('admin button needs the form token', 'error' in res and 'success' not in res, res)

# 6. Fallback: the owner simply opens the settings page (last check long ago).
publish('9.9.2')
q("UPDATE oc_setting SET value=REPLACE(value, SUBSTRING_INDEX(SUBSTRING_INDEX(value, '\"checked_at\":', -1), ',', 1), '0') WHERE `key`='module_webyar_update_state' AND store_id=0")
page = admin.s.get(admin.url('extension/webyar/module/webyar' if MAJOR == 4 else 'extension/module/webyar'))
check('admin visit: updated and reloaded', disk_version() == '9.9.2' and 'updated=1' in page.url, [disk_version(), page.url])
check('admin visit: page shows the update notice', 'wy-updated' in page.text, None)

# 7. The shop keeps working on the new code.
store = requests.get(BASE + '/').text
check('storefront still has exactly one loader', store.count('s.id="gs-widget-loader"') == 1)
st, res = api('products/search', {'terms': ['mac'], 'page': 1, 'page_size': 5})
check('assistant reads still work after the update', st == 200 and isinstance(res.get('products'), list), [st, str(res)[:200]])

failed = [r for r in results if not r['ok']]
print(json.dumps({'opencart': MAJOR, 'passed': len(results) - len(failed), 'failed': len(failed), 'results': results}, indent=1))
sys.exit(1 if failed else 0)
