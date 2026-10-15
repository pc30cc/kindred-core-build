package com.platform.app.core

import com.platform.app.BuildConfig
import com.platform.app.i18n.Language
import java.net.URI

/**
 * The brand this build wears, fixed at build time by its product flavor
 * (the two `productFlavors` in app/build.gradle.kts). One source makes two
 * apps that live side by side on one phone: the Iranian edition and RESPOK
 * (the International edition, respok.app), each with its own package, name,
 * icons, server and data. The Mac app, the iOS app and the Windows app
 * (`Brand.cs`) make the same split.
 *
 * This file, like everything in `src/main`, names neither brand: what
 * differs is in the flavor blocks (read here through `BuildConfig`) and in
 * each flavor's own source set — the copy that names the product
 * ([com.platform.app.i18n.BrandStr], whose words are each flavor's
 * `BrandCopy`), the art (`src/<flavor>/res`) and the launcher entry
 * (`src/<flavor>/AndroidManifest.xml`). RESPOK's APK is checked for the
 * other brand's name by `tools/check-brand-neutral.sh`.
 *
 * The Iranian edition's values are the ones the app shipped with before
 * RESPOK existed, and that includes the names it keeps on the phone
 * ([storeName], [keyAlias], [cacheDatabase], [pushPrefs], [promoPrefs], the
 * notification channels and the call actions): renaming one would sign every
 * operator out, drop their cache or leave their notification settings behind.
 */
object AppBrand {
    /** The flavor's id: `respok`, or the Iranian edition's. */
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
     * operator names one: Persian for the Iranian edition, English for
     * RESPOK (the International edition, where Persian is a language to pick,
     * never the default).
     *
     * A getter, not a stored value, so that reading it from inside
     * `Language`'s own initialisation cannot meet a half-built `AppBrand`.
     */
    val fallbackLanguage: Language get() = Language.from(BuildConfig.DEFAULT_LANGUAGE) ?: Language.EN

    /**
     * The signature at the foot of the launch, sign-in and reset screens
     * (`BrandFooter`), and what follows it, if anything: the Iranian
     * edition's name and "AI", RESPOK's name alone.
     */
    const val wordmark: String = BuildConfig.WORDMARK
    val wordmarkSuffix: String? get() = BuildConfig.WORDMARK_SUFFIX.ifEmpty { null }

    // What the app keeps on the phone, by name. Each flavor sets its own
    // (app/build.gradle.kts); an installed app finds its data under these, so
    // a flavor's values never change once it has shipped.

    /** The DataStore holding the session token (encrypted), the language and the stored API origin. */
    const val storeName: String = BuildConfig.STORE_NAME

    /** The Android Keystore alias of the key that encrypts the session token. */
    const val keyAlias: String = BuildConfig.KEY_ALIAS

    /** The Room cache's database file. */
    const val cacheDatabase: String = BuildConfig.CACHE_DATABASE

    /** The preferences file holding the Firebase client Super Admin named. */
    const val pushPrefs: String = BuildConfig.PUSH_PREFS

    /** The preferences file holding the promotions' pacing counters. */
    const val promoPrefs: String = BuildConfig.PROMO_PREFS

    /** The notification channel for messages: the id the server names in every push (and the manifest's default). */
    const val messagesChannel: String = BuildConfig.CHANNEL_MESSAGES

    /** The notification channel a ringing call is posted in. */
    const val callsChannel: String = BuildConfig.CHANNEL_CALLS

    /** The prefix of the actions a ringing call's notification sends (`<prefix>.ANSWER`, …). */
    const val callActionPrefix: String = BuildConfig.CALL_ACTION_PREFIX

    /** Whether this build may talk to [url]'s host. See [accepts] with a brand. */
    fun accepts(url: String): Boolean = accepts(id, url)

    /**
     * Whether a build of [brand] may talk to the host in [url]: an API
     * origin the platform names (`PlatformOrigin`, `ApiClient.refreshOrigin`).
     *
     * The Iranian edition takes any (https is checked where each is read, as
     * before). RESPOK takes only its own domain, respok.app and its
     * subdomains: a RESPOK database cloned from the Iranian edition's that
     * still names one of that edition's hosts (or an older one that does not
     * even carry its name) would otherwise move every RESPOK phone onto the
     * other edition's servers, for good. An allow-list, so no host the other
     * edition ever had can slip through by name.
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
