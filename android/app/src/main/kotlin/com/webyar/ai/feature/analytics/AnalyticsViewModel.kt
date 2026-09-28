package com.webyar.ai.feature.analytics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.AnalyticsEvents
import com.webyar.ai.core.model.AnalyticsOverview
import com.webyar.ai.core.model.AnalyticsPages
import com.webyar.ai.core.model.AnalyticsRows
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Clock
import java.time.LocalDate

/** The reports, in the order the list shows them. */
enum class AnalyticsSection(val wire: String) {
    OVERVIEW("overview"),
    SOURCES("sources"),
    PAGES("pages"),
    GEOGRAPHY("geography"),
    TECHNOLOGY("technology"),
    EVENTS("events");

    companion object {
        fun from(wire: String): AnalyticsSection = entries.firstOrNull { it.wire == wire } ?: OVERVIEW
    }
}

/** The date range every report shares: the last 7, 28 or 90 days, today included. */
enum class AnalyticsRange(val days: Int) {
    WEEK(7),
    MONTH(28),
    QUARTER(90);

    /** YYYY-MM-DD bounds, in UTC as the server counts days. */
    fun bounds(clock: Clock = Clock.systemUTC()): Pair<String, String> = boundsEnding(LocalDate.now(clock))

    /** The same number of days just before, for "compared with the period before". */
    fun previousBounds(clock: Clock = Clock.systemUTC()): Pair<String, String> =
        boundsEnding(LocalDate.now(clock).minusDays(days.toLong()))

    private fun boundsEnding(end: LocalDate): Pair<String, String> =
        end.minusDays((days - 1).toLong()).toString() to end.toString()
}

data class AnalyticsState(
    val range: AnalyticsRange = AnalyticsRange.MONTH,
    val sourceDimension: String = "channel",
    val pagesKind: String = "top",
    val geoDimension: String = "country",
    val overview: AnalyticsOverview? = null,
    /** The same report for the days just before the range, for the headline numbers' change. */
    val previous: AnalyticsOverview? = null,
    /** Report rows by "report.dimension", for the range on show. */
    val breakdowns: Map<String, AnalyticsRows> = emptyMap(),
    val pageLists: Map<String, AnalyticsPages> = emptyMap(),
    val events: AnalyticsEvents? = null,
    /** The days [overview] was asked for, which the chart spans — not today's range, which moves at midnight. */
    val overviewDays: Pair<String, String>? = null,
    /** Visitors on the site right now. */
    val live: Int? = null,
    val loading: Set<String> = emptySet(),
    val error: String? = null,
    /** The server says the plan does not include web analytics (it may have changed since the tabs last looked). */
    val locked: Boolean = false,
) {
    fun isLoading(key: String): Boolean = key in loading

    val sourcesKey: String get() = "sources.$sourceDimension"
    val pagesKey: String get() = "pages.$pagesKind"
    val geoKey: String get() = "geo.$geoDimension"

    fun truncated(section: AnalyticsSection): Boolean = when (section) {
        AnalyticsSection.OVERVIEW -> overview?.truncated == true
        AnalyticsSection.SOURCES -> breakdowns[sourcesKey]?.truncated == true
        AnalyticsSection.PAGES -> pageLists[pagesKey]?.truncated == true
        AnalyticsSection.GEOGRAPHY -> breakdowns[geoKey]?.truncated == true
        AnalyticsSection.TECHNOLOGY -> TECH_DIMENSIONS.any { breakdowns["tech.$it"]?.truncated == true }
        AnalyticsSection.EVENTS -> events?.truncated == true
    }

    companion object {
        val TECH_DIMENSIONS = listOf("device", "os", "browser")
    }
}

/**
 * Website analytics, as the web console's SEO → Web Analytics reads it: the
 * visits the chat widget's snippet already records, over a shared date range
 * — the Mac app's `AnalyticsModel`. Owners and admins whose plan has the
 * `web_analytics` module see it; the server checks the same module on every
 * report.
 *
 * Each report is asked for once per range and kept; a range change drops them
 * all, and an answer still out for the old range is thrown away when it lands.
 */
class AnalyticsViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
    /** The server said the plan no longer has it: the tabs should look again. */
    private val onLocked: () -> Unit = {},
    private val clock: Clock = Clock.systemUTC(),
) : ViewModel() {

    private val _state = MutableStateFlow(AnalyticsState())
    val state: StateFlow<AnalyticsState> = _state.asStateFlow()

    private var workspaceId: String? = null
    /** Bumped by every range change, so a slow answer for the old range is dropped. */
    private var generation = 0
    /** The report on show, reloaded when the range changes under it. */
    private var shown: AnalyticsSection = AnalyticsSection.OVERVIEW
    private val liveKick = Channel<Unit>(Channel.CONFLATED)

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        generation++
        _state.value = AnalyticsState()
        liveKick.trySend(Unit)
    }

    /** "12 on the site now", every thirty seconds while the tab is up. */
    suspend fun followLiveWhileVisible(everyMs: Long = LIVE_MS) {
        // Asked for now in any case; a kick left over from bind() would only ask twice.
        liveKick.tryReceive()
        while (currentCoroutineContext().isActive) {
            loadLive()
            withTimeoutOrNull(everyMs) { liveKick.receive() }
        }
    }

    internal suspend fun loadLive() {
        val ws = workspaceId ?: return
        try {
            val n = api.analyticsLiveVisitors(ws)
            if (workspaceId == ws) _state.update { it.copy(live = n) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // An extra: the reports matter, and the pill just keeps its last number.
        }
    }

    fun setRange(range: AnalyticsRange) {
        if (_state.value.range == range) return
        _state.update { cleared(it).copy(range = range) }
        load(shown)
    }

    /** Asks again for everything on show. */
    fun refresh() {
        _state.update { cleared(it) }
        load(shown)
        liveKick.trySend(Unit)
    }

    private fun cleared(s: AnalyticsState): AnalyticsState {
        generation++
        // Answers still out are for the old range: they will be dropped, so they must not block the new ones.
        return s.copy(
            overview = null,
            previous = null,
            overviewDays = null,
            breakdowns = emptyMap(),
            pageLists = emptyMap(),
            events = null,
            loading = emptySet(),
            error = null,
        )
    }

    fun setSourceDimension(value: String) {
        if (_state.value.sourceDimension == value) return
        _state.update { it.copy(sourceDimension = value) }
        load(AnalyticsSection.SOURCES)
    }

    fun setPagesKind(value: String) {
        if (_state.value.pagesKind == value) return
        _state.update { it.copy(pagesKind = value) }
        load(AnalyticsSection.PAGES)
    }

    fun setGeoDimension(value: String) {
        if (_state.value.geoDimension == value) return
        _state.update { it.copy(geoDimension = value) }
        load(AnalyticsSection.GEOGRAPHY)
    }

    /** What [section] needs, unless it is already here for this range. */
    fun load(section: AnalyticsSection) {
        shown = section
        val s = _state.value
        when (section) {
            AnalyticsSection.OVERVIEW -> {
                if (s.overview == null) {
                    fetch("overview", { ws, a, b -> api.analyticsOverview(ws, a, b) }) { st, v, days -> st.copy(overview = v, overviewDays = days) }
                }
                if (s.previous == null) {
                    val (a, b) = s.range.previousBounds(clock)
                    fetch("overview.previous", quiet = true, request = { ws, _, _ -> api.analyticsOverview(ws, a, b) }) { st, v, _ ->
                        st.copy(previous = v)
                    }
                }
            }
            AnalyticsSection.SOURCES -> {
                val key = s.sourcesKey
                val dim = s.sourceDimension
                if (s.breakdowns[key] == null) {
                    fetch(key, { ws, a, b -> api.analyticsTrafficSources(ws, dim, a, b) }) { st, v, _ -> st.copy(breakdowns = st.breakdowns + (key to v)) }
                }
            }
            AnalyticsSection.PAGES -> {
                val key = s.pagesKey
                val kind = s.pagesKind
                if (s.pageLists[key] == null) {
                    fetch(key, { ws, a, b -> api.analyticsPages(ws, kind, a, b) }) { st, v, _ -> st.copy(pageLists = st.pageLists + (key to v)) }
                }
            }
            AnalyticsSection.GEOGRAPHY -> {
                val key = s.geoKey
                val dim = s.geoDimension
                if (s.breakdowns[key] == null) {
                    fetch(key, { ws, a, b -> api.analyticsGeography(ws, dim, a, b) }) { st, v, _ -> st.copy(breakdowns = st.breakdowns + (key to v)) }
                }
            }
            AnalyticsSection.TECHNOLOGY -> {
                for (dim in AnalyticsState.TECH_DIMENSIONS) {
                    val key = "tech.$dim"
                    if (s.breakdowns[key] == null) {
                        fetch(key, { ws, a, b -> api.analyticsTechnology(ws, dim, a, b) }) { st, v, _ -> st.copy(breakdowns = st.breakdowns + (key to v)) }
                    }
                }
            }
            AnalyticsSection.EVENTS -> {
                if (s.events == null) {
                    fetch("events", { ws, a, b -> api.analyticsEvents(ws, a, b) }) { st, v, _ -> st.copy(events = v) }
                }
            }
        }
    }

    /**
     * One report for the range on show; its answer is kept only if the range
     * is still the same. A [quiet] report is only an extra: when it fails the
     * page shows without it.
     */
    private fun <T> fetch(
        key: String,
        request: suspend (ws: String, start: String, end: String) -> T,
        quiet: Boolean = false,
        apply: (AnalyticsState, T, Pair<String, String>) -> AnalyticsState,
    ) {
        val ws = workspaceId ?: return
        if (key in _state.value.loading) return
        val gen = generation
        val (start, end) = _state.value.range.bounds(clock)
        _state.update { it.copy(loading = it.loading + key, error = if (quiet) it.error else null) }
        viewModelScope.launch {
            try {
                val value = request(ws, start, end)
                if (gen != generation) return@launch
                _state.update { apply(it, value, start to end).copy(locked = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (gen != generation || quiet) return@launch
                if (e is ApiError.Server && e.status == 403) {
                    // The plan no longer carries it: say so, and have the tabs look again.
                    _state.update { it.copy(locked = true) }
                    onLocked()
                } else {
                    _state.update { it.copy(error = e.displayText(language())) }
                }
            } finally {
                if (gen == generation) _state.update { it.copy(loading = it.loading - key) }
            }
        }
    }

    companion object {
        /** The Mac's live-visitors poll. */
        const val LIVE_MS = 30_000L
    }
}
