package com.platform.app.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The brand's site links in the app's language (owner, 2026-11-01): Persian
 * at the root, every other language under its code; a brand that keeps its
 * own links (RESPOK) as configured. The same cases as the iOS app's
 * `SiteLinksTests` (ios/Webyar/Tests/Core/SiteLinksTests.swift), Arabic
 * included by its code — this app speaks no Arabic, but the rule is the
 * site's. Which brand this build is, and so whether its links follow the
 * language, is each flavor's `AppBrandTest`.
 */
class SiteLinksTest {
    private val website = "https://webyar.ai"
    private val configured = SiteLinks.LegalLinks(
        privacyPolicy = "https://app.webyar.ai/privacy",
        terms = "https://app.webyar.ai/terms",
    )

    private fun legal(code: String, follows: Boolean = true, website: String? = "https://webyar.ai") =
        SiteLinks.legal(configured, website, code, follows)

    @Test
    fun `Persian is at the root`() {
        assertEquals("https://webyar.ai", SiteLinks.website(website, Language.FA, followsLanguage = true))
        assertEquals("https://webyar.ai/privacy", legal("fa").privacyPolicy)
        assertEquals("https://webyar.ai/terms", legal("fa").terms)
    }

    @Test
    fun `other languages live under their code`() {
        assertEquals("https://webyar.ai/en", SiteLinks.website(website, Language.EN, followsLanguage = true))
        assertEquals("https://webyar.ai/en/privacy", legal("en").privacyPolicy)
        assertEquals("https://webyar.ai/en/terms", legal("en").terms)
        assertEquals("https://webyar.ai/tr", SiteLinks.website(website, Language.TR, followsLanguage = true))
        assertEquals("https://webyar.ai/tr/privacy", legal("tr").privacyPolicy)
        assertEquals("https://webyar.ai/tr/terms", legal("tr").terms)
        assertEquals("https://webyar.ai/ar", SiteLinks.website(website, "ar", followsLanguage = true))
        assertEquals("https://webyar.ai/ar/privacy", legal("ar").privacyPolicy)
    }

    /** The root is the website link's host, whatever path Super Admin typed. */
    @Test
    fun `only the website's host is kept`() {
        val typed = "https://webyar.ai/fa/landing?x=1"
        assertEquals("https://webyar.ai/en/terms", legal("en", website = typed).terms)
        assertEquals("https://webyar.ai", SiteLinks.website(typed, Language.FA, followsLanguage = true))
        assertEquals("https://webyar.ai:8443/en", SiteLinks.website("https://webyar.ai:8443/x", Language.EN, followsLanguage = true))
        assertEquals("https://webyar.ai", SiteLinks.root(" https://webyar.ai/ "))
    }

    /** Without a site address the configured pages stand; never an http root. */
    @Test
    fun `no website keeps the configured pages`() {
        assertEquals(configured, legal("en", website = null))
        assertNull(SiteLinks.website(null, Language.EN, followsLanguage = true))
        assertEquals(configured, legal("en", website = "http://webyar.ai"))
        assertNull(SiteLinks.root("http://webyar.ai"))
        assertNull(SiteLinks.root("https://"))
        assertNull(SiteLinks.root("not a url"))
        assertNull(SiteLinks.root(""))
    }

    /** RESPOK keeps what it is given. */
    @Test
    fun `a brand that keeps its own links is unchanged`() {
        assertEquals(configured, legal("en", follows = false))
        assertEquals(website, SiteLinks.website(website, Language.TR, followsLanguage = false))
        assertEquals("https://respok.app/start", SiteLinks.website("https://respok.app/start", Language.EN, followsLanguage = false))
    }

    @Test
    fun `the language segment is the code, but none for Persian`() {
        assertNull(SiteLinks.languageSegment(Language.FA))
        assertEquals("en", SiteLinks.languageSegment(Language.EN))
        assertEquals("tr", SiteLinks.languageSegment(Language.TR))
        assertEquals("https://webyar.ai/en", SiteLinks.page(SiteLinks.Page.HOME, website, Language.EN))
        assertEquals("https://webyar.ai/terms", SiteLinks.page(SiteLinks.Page.TERMS, website, Language.FA))
    }
}
