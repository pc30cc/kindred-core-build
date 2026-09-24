<?php

namespace WebYar\Whmcs;

/**
 * Shaping untrusted text before it leaves WHMCS: markup stripped, control
 * characters removed, whitespace collapsed, length bounded. Web Yar sanitizes
 * again on arrival; this keeps payloads small and removes obvious markup at
 * the source.
 */
final class Text
{
    public static function clean($value, $max)
    {
        if ($value === null) {
            return null;
        }
        $text = html_entity_decode(strip_tags((string) $value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text);
        $text = trim(preg_replace('/\s+/u', ' ', (string) $text));
        if ($text === '') {
            return null;
        }
        if (function_exists('mb_strlen') && mb_strlen($text, 'UTF-8') > $max) {
            return mb_substr($text, 0, $max, 'UTF-8') . '…';
        }
        if (!function_exists('mb_strlen') && strlen($text) > $max) {
            return substr($text, 0, $max) . '…';
        }
        return $text;
    }

    /** A WHMCS DATE/DATETIME, or null for its "no date" 0000-00-00. */
    public static function date($value)
    {
        $value = (string) $value;
        if ($value === '' || strpos($value, '0000-00-00') === 0) {
            return null;
        }
        return preg_match('/^\d{4}-\d{2}-\d{2}/', $value) ? $value : null;
    }

    /**
     * MySQL returns DECIMAL columns as strings ("99.00") and they are passed
     * on exactly as stored. A driver that returns a PHP number instead is
     * formatted to two decimals rather than guessed at.
     */
    public static function amount($value)
    {
        if ($value === null) {
            return null;
        }
        $string = is_int($value) || is_float($value) ? number_format((float) $value, 2, '.', '') : trim((string) $value);
        return preg_match('/^-?\d+(\.\d+)?$/', $string) ? $string : null;
    }

    public static function today()
    {
        // WHMCS stores dates in its own configured timezone, which is PHP's default here.
        return date('Y-m-d', Platform::now());
    }
}
