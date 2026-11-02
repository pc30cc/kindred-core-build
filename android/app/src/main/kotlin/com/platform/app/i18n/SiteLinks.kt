package com.platform.app.i18n

import com.platform.app.core.AppBrand
import java.net.URI

/**
 * The brand's own site, in the app's language (owner, 2026-11-01) — the iOS
 * app's `SiteLinks` (its Localization/SiteLinks.swift), rule
 * for rule.
 *
 * The site keeps Persian at its root and every other language under its
 * code: `https://<site>`, `/privacy`, `/terms` in Persian;
 * `https://<site>/en`, `/en/privacy`, `/en/terms` in English; `/tr/…` and
 * `/ar/…` likewise. The sign-in screen's website link opens those pages in
 * the language the app is showing (docs/operations/MOBILE_APP_PLAN.md, "The
 * sign-in screen's site address").
 *
 * The site's address is still Super Admin's: the root is taken from the
 * website link set for the app, or from the platform's canonical site
 * (`/api/platform/origins`, `canonicalBaseUrl`), so moving the site moves the
 * links. Only an https address is a root, and of it only its host (and port):
 * whatever path Super Admin typed is not where the languages live.
 *
 * A brand whose site is laid out its own way keeps the links it is given
 * ([AppBrand.localizedSitePaths]).
 *
 * Plain JVM (`java.net.URI`), so the rules are tested without a device.
 */
object SiteLinks {
    /** Whether this brand's links follow the language. */
    val followsLanguage: Boolean get() = AppBrand.localizedSitePaths

    enum class Page(val path: String) {
        HOME(""),
        PRIVACY("privacy"),
        TERMS("terms"),
    }

    /** The privacy policy and the terms, as configured or as built on the site. */
    data class LegalLinks(val privacyPolicy: String?, val terms: String?)

    /** The path segment a language lives under: none for Persian, its code otherwise. */
    fun languageSegment(language: Language): String? = languageSegment(language.code)

    /**
     * The same, by code: the site has an Arabic section (`/ar`) that this
     * app, which speaks no Arabic, never asks for — but the rule is the
     * iOS app's whole rule, and is tested as such.
     */
    internal fun languageSegment(code: String): String? = code.takeUnless { it == Language.FA.code }

    /** `https://host` (and its port) of the website link, nothing else of it. */
    fun root(website: String?): String? {
        val raw = website?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != "https") return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching { URI("https", null, host, uri.port, null, null, null).toString() }.getOrNull()
    }

    /** A page of the site in [language], or null when the site's address is unknown. */
    fun page(page: Page, website: String?, language: Language): String? = page(page, website, language.code)

    internal fun page(page: Page, website: String?, languageCode: String): String? {
        val root = root(website) ?: return null
        val segments = listOfNotNull(languageSegment(languageCode), page.path.ifEmpty { null })
        if (segments.isEmpty()) return root
        return root + "/" + segments.joinToString("/")
    }

    /** The website link, in [language]: the site's home. */
    fun website(website: String?, language: Language, followsLanguage: Boolean = SiteLinks.followsLanguage): String? =
        website(website, language.code, followsLanguage)

    internal fun website(website: String?, languageCode: String, followsLanguage: Boolean): String? {
        if (!followsLanguage) return website
        return page(Page.HOME, website, languageCode) ?: website
    }

    /** The privacy policy and the terms, on the site in [language]; as configured without a site or for a brand that keeps its own. */
    fun legal(
        configured: LegalLinks,
        website: String?,
        language: Language,
        followsLanguage: Boolean = SiteLinks.followsLanguage,
    ): LegalLinks = legal(configured, website, language.code, followsLanguage)

    internal fun legal(configured: LegalLinks, website: String?, languageCode: String, followsLanguage: Boolean): LegalLinks {
        if (!followsLanguage || root(website) == null) return configured
        return LegalLinks(
            privacyPolicy = page(Page.PRIVACY, website, languageCode),
            terms = page(Page.TERMS, website, languageCode),
        )
    }
}
