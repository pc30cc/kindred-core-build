package com.webyar.operator.feature.visitors

import com.webyar.operator.core.model.LiveVisitor
import com.webyar.operator.core.model.VisitorGeo
import com.webyar.operator.core.model.VisitorPageHistory
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrInsights
import java.net.URI
import java.net.URLDecoder
import java.time.Duration
import java.time.Instant

/** One step of the visit: where they came in, where they went, where they are. */
data class VisitStep(
    val id: Int,
    val label: String,
    val url: String?,
    val title: String?,
    val at: Instant?,
    val current: Boolean,
)

/** A country in the list, for the country filter. */
data class VisitorCountry(val code: String, val name: String)

/**
 * The Visitors tab's wording, exactly as the Mac and Windows apps word it
 * (`VisitorText` there): the same names for anonymous visitors, the same
 * place line, the same "2m ago".
 */
object VisitorText {

    /**
     * A named contact by name; anyone else as "Visitor from Tehran · 4ZTK" —
     * the province rather than the city for Iran, as the web says it. The
     * code and the place are isolated so a Latin code never reorders a
     * Persian sentence.
     */
    fun name(v: LiveVisitor, language: Language): String {
        val named = v.contact?.name?.trim().orEmpty()
        if (named.isNotEmpty() && !named.equals("visitor", ignoreCase = true)) return named
        val code = v.contact?.code ?: legacyCode(v.contact?.id ?: v.id)
        val isolated = "⁨$code⁩"
        val iran = v.geo?.countryCode?.trim()?.uppercase() == "IR"
        val place = (if (iran) v.geo?.region else v.geo?.city)?.trim().orEmpty()
        if (place.isEmpty()) return StrInsights.visitorAnonymous(language, isolated)
        val where = "⁨$place⁩"
        return if (iran) {
            StrInsights.visitorAnonymousFromRegion(language, where, isolated)
        } else {
            StrInsights.visitorAnonymousFromCity(language, where, isolated)
        }
    }

    /** `anonymousContact.ts` anonCodeFrom: base-36 of a ×31 hash, the last four. */
    fun legacyCode(seed: String): String {
        var h = 0u
        for (ch in seed) h = h * 31u + ch.code.toUInt()
        val digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        val out = StringBuilder()
        do {
            out.insert(0, digits[(h % 36u).toInt()])
            h /= 36u
        } while (h > 0u)
        while (out.length < 4) out.insert(0, '0')
        return out.takeLast(4).toString()
    }

    /** City, the province for Iran, country — each once. */
    fun location(g: VisitorGeo?): String? {
        g ?: return null
        val region = g.region?.takeIf { it != g.city && g.countryCode == "IR" }
        val parts = mutableListOf<String>()
        for (p in listOf(g.city, region, g.country)) {
            val t = p?.trim().orEmpty()
            if (t.isNotEmpty() && t !in parts) parts += t
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString("، ")
    }

    fun ago(at: Instant, now: Instant, language: Language): String {
        val sec = Duration.between(at, now).seconds.coerceAtLeast(0)
        return when {
            sec < 60 -> StrInsights.visitorsJustNow(language)
            sec < 3600 -> StrInsights.visitorsMinutesAgo(language, Format.number((sec / 60).toInt(), language))
            else -> StrInsights.visitorsHoursAgo(language, Format.number((sec / 3600).toInt(), language))
        }
    }

    /**
     * host/path without the scheme, as a line fits it. Persian slugs arrive
     * percent-encoded; people read them decoded.
     */
    fun shortUrl(url: String?): String {
        val raw = url?.trim().orEmpty()
        if (raw.isEmpty()) return ""
        val parsed = runCatching { URI(raw) }.getOrNull()
        val host = parsed?.host
        if (parsed != null && !parsed.scheme.isNullOrEmpty() && !host.isNullOrEmpty()) {
            var path = parsed.rawPath.orEmpty().ifEmpty { "/" }
            parsed.rawQuery?.let { path += "?$it" }
            val decoded = decode(path)
            return if (decoded == "/") host else host + decoded
        }
        // Not parseable as it is (unencoded Persian, say): drop the scheme by hand.
        var rest = raw
        for (prefix in listOf("https://", "http://")) {
            if (rest.lowercase().startsWith(prefix)) {
                rest = rest.drop(prefix.length)
                if (rest.endsWith("/") && rest.count { it == '/' } == 1) rest = rest.dropLast(1)
                break
            }
        }
        return decode(rest)
    }

    private fun decode(s: String): String =
        runCatching { URLDecoder.decode(s.replace("+", "%2B"), Charsets.UTF_8) }.getOrDefault(s)

    fun matches(v: LiveVisitor, query: String, language: Language): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return true
        val fields = listOf(v.currentPage, v.geo?.country, v.geo?.city, v.browser, v.contact?.name, v.contact?.email)
        if (fields.any { it?.contains(q, ignoreCase = true) == true }) return true
        return name(v, language).contains(q, ignoreCase = true)
    }

    /**
     * The visit on a line: the entry point, the pages in between (a page read
     * twice in a row once), and where they are now.
     */
    fun steps(h: VisitorPageHistory, language: Language): List<VisitStep> {
        val steps = mutableListOf<VisitStep>()
        fun add(label: String, url: String?, title: String?, at: Instant?, current: Boolean) {
            steps += VisitStep(steps.size, label, url, title, at, current)
        }
        h.entry?.let { add(StrInsights.visitorEntryPoint(language), it.landingUrl, it.landingTitle, it.landedAt, false) }
        for (p in h.items.reversed()) {
            if (steps.lastOrNull()?.url == p.url) continue
            add(StrInsights.visitorJourney(language), p.url, p.title, p.viewedAt, false)
        }
        h.current?.let { cur ->
            if (steps.lastOrNull()?.url == cur.url) steps.removeAt(steps.lastIndex)
            add(StrInsights.visitorCurrentlyOn(language), cur.url, cur.title, cur.viewedAt, true)
        }
        return steps
    }
}
