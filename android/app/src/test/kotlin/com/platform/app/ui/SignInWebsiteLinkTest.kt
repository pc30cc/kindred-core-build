package com.platform.app.ui

import com.platform.app.core.model.MobileAppConfig
import com.platform.app.i18n.Language
import com.platform.app.i18n.StrAndroid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The sign-in screen's website link (docs/operations/MOBILE_APP_PLAN.md,
 * "The sign-in screen's site address"): the word, never the address (owner:
 * "don't show the address, make it a link"), opening the brand's site in the
 * app's language — from the app config's website link, else the platform's
 * canonical site; no link when neither is known.
 *
 * Hosts under respok.app, which both brands' builds accept (a RESPOK build
 * links to no other brand's site), so the rule is checked in either flavor.
 */
class SignInWebsiteLinkTest {
    private val site = "https://respok.app"

    @Test
    fun `labelled with the word, never the address`() {
        for (language in Language.entries) {
            val link = signInWebsiteLink(MobileAppConfig(), site, language, followsLanguage = true)!!
            assertEquals(StrAndroid.website(language), link.title)
        }
        assertEquals("Website", StrAndroid.website(Language.EN))
        assertEquals("وب‌سایت", StrAndroid.website(Language.FA))
        assertEquals("Web sitesi", StrAndroid.website(Language.TR))
    }

    @Test
    fun `the canonical site, in the app's language`() {
        assertEquals("https://respok.app", signInWebsiteLink(MobileAppConfig(), site, Language.FA, followsLanguage = true)?.url)
        assertEquals("https://respok.app/en", signInWebsiteLink(MobileAppConfig(), site, Language.EN, followsLanguage = true)?.url)
        assertEquals("https://respok.app/tr", signInWebsiteLink(MobileAppConfig(), site, Language.TR, followsLanguage = true)?.url)
    }

    /** Super Admin's website link and its name win; only its host is the root. */
    @Test
    fun `the app config's website link and name come first`() {
        val config = MobileAppConfig(
            websiteUrl = "https://www.respok.app/landing",
            websiteLabel = mapOf("en" to " Our site ", "fa" to "  "),
        )
        val en = signInWebsiteLink(config, site, Language.EN, followsLanguage = true)!!
        assertEquals("Our site", en.title)
        assertEquals("https://www.respok.app/en", en.url)
        // A name left blank in a language is the app's own word there.
        assertEquals(StrAndroid.website(Language.FA), signInWebsiteLink(config, site, Language.FA, followsLanguage = true)?.title)
    }

    /** A brand whose site is laid out its own way opens it as configured. */
    @Test
    fun `a brand that keeps its own links opens them as they are`() {
        val config = MobileAppConfig(websiteUrl = "https://www.respok.app/landing")
        assertEquals("https://www.respok.app/landing", signInWebsiteLink(config, site, Language.EN, followsLanguage = false)?.url)
        assertEquals("https://respok.app", signInWebsiteLink(MobileAppConfig(), site, Language.TR, followsLanguage = false)?.url)
    }

    @Test
    fun `no site known, no link`() {
        assertNull(signInWebsiteLink(MobileAppConfig(), null, Language.EN, followsLanguage = true))
        // Never an http address, nor something that is not one.
        assertNull(signInWebsiteLink(MobileAppConfig(websiteUrl = "http://respok.app"), null, Language.EN, followsLanguage = true))
        assertNull(signInWebsiteLink(MobileAppConfig(websiteUrl = "javascript:alert(1)"), "not a url", Language.EN, followsLanguage = true))
        // An unusable config link falls back to the canonical site.
        assertEquals(
            "https://respok.app/en",
            signInWebsiteLink(MobileAppConfig(websiteUrl = "http://respok.app"), site, Language.EN, followsLanguage = true)?.url,
        )
    }
}
