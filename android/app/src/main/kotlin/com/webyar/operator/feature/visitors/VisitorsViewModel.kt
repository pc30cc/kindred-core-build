package com.webyar.operator.feature.visitors

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.LiveVisitor
import com.webyar.operator.core.model.VisitorMapConfig
import com.webyar.operator.core.model.VisitorMarker
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import com.webyar.operator.core.model.VisitorConversationRef

/** The filters over the list, as the Mac and web have them. */
data class VisitorFilters(
    val search: String = "",
    val onlineOnly: Boolean = false,
    val chatOnly: Boolean = false,
    /** A country code, or null for all. */
    val country: String? = null,
    val includeOffline: Boolean = false,
) {
    val any: Boolean get() = search.isNotBlank() || onlineOnly || chatOnly || country != null
}

/** A dot on the map: a marker from the map endpoint, or a visitor's own coordinates until it answers. */
data class VisitorPin(
    val id: String,
    val lat: Double,
    val lng: Double,
    val status: String,
    val place: String,
)

/** The map as `map-config` describes it; [enabled] false switches it off. */
data class VisitorMapSetup(
    val enabled: Boolean,
    val tileUrl: String,
    val attribution: String,
    val minZoom: Int,
    val maxZoom: Int,
    val centerLat: Double?,
    val centerLng: Double?,
    val zoom: Double,
) {
    companion object {
        /** OpenStreetMap, as the server falls back to when nothing is configured. */
        const val OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

        fun from(c: VisitorMapConfig): VisitorMapSetup = VisitorMapSetup(
            enabled = c.enabled != false,
            tileUrl = c.tileUrl?.takeIf { it.isNotBlank() } ?: OSM,
            attribution = c.attribution?.let(::plainAttribution)?.takeIf { it.isNotBlank() } ?: "© OpenStreetMap contributors",
            minZoom = c.minZoom ?: 0,
            maxZoom = (c.maxZoom ?: 19).coerceIn(1, 22),
            centerLat = c.defaultCenter?.lat,
            centerLng = c.defaultCenter?.lng,
            zoom = c.defaultCenter?.zoom ?: 3.0,
        )
    }
}

/**
 * The tiles' credit as text. Providers write it for Leaflet, as HTML —
 * `&copy; <a href="…">OpenStreetMap</a> contributors` — and a Text shows the
 * markup itself.
 */
internal fun plainAttribution(html: String): String {
    val noTags = html.replace(Regex("<[^>]*>"), "")
    val named = mapOf("&copy;" to "©", "&amp;" to "&", "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'", "&apos;" to "'", "&nbsp;" to " ")
    var out = named.entries.fold(noTags) { acc, (k, v) -> acc.replace(k, v, ignoreCase = true) }
    out = Regex("&#(x?)([0-9a-fA-F]+);").replace(out) { m ->
        val code = m.groupValues[2].toIntOrNull(if (m.groupValues[1].isEmpty()) 10 else 16)
        code?.takeIf { it in 1..0x10FFFF }?.let { String(Character.toChars(it)) } ?: m.value
    }
    return out.replace(Regex("\\s+"), " ").trim()
}

data class VisitorsState(
    /** Everyone the server returned, newest activity first. */
    val visitors: List<LiveVisitor> = emptyList(),
    val loading: Boolean = true,
    /** The first load failed and there is nothing to show. */
    val failed: Boolean = false,
    /** When the list was last loaded: the "2m ago" lines count from it. */
    val now: Instant = Instant.now(),
    val filters: VisitorFilters = VisitorFilters(),
    /** Markers from the map endpoint; null until they arrive. */
    val markers: List<VisitorPin>? = null,
    /** Null until map-config answers. */
    val map: VisitorMapSetup? = null,
) {
    val onlineCount: Int get() = visitors.count { it.presence == "online" }
    val activeCount: Int get() = visitors.count { it.presence != "offline" }
    val countryCount: Int get() = visitors.mapNotNull { it.geo?.countryCode?.takeIf(String::isNotEmpty) }.toSet().size
    val pageCount: Int get() = visitors.mapNotNull { it.currentPage?.takeIf(String::isNotEmpty) }.toSet().size

    /** The list on show: search, the online and conversation toggles, the country. */
    fun visible(language: Language): List<LiveVisitor> = visitors.filter { v ->
        VisitorText.matches(v, filters.search, language) &&
            (!filters.onlineOnly || v.presence == "online") &&
            (!filters.chatOnly || v.conversation != null) &&
            (filters.country == null || v.geo?.countryCode == filters.country)
    }

    /** The countries in the list, by name; the chosen one stays while nobody from it is here. */
    val countries: List<VisitorCountry>
        get() {
            val seen = LinkedHashMap<String, VisitorCountry>()
            for (v in visitors) {
                val code = v.geo?.countryCode?.takeIf { it.isNotEmpty() } ?: continue
                if (code !in seen) seen[code] = VisitorCountry(code, v.geo.country?.takeIf { it.isNotEmpty() } ?: code)
            }
            filters.country?.let { if (it !in seen) seen[it] = VisitorCountry(it, it) }
            return seen.values.sortedBy { it.name.lowercase() }
        }

    /** The map's dots: the map endpoint's, else each visitor's own coordinates. */
    val pins: List<VisitorPin>
        get() = markers ?: visitors.mapNotNull { v ->
            val lat = v.geo?.latitude ?: return@mapNotNull null
            val lng = v.geo.longitude ?: return@mapNotNull null
            VisitorPin(v.id, lat, lng, v.presence, listOfNotNull(v.geo.city, v.geo.country).filter { it.isNotBlank() }.joinToString(", "))
        }
}

