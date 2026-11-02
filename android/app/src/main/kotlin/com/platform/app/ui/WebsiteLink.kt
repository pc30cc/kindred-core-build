package com.platform.app.ui

import com.platform.app.core.model.MobileAppConfig
import com.platform.app.i18n.Language
import com.platform.app.i18n.SiteLinks
import com.platform.app.i18n.StrAndroid

/** A link shown by its name, never by its address (`AppState.signInWebsite`). */
data class WebsiteLink(val title: String, val url: String)

/**
 * The sign-in screen's website link (docs/operations/MOBILE_APP_PLAN.md,
 * "The sign-in screen's site address"; the iOS app's `signInWebsiteLink`):
 * labelled with the word — Super Admin's name for the website in this
 * language, else the app's own "Website" — never the address (owner,
 * 2026-11-02), and opening the brand's site in the language on screen
 * ([SiteLinks]: the Iranian edition's Persian at the root and `/en`, `/tr`
 * under it; RESPOK's as configured).
 *
 * The site is the website link Super Admin set for the app, else the
 * platform's canonical site; with neither known there is no link.
 */
internal fun signInWebsiteLink(
    config: MobileAppConfig,
    site: String?,
    language: Language,
    followsLanguage: Boolean = SiteLinks.followsLanguage,
): WebsiteLink? {
    val root = config.websiteLink ?: site?.takeIf { SiteLinks.root(it) != null } ?: return null
    val url = SiteLinks.website(root, language, followsLanguage) ?: return null
    return WebsiteLink(title = config.websiteName(language) ?: StrAndroid.website(language), url = url)
}
