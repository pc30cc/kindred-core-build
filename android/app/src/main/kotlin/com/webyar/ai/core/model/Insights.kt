package com.webyar.ai.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant

// The Visitors and Website analytics tabs, as the server answers them.
// Visitors: `/api/visitor-intel/*` (server/routes/visitors.ts, snake_case).
// Analytics: `/api/web-analytics/:workspaceId/*` (server/routes/webAnalytics.ts,
// camelCase). The same reads the Mac and Windows apps make.

// MARK: - Visitors

/** Where a visitor is, as the geo lookup resolved it (`GeoResult`). */
@Serializable
data class VisitorGeo(
    val country: String? = null,
    @SerialName("country_code") val countryCode: String? = null,
    val region: String? = null,
    val city: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
    /** provider | cache | centroid | unavailable | disabled. */
    val source: String? = null,
)

/** The contact a visitor session is linked to, when there is one. */
@Serializable
data class VisitorContactRef(
    val id: String,
    val name: String? = null,
    val email: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("visitor_code") val visitorCode: String? = null,
    val metadata: JsonElement? = null,
) {
    /** The short code the widget gave this visitor, as the web resolves it. */
    val code: String?
        get() = visitorCode?.trim()?.takeIf { it.isNotEmpty() }
            ?: metadata.string("anon_code")?.trim()?.takeIf { it.isNotEmpty() }
}

@Serializable
data class VisitorConversationRef(
    val id: String,
    val status: String? = null,
    val subject: String? = null,
)

/** One live visitor session (`VisitorIntelligenceItem`). `id` is the session id. */
@Serializable
data class LiveVisitor(
    val id: String,
    @SerialName("visitor_id") val visitorId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    /** online | idle | offline | unknown. */
    val status: String? = null,
    @SerialName("current_page") val currentPage: String? = null,
    @SerialName("last_activity_at") @Serializable(InstantSerializer::class) val lastActivityAt: Instant? = null,
    @SerialName("started_at") @Serializable(InstantSerializer::class) val startedAt: Instant? = null,
    val browser: String? = null,
    val device: String? = null,
    val os: String? = null,
    val referrer: String? = null,
    val geo: VisitorGeo? = null,
    /** Always masked or a placeholder unless this operator's role and plan allow the raw address. */
    @SerialName("ip_display") val ipDisplay: String? = null,
    @SerialName("ip_locked") val ipLocked: Boolean? = null,
    val contact: VisitorContactRef? = null,
    val conversation: VisitorConversationRef? = null,
) {
    /** online, idle or offline — anything else reads as offline. */
    val presence: String
        get() = when (status) {
            "online" -> "online"
            "idle" -> "idle"
            else -> "offline"
        }
}

@Serializable
data class LiveVisitorsResponse(val items: List<LiveVisitor> = emptyList())

@Serializable
data class VisitorPageView(
    val id: Long? = null,
    val url: String? = null,
    val title: String? = null,
    @SerialName("viewed_at") @Serializable(InstantSerializer::class) val viewedAt: Instant? = null,
)

@Serializable
data class VisitorPageEntry(
    @SerialName("landing_url") val landingUrl: String? = null,
    @SerialName("landing_title") val landingTitle: String? = null,
    @SerialName("landed_at") @Serializable(InstantSerializer::class) val landedAt: Instant? = null,
    val referrer: String? = null,
)

/** `GET /api/visitor-intel/:session/page-history`. */
@Serializable
data class VisitorPageHistory(
    val items: List<VisitorPageView> = emptyList(),
    val entry: VisitorPageEntry? = null,
    val current: VisitorPageView? = null,
)

/** `POST /api/conversations/start-from-visitor`: reuses the visitor's open conversation. */
@Serializable
data class StartChatResult(
    val ok: Boolean? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    val created: Boolean? = null,
)

/** A dot on the Visitors map (`GET /api/visitor-intel/map`). */
@Serializable
data class VisitorMarker(
    val id: String,
    val status: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val country: String? = null,
    @SerialName("country_code") val countryCode: String? = null,
    val city: String? = null,
    @SerialName("current_page") val currentPage: String? = null,
)

@Serializable
data class VisitorMapResponse(val markers: List<VisitorMarker> = emptyList())

@Serializable
data class VisitorMapCenter(val lat: Double? = null, val lng: Double? = null, val zoom: Double? = null)

/**
 * `GET /api/visitor-intel/map-config`: the tiles the web draws its map
 * with, and where it opens. `enabled = false` switches the map off.
 */
@Serializable
data class VisitorMapConfig(
    val enabled: Boolean? = null,
    /** An XYZ template: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`. */
    @SerialName("tile_url") val tileUrl: String? = null,
    val attribution: String? = null,
    @SerialName("max_zoom") val maxZoom: Int? = null,
    @SerialName("min_zoom") val minZoom: Int? = null,
    @SerialName("default_center") val defaultCenter: VisitorMapCenter? = null,
)

// MARK: - Website analytics

@Serializable
data class AnalyticsDay(
    /** YYYY-MM-DD, UTC. */
    val date: String,
    val sessions: Int? = null,
    val pageviews: Int? = null,
)

/** One line of a "group by X, count visits" report. */
@Serializable
data class AnalyticsRow(
    val key: String,
    val label: String? = null,
    val sessions: Int? = null,
    val pageviews: Int? = null,
)

@Serializable
data class AnalyticsPage(val path: String, val views: Int? = null)

@Serializable
data class AnalyticsEvent(
    val eventName: String,
    val count: Int? = null,
    val uniqueSessions: Int? = null,
    /** 0–1: the share of the range's visits that fired it. */
    val conversionRate: Double? = null,
)

/** The headline numbers for a date range, and the day-by-day trend. */
@Serializable
data class AnalyticsOverview(
    val sessions: Int? = null,
    val pageviews: Int? = null,
    val avgPagesPerSession: Double? = null,
    val uniqueVisitors: Int? = null,
    /** Percentage, 0–100, of visits with a single page view. */
    val bounceRate: Double? = null,
    val avgVisitDurationSeconds: Double? = null,
    val trend: List<AnalyticsDay> = emptyList(),
    val topChannels: List<AnalyticsRow> = emptyList(),
    val topPages: List<AnalyticsPage> = emptyList(),
    /** The server counted a sample of a very busy range. */
    val truncated: Boolean? = null,
)

@Serializable
data class AnalyticsRows(val rows: List<AnalyticsRow> = emptyList(), val truncated: Boolean? = null)

@Serializable
data class AnalyticsPages(val rows: List<AnalyticsPage> = emptyList(), val truncated: Boolean? = null)

@Serializable
data class AnalyticsEvents(val rows: List<AnalyticsEvent> = emptyList(), val truncated: Boolean? = null)

@Serializable
data class AnalyticsLiveCount(val count: Int? = null)
