package com.webyar.ai.core

import com.webyar.ai.BuildConfig
import com.webyar.ai.i18n.Language
import java.net.URI

/**
 * The brand this build wears, fixed at build time by its product flavor
 * (`webyar` or `respok` in app/build.gradle.kts). One source makes two apps
 * that live side by side on one phone: WebYar for webyar.ai and RESPOK for
 * respok.app, each with its own package, name, icons, server and data. The
 * Mac app (macos/Webyar/Core/Config/AppBrand.swift), the iOS app and the
 * Windows app (`Brand.cs`) make the same split.
 *
 * The copy that names the product is [com.webyar.ai.i18n.BrandStr]; the
 * brand's art is its resources (`src/main/res` for WebYar, `src/respok/res`
 * for RESPOK).
 *
 * WebYar's values are the ones the app shipped with before RESPOK existed.
 * Its storage names (the DataStore, the Keystore alias, the cache database,
 * the notification channels) are not here at all: they are the same in both
 * apps, which is safe because each app has its own sandbox, and renaming
 * them would sign every WebYar operator out.
 */
object AppBrand {
    /** `webyar` or `respok`. */
    const val id: String = BuildConfig.BRAND_ID

    /** The product's name in identifiers and logs. The sentences that name it are `BrandStr`. */
    const val name: String = BuildConfig.BRAND_NAME

    /** The API a fresh install makes its first request to; the platform can move it later (/api/platform/origins). */
    const val apiOrigin: String = BuildConfig.API_BASE_URL

    /**
     * Persian dates in the Persian (Jalali) calendar. Not for RESPOK: in the
     * International edition Persian is only right-to-left text, so its dates
     * are Gregorian in Persian digits (`fa-IR-u-ca-gregory`), as in RESPOK's
     * desktop apps.
     */
    const val jalaliDates: Boolean = BuildConfig.JALALI_DATES

    /** The realtime (Centrifugo) client name. Informational: the server does not check it. */
    const val realtimeName: String = BuildConfig.REALTIME_CLIENT_NAME

    const val RESPOK = "respok"

    val isRespok: Boolean get() = id == RESPOK

    /**
     * The language a first launch starts in, before Super Admin or the
     * operator names one: Persian for WebYar, English for RESPOK (the
     * International edition, where Persian is a language to pick, never the
     * default).
     *
     * A getter, not a stored value, so that reading it from inside
     * `Language`'s own initialisation cannot meet a half-built `AppBrand`.
     */
    val fallbackLanguage: Language get() = Language.from(BuildConfig.DEFAULT_LANGUAGE) ?: Language.EN

    /**
     * The signature at the foot of the launch, sign-in and reset screens
     * (`BrandFooter`), and what follows it: WebYar's "WEBYAR" + "AI",
     * RESPOK's name alone.
     */
    val wordmark: String get() = if (isRespok) "RESPOK" else "WEBYAR"
    val wordmarkSuffix: String? get() = if (isRespok) null else "AI"

    /** Whether this build may talk to [url]'s host. See [accepts] with a brand. */
    fun accepts(url: String): Boolean = accepts(id, url)

    /**
     * Whether a build of [brand] may talk to the host in [url]: an API
     * origin the platform names (`PlatformOrigin`, `ApiClient.refreshOrigin`).
     *
     * WebYar takes any (https is checked where each is read, as before).
     * RESPOK takes only its own domain, respok.app and its subdomains: a
     * RESPOK database cloned from WebYar's that still names one of WebYar's
     * hosts — webyar.ai, or an older one that does not even say "webyar" —
     * would otherwise move every RESPOK phone onto WebYar's servers, for good.
     * An allow-list, so no host WebYar ever had can slip through by name.
     */
    fun accepts(brand: String, url: String): Boolean {
        if (brand != RESPOK) return true
        val host = runCatching { URI(url.trim()).host }.getOrNull()?.lowercase()?.trimEnd('.')
        if (host.isNullOrEmpty()) return false
        return host == RESPOK_DOMAIN || host.endsWith(".$RESPOK_DOMAIN")
    }

    /** RESPOK's own domain: the only one a RESPOK build adopts an API origin on. */
    const val RESPOK_DOMAIN = "respok.app"
}
