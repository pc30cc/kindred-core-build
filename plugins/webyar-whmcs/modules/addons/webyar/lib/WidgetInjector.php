<?php

namespace WebYar\Whmcs;

/**
 * Injects the EXISTING Web Yar loader (the same contract the WooCommerce
 * plugin and the Settings → Integrations snippet use: window.__gs_id /
 * data-workspace-id and window.__gs_api_base / data-api-base) — never a
 * second chat UI.
 *
 *   - client area only (ClientAreaFooterOutput); never in the admin area;
 *   - never twice: honours the loader's own singleton flags, so a merchant
 *     who also pasted the snippet into footer.tpl still gets one widget;
 *   - zero network calls to Web Yar during the page render;
 *   - guests get the widget with no identity attributes at all;
 *   - a logged-in page gets a 5-minute signed assertion, and the response is
 *     marked private/no-store so no shared cache can hand it to someone else;
 *   - an administrator using "Login as Client" is NOT introduced as the
 *     customer (WHMCS reports it as isMasqueradingAdmin()).
 */
final class WidgetInjector
{
    /** @param array<string,mixed> $vars ClientAreaFooterOutput parameters */
    public static function render(array $vars)
    {
        if (defined('ADMINAREA') || !Settings::autoWidget()) {
            return '';
        }
        $credential = Settings::credential();
        $appUrl = Settings::appUrl();
        $apiUrl = Settings::apiUrl();
        if ($credential === null || $appUrl === '' || $apiUrl === '') {
            return '';
        }

        $attributes = array(
            'data-workspace-id' => $credential['workspace_id'],
            'data-api-base' => $apiUrl,
            'data-asset-base' => $appUrl,
            'data-commerce-subject' => 'anon',
        );

        $identity = self::identity($credential);
        if ($identity !== null) {
            $attributes['data-commerce-assertion'] = $identity['assertion'];
            $attributes['data-commerce-subject'] = 'u' . $identity['subject'];
            $attributes['data-commerce-binding'] = $identity['binding'];
            if ($credential['connection_id'] !== '') {
                $attributes['data-commerce-connection'] = $credential['connection_id'];
            }
            if (!headers_sent()) {
                header('Cache-Control: private, no-store, max-age=0');
            }
        }

        return self::script($appUrl . '/widget/loader.js', $credential['workspace_id'], $apiUrl, $attributes);
    }

    /** @return array{assertion:string,subject:string,binding:string}|null */
    private static function identity(array $credential)
    {
        if (!class_exists('\WHMCS\Authentication\CurrentUser')) {
            return null;
        }
        try {
            $current = new \WHMCS\Authentication\CurrentUser();
            if (!$current->isAuthenticatedUser() || $current->isMasqueradingAdmin()) {
                return null;
            }
            $user = $current->user();
            $client = $current->client();
        } catch (\Exception $e) {
            return null;
        }
        if (!$user || !$client) {
            return null;
        }
        $grantId = Grants::ensureForSession($user->id, $client->id, $credential['secret']);
        if ($grantId === null) {
            return null;
        }
        $name = isset($user->fullName) ? $user->fullName : null;
        $email = isset($user->email) ? $user->email : null;
        return array(
            'assertion' => Identity::issue($credential, $grantId, $user->id, $client->id, $name, $email),
            'subject' => Identity::subject($credential['secret'], $user->id),
            'binding' => Identity::binding($credential['secret'], $grantId),
        );
    }

    /** @param array<string,string> $attributes */
    public static function script($loaderUrl, $workspaceId, $apiUrl, array $attributes)
    {
        $flags = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES;
        $lines = array();
        foreach ($attributes as $name => $value) {
            $lines[] = 's.setAttribute(' . json_encode($name, $flags) . ', ' . json_encode((string) $value, $flags) . ');';
        }
        return '<script>(function(){'
            . 'if(window.__gs_loaded||window.__gs_loader_injected){return;}'
            . 'if(document.getElementById("gs-widget-loader")){return;}'
            . 'window.__gs_loader_injected=true;window.__gs=window.__gs||[];'
            . 'window.__gs_id=' . json_encode((string) $workspaceId, $flags) . ';'
            . 'window.__gs_api_base=' . json_encode((string) $apiUrl, $flags) . ';'
            . 'var s=document.createElement("script");s.id="gs-widget-loader";'
            . 's.src=' . json_encode((string) $loaderUrl, $flags) . ';'
            . implode('', $lines)
            . 's.async=true;document.head.appendChild(s);'
            . '})();</script>';
    }
}
