<?php

namespace WebYar\Whmcs;

use WHMCS\Database\Capsule;

/**
 * Addon settings in the addon's own table. The installation credential is
 * the one sensitive value: it is stored encrypted through WHMCS's
 * EncryptPassword (the same mechanism WHMCS uses for module passwords), read
 * at most once per request, never rendered, never logged.
 */
final class Settings
{
    const SECTIONS = array('catalog', 'services', 'domains', 'invoices', 'orders', 'tickets');

    /** @var array<string,string|null>|null per-request memo of the whole (tiny) table */
    private static $memo = null;
    /** @var array<string,string>|null|false */
    private static $credential = false;

    /**
     * One SELECT per request loads every setting (a dozen short rows), so a
     * page render or an API call never pays one query per key.
     *
     * @return string|null
     */
    public static function get($name)
    {
        if (self::$memo === null) {
            self::$memo = array();
            try {
                foreach (Capsule::table('mod_webyar_settings')->get(array('name', 'value')) as $row) {
                    self::$memo[(string) $row->name] = $row->value === null ? null : (string) $row->value;
                }
            } catch (\Exception $e) {
                // Not installed yet: every setting reads as absent.
            }
        }
        return array_key_exists($name, self::$memo) ? self::$memo[$name] : null;
    }

    public static function set($name, $value)
    {
        self::get($name);
        self::$memo[$name] = $value === null ? null : (string) $value;
        if ($name === 'credential') {
            self::$credential = false;
        }
        $exists = Capsule::table('mod_webyar_settings')->where('name', $name)->exists();
        if ($exists) {
            Capsule::table('mod_webyar_settings')->where('name', $name)->update(array('value' => $value));
        } else {
            Capsule::table('mod_webyar_settings')->insert(array('name' => $name, 'value' => $value));
        }
    }

    public static function delete($name)
    {
        self::get($name);
        unset(self::$memo[$name]);
        if ($name === 'credential') {
            self::$credential = false;
        }
        Capsule::table('mod_webyar_settings')->where('name', $name)->delete();
    }

    public static function resetMemo()
    {
        self::$memo = null;
        self::$credential = false;
    }

    /**
     * @return array{installation_id:string,secret:string,workspace_id:string,connection_id:string}|null
     */
    public static function credential()
    {
        if (self::$credential !== false) {
            return self::$credential;
        }
        self::$credential = null;
        $cipher = self::get('credential');
        if ($cipher === null || $cipher === '') {
            return null;
        }
        $plain = Platform::decrypt($cipher);
        // WHMCS localAPI may HTML-escape JSON before EncryptPassword sees it.
        // Encode new payloads as an ASCII envelope before encryption, and
        // continue reading credentials stored by earlier addon versions.
        if (is_string($plain) && strpos($plain, 'webyar-json-v1:') === 0) {
            $decoded = base64_decode(substr($plain, strlen('webyar-json-v1:')), true);
            $data = $decoded !== false ? json_decode($decoded, true) : null;
        } else {
            $data = $plain !== null ? json_decode($plain, true) : null;
            if (!is_array($data) && is_string($plain)) {
                $data = json_decode(html_entity_decode($plain, ENT_QUOTES, 'UTF-8'), true);
            }
        }
        if (!is_array($data) || empty($data['installation_id']) || empty($data['secret']) || empty($data['workspace_id'])) {
            return null;
        }
        self::$credential = array(
            'installation_id' => (string) $data['installation_id'],
            'secret' => (string) $data['secret'],
            'workspace_id' => (string) $data['workspace_id'],
            'connection_id' => isset($data['connection_id']) ? (string) $data['connection_id'] : '',
        );
        return self::$credential;
    }

    public static function storeCredential(array $credential)
    {
        self::set('credential', Platform::encrypt('webyar-json-v1:' . base64_encode(json_encode(array(
            'installation_id' => (string) $credential['installation_id'],
            'secret' => (string) $credential['secret'],
            'workspace_id' => (string) $credential['workspace_id'],
            'connection_id' => isset($credential['connection_id']) ? (string) $credential['connection_id'] : '',
        )))));
    }

    public static function appUrl()
    {
        return rtrim((string) self::get('webyar_url'), '/');
    }

    /** API base; falls back to the app URL (the documented single-host deployment). */
    public static function apiUrl()
    {
        $api = rtrim((string) self::get('api_url'), '/');
        return $api !== '' ? $api : self::appUrl();
    }

    public static function flag($name, $default)
    {
        $value = self::get($name);
        if ($value === null) {
            return $default;
        }
        return $value === '1';
    }

    public static function autoWidget()
    {
        return self::flag('auto_widget', true);
    }

    public static function shareContact()
    {
        return self::flag('share_contact', true);
    }

    /** Sections the WHMCS administrator allows Web Yar to read at all (defence in depth). */
    public static function sectionEnabled($section)
    {
        return self::flag('section_' . $section, true);
    }
}