/** The selected visitor's page history. */
data class VisitorHistoryState(
    val sessionId: String,
    val steps: List<VisitStep>? = null,
    val loading: Boolean = true,
    /** The last ask failed and there is nothing earlier to show. */
    val failed: Boolean = false,
)

/**
 * The Visitors tab: who is on the site now, where they are and what they
 * are reading — the Mac app's `VisitorsModel`.
 *
 * The list is asked for every five seconds and the map every ten while the
 * screen is up (the web's defaults), and not at all while it is not: the
 * caller runs [followWhileVisible] under `repeatOnLifecycle(RESUMED)`.
 */
class VisitorsViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow(VisitorsState())
    val state: StateFlow<VisitorsState> = _state.asStateFlow()

    private val _history = MutableStateFlow<VisitorHistoryState?>(null)
    val history: StateFlow<VisitorHistoryState?> = _history.asStateFlow()

    private val _chatBusy = MutableStateFlow(false)
    val chatBusy: StateFlow<Boolean> = _chatBusy.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private var workspaceId: String? = null
    private val listKick = Channel<Unit>(Channel.CONFLATED)
    private val mapKick = Channel<Unit>(Channel.CONFLATED)
    private var historyJob: Job? = null
    private var followers = 0
    private var followJob: Job? = null

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        // Another workspace: nothing of the last one carries over.
        _state.value = VisitorsState()
        _history.value = null
        refresh()
    }

    /**
     * Keeps the list and the map current while a Visitors screen is up: the
     * list every [listMs], the map every [mapMs], and at once on [refresh] or
     * a filter that needs the server (include offline).
     *
     * The list and a visitor's page each call this while they are resumed —
     * on a phone only one of them is composed, on a tablet both — and one
     * loop serves however many are showing: it starts with the first and
     * stops with the last. Called on the main thread, as composition runs.
     */
    suspend fun followWhileVisible(listMs: Long = LIST_MS, mapMs: Long = MAP_MS) {
        followers++
        if (followers == 1) followJob = viewModelScope.launch { followLoop(listMs, mapMs) }
        try {
            awaitCancellation()
        } finally {
            followers--
            if (followers == 0) {
                followJob?.cancel()
                followJob = null
            }
        }
    }

    private suspend fun followLoop(listMs: Long, mapMs: Long) = coroutineScope {
        // Asked for now in any case: a kick left over from bind() would only
        // ask the same thing twice.
        listKick.tryReceive()
        mapKick.tryReceive()
        launch {
            while (currentCoroutineContext().isActive) {
                loadMap()
                withTimeoutOrNull(mapMs) { mapKick.receive() }
            }
        }
        while (currentCoroutineContext().isActive) {
            load()
            withTimeoutOrNull(listMs) { listKick.receive() }
        }
    }

    fun refresh() {
        listKick.trySend(Unit)
        mapKick.trySend(Unit)
    }

    fun setSearch(value: String) = _state.update { it.copy(filters = it.filters.copy(search = value)) }
    fun setOnlineOnly(on: Boolean) = _state.update { it.copy(filters = it.filters.copy(onlineOnly = on)) }
    fun setChatOnly(on: Boolean) = _state.update { it.copy(filters = it.filters.copy(chatOnly = on)) }
    fun setCountry(code: String?) = _state.update { it.copy(filters = it.filters.copy(country = code)) }
    fun clearFilters() = _state.update { it.copy(filters = VisitorFilters(includeOffline = it.filters.includeOffline)) }

    fun setIncludeOffline(on: Boolean) {
        if (_state.value.filters.includeOffline == on) return
        _state.update { it.copy(filters = it.filters.copy(includeOffline = on)) }
        listKick.trySend(Unit)
    }

    internal suspend fun load() {
        val ws = workspaceId ?: return
        val includeOffline = _state.value.filters.includeOffline
        try {
            val list = api.liveVisitors(ws, includeOffline)
            if (workspaceId != ws) return
            // Newest activity first; ties keep the server's order.
            val sorted = list.withIndex()
                .sortedWith(compareByDescending<IndexedValue<LiveVisitor>> { it.value.lastActivityAt ?: Instant.EPOCH }.thenBy { it.index })
                .map { it.value }
            _state.update { it.copy(visitors = sorted, loading = false, failed = false, now = Instant.now()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (_state.value.visitors.isEmpty()) _state.update { it.copy(loading = false, failed = true) }
        }
    }

    private suspend fun loadMap() {
        val ws = workspaceId ?: return
        try {
            if (_state.value.map == null) {
                val setup = VisitorMapSetup.from(api.visitorMapConfig(ws))
                if (workspaceId != ws) return
                _state.update { it.copy(map = setup) }
            }
            if (_state.value.map?.enabled != true) return
            val markers = api.visitorMap(ws).markers.mapNotNull(::pinOf)
            if (workspaceId != ws) return
            _state.update { it.copy(markers = markers) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // The list is what matters; the map shows the visitors' own coordinates.
        }
    }

    private fun pinOf(m: VisitorMarker): VisitorPin? {
        val lat = m.lat ?: return null
        val lng = m.lng ?: return null
        val status = when (m.status) { "online" -> "online"; "idle" -> "idle"; else -> "offline" }
        return VisitorPin(m.id, lat, lng, status, listOfNotNull(m.city, m.country).filter { it.isNotBlank() }.joinToString(", "))
    }

    fun visitor(sessionId: String): LiveVisitor? = _state.value.visitors.firstOrNull { it.id == sessionId }

    /**
     * The page history of [sessionId], asked for again on every open — the
     * visit goes on while nobody is looking — with what was already here
     * kept on screen meanwhile.
     */
    fun openHistory(sessionId: String) {
        val ws = workspaceId ?: return
        val before = _history.value?.takeIf { it.sessionId == sessionId }?.steps
        _history.value = VisitorHistoryState(sessionId, before, loading = true)
        historyJob?.cancel()
        historyJob = viewModelScope.launch {
            try {
                val steps = VisitorText.steps(api.visitorPageHistory(ws, sessionId), language())
                if (workspaceId == ws && _history.value?.sessionId == sessionId) {
                    _history.value = VisitorHistoryState(sessionId, steps, loading = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                if (workspaceId == ws && _history.value?.sessionId == sessionId) {
                    _history.value = VisitorHistoryState(sessionId, before, loading = false, failed = before == null)
                }
            }
        }
    }

    /**
     * The visitor's conversation, starting one when there is none — the
     * server reuses an open one. [open] gets its id; a failure is a notice.
     */
    fun chat(visitor: LiveVisitor, open: (String) -> Unit) {
        val ws = workspaceId ?: return
        if (_chatBusy.value) return
        // The live list carries the session's latest conversation whatever
        // its state; only one still going is the chat to open. A resolved one
        // is history, and the server starts a new thread for it, as the web does.
        visitor.conversation?.takeIf { it.status == null || it.status in LIVE_STATUSES }?.let { open(it.id); return }
        _chatBusy.value = true
        viewModelScope.launch {
            try {
                val id = api.startChatWithVisitor(ws, visitor.id).conversationId
                if (id != null && workspaceId == ws) {
                    open(id)
                    // Carry it on the row at once rather than at the next poll.
                    _state.update { s ->
                        s.copy(
                            visitors = s.visitors.map {
                                if (it.id == visitor.id) it.copy(conversation = VisitorConversationRef(id, status = "open")) else it
                            },
                        )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _notice.value = e.displayText(language())
            } finally {
                _chatBusy.value = false
            }
        }
    }

    fun dismissNotice() {
        _notice.value = null
    }

    companion object {
        /** The web's `live_refresh_ms`. */
        const val LIST_MS = 5_000L
        const val MAP_MS = 10_000L

        /** The conversation states `start-from-visitor` reuses rather than replaces. */
        private val LIVE_STATUSES = setOf("open", "pending")
    }
}
