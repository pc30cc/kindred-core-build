package com.webyar.operator.feature.analytics

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GeoSize
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.operator.core.model.AnalyticsOverview
import com.webyar.operator.core.model.AnalyticsRows
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrInsights
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.ChoiceButton
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.InsightGlyph
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.ui.components.OsGlyph
import com.webyar.operator.ui.components.OsKind
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType
import java.time.LocalDate
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

/**
 * The report picked in the list: the overview's numbers and trend, or one
 * breakdown, laid out as a column of cards — the Mac app's dashboard, one
 * card wide.
 */
@Composable
fun AnalyticsReportScreen(
    section: AnalyticsSection,
    state: AnalyticsState,
    language: Language,
    onRange: (AnalyticsRange) -> Unit,
    onSourceDimension: (String) -> Unit,
    onPagesKind: (String) -> Unit,
    onGeoDimension: (String) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    /** The list beside it already has the range; a phone's pushed page carries its own. */
    showRange: Boolean = true,
    contentPadding: PaddingValues = PaddingValues(),
) {
    if (state.locked) {
        EmptyState(
            icon = Icons.Filled.Lock,
            title = StrInsights.waLocked(language),
            body = StrInsights.waLockedHint(language),
            modifier = modifier.fillMaxSize().padding(contentPadding).testTag(A11y.ANALYTICS_LOCKED),
        )
        return
    }
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .padding(horizontal = Space.lg)
            .padding(bottom = Space.xxl),
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        Header(section, state.range, language)
        if (showRange) RangePicker(state.range, language, onRange)
        state.error?.let { ErrorBanner(it, language, onRetry) }
        if (state.truncated(section)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Text(StrInsights.waTruncated(language), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        when (section) {
            AnalyticsSection.OVERVIEW -> Overview(state, language)
            AnalyticsSection.SOURCES -> Sources(state, language, onSourceDimension)
            AnalyticsSection.PAGES -> Pages(state, language, onPagesKind)
            AnalyticsSection.GEOGRAPHY -> Geography(state, language, onGeoDimension)
            AnalyticsSection.TECHNOLOGY -> Technology(state, language)
            AnalyticsSection.EVENTS -> Events(state, language)
        }
    }
}

@Composable
private fun Header(section: AnalyticsSection, range: AnalyticsRange, language: Language) {
    val tint = section.tint()
    Row(Modifier.padding(top = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(40.dp).background(tint.copy(alpha = 0.14f), RoundedCornerShape(Radius.md)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(section.icon(), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.padding(start = Space.md)) {
            Text(section.title(language), style = WebyarType.titleLargeEmphasized)
            Text(
                section.hint(language) + " · " + rangeLabel(range, language),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ErrorBanner(message: String, language: Language, onRetry: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer, shape = RoundedCornerShape(Radius.lg)) {
        Row(Modifier.padding(start = Space.lg, end = Space.xs, top = Space.xs, bottom = Space.xs), verticalAlignment = Alignment.CenterVertically) {
            Text(message, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onRetry) { Text(StrInsights.visitorsRetry(language)) }
        }
    }
}

// MARK: - Overview

@Composable
private fun Overview(state: AnalyticsState, language: Language) {
    val o = state.overview
    val p = state.previous
    val vs = StrInsights.waVsPrevious(language, AnalyticsFormat.count(state.range.days, language))
    val tiles = listOf(
        Kpi("visitors", InsightGlyph.People, MaterialTheme.colorScheme.primary, StrInsights.waVisitors(language),
            o?.let { AnalyticsFormat.count(it.uniqueVisitors ?: 0, language) },
            AnalyticsFormat.change(o?.uniqueVisitors?.toDouble(), p?.uniqueVisitors?.toDouble())),
        Kpi("sessions", InsightGlyph.Layers, Color(0xFF6E56CF), StrInsights.waSessions(language),
            o?.let { AnalyticsFormat.count(it.sessions ?: 0, language) },
            AnalyticsFormat.change(o?.sessions?.toDouble(), p?.sessions?.toDouble())),
        Kpi("pageviews", InsightGlyph.Eye, Color(0xFF0EA5A4), StrInsights.waPageviews(language),
            o?.let { AnalyticsFormat.count(it.pageviews ?: 0, language) },
            AnalyticsFormat.change(o?.pageviews?.toDouble(), p?.pageviews?.toDouble())),
        Kpi("pagesPerSession", InsightGlyph.Copy, Color(0xFF30A46C), StrInsights.waPagesPerSession(language),
            o?.let { AnalyticsFormat.decimal(it.avgPagesPerSession ?: 0.0, language) },
            AnalyticsFormat.change(o?.avgPagesPerSession, p?.avgPagesPerSession)),
        Kpi("bounceRate", InsightGlyph.TurnBack, Color(0xFFF76B15), StrInsights.waBounceRate(language),
            o?.let { AnalyticsFormat.percent((it.bounceRate ?: 0.0) / 100.0, language) },
            AnalyticsFormat.change(o?.bounceRate, p?.bounceRate), higherIsBetter = false),
        Kpi("avgDuration", Glyph.Schedule, Color(0xFFD6409F), StrInsights.waAvgDuration(language),
            o?.let { AnalyticsFormat.duration(it.avgVisitDurationSeconds ?: 0.0, language) },
            AnalyticsFormat.change(o?.avgVisitDurationSeconds, p?.avgVisitDurationSeconds)),
    )
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        tiles.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                pair.forEach { KpiTile(it, language, vs, Modifier.weight(1f)) }
            }
        }
    }
    TrendCard(o, state.range, state.isLoading("overview"), language)
    val sources = AnalyticsSection.SOURCES.tint()
    AnalyticsCard(StrInsights.waTopChannels(language), InsightGlyph.Split, sources) {
        BarList(
            items = o?.topChannels.orEmpty().map { BarItem(it.key, AnalyticsFormat.channel(it.key, language), it.sessions ?: 0) },
            loading = o == null,
            language = language,
            limit = 6,
            tint = sources,
        )
    }
    val pages = AnalyticsSection.PAGES.tint()
    AnalyticsCard(StrInsights.waTopPages(language), Glyph.Document, pages) {
        BarList(
            items = o?.topPages.orEmpty().map { BarItem(it.path, it.path, it.views ?: 0, latin = true) },
            loading = o == null,
            language = language,
            limit = 6,
            tint = pages,
        )
    }
}

private data class Kpi(
    val wire: String,
    val icon: ImageVector,
    val tint: Color,
    val label: String,
    val value: String?,
    val change: Double?,
    val higherIsBetter: Boolean = true,
)

/** A headline number: its icon on a soft tint, the change from before, the value large, the label under it. */
@Composable
private fun KpiTile(k: Kpi, language: Language, changeHelp: String, modifier: Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(Radius.lg),
        modifier = modifier.testTag(A11y.analyticsKpi(k.wire)),
    ) {
        Column(Modifier.padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(30.dp).background(k.tint.copy(alpha = 0.14f), CircleShape), contentAlignment = Alignment.Center) {
                    Icon(k.icon, contentDescription = null, tint = k.tint, modifier = Modifier.size(16.dp))
                }
                Spacer(Modifier.weight(1f))
                if (k.change != null && k.value != null) ChangeChip(k.change, k.higherIsBetter, language, changeHelp)
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (k.value != null) {
                    // A duration is the longest value a tile holds; it steps down a size rather than being cut.
                    val size = if (k.value.length > 9) 18.sp else 22.sp
                    Text(k.value, style = WebyarType.titleLargeEmphasized.copy(fontSize = size), maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else {
                    Box(Modifier.width(72.dp).height(26.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(6.dp)))
                }
                Text(k.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** "↗ 12%": green when the number moved the good way, red when the bad way, grey when flat. */
@Composable
private fun ChangeChip(change: Double, higherIsBetter: Boolean, language: Language, help: String) {
    val flat = abs(change) < 0.005
    val good = (change > 0) == higherIsBetter
    val color = when {
        flat -> MaterialTheme.colorScheme.onSurfaceVariant
        good -> WebyarTheme.colors.success
        else -> MaterialTheme.colorScheme.error
    }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            Modifier
                .background(color.copy(alpha = 0.12f), RoundedCornerShape(Radius.pill))
                .padding(horizontal = 7.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Icon(
                when {
                    flat -> InsightGlyph.Equal
                    change > 0 -> InsightGlyph.TrendUp
                    else -> InsightGlyph.TrendDown
                },
                contentDescription = help,
                tint = color,
                modifier = Modifier.size(12.dp),
            )
            Text(AnalyticsFormat.percent(abs(change), language), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = color)
        }
    }
}

/** Visits or page views, day by day; touching the chart calls out the day under the finger. */
@Composable
private fun TrendCard(overview: AnalyticsOverview?, range: AnalyticsRange, loading: Boolean, language: Language) {
    var showViews by rememberSaveable { mutableStateOf(false) }
    var selected by remember(overview) { mutableStateOf<Int?>(null) }
    val tint = MaterialTheme.colorScheme.primary
    val points = remember(overview, range, showViews) {
        val (start, end) = range.bounds()
        AnalyticsFormat.fillDays(overview?.trend.orEmpty(), start, end).mapNotNull { d ->
            AnalyticsFormat.day(d.date)?.let { it to ((if (showViews) d.pageviews else d.sessions) ?: 0) }
        }
    }
    AnalyticsCard(StrInsights.waTrend(language), InsightGlyph.ShowChart, tint) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            ChoiceButton(StrInsights.waSessions(language), !showViews, language, { showViews = false }, Modifier.weight(1f))
            ChoiceButton(StrInsights.waPageviews(language), showViews, language, { showViews = true }, Modifier.weight(1f))
        }
        when {
            overview == null -> Box(
                Modifier.fillMaxWidth().height(200.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(Radius.md)),
                contentAlignment = Alignment.Center,
            ) { if (loading) LoadingIndicator(size = 36.dp) }
            points.all { it.second == 0 } -> SmallEmpty(InsightGlyph.ShowChart, StrInsights.waNoData(language), StrInsights.waNoDataHint(language))
            else -> {
                // The day under the finger, or nothing: a line over the chart rather than a
                // callout inside it, which a phone's thumb would be covering.
                val sel = selected?.let { points.getOrNull(it) }
                Text(
                    sel?.let {
                        AnalyticsFormat.dayLabel(it.first, language, long = true) + " · " +
                            AnalyticsFormat.count(it.second, language) + " " +
                            (if (showViews) StrInsights.waViews(language) else StrInsights.waVisitsUnit(language))
                    } ?: " ",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                TrendChart(points, selected, tint, language, onSelect = { selected = it })
            }
        }
    }
}

@Composable
private fun TrendChart(
    points: List<Pair<LocalDate, Int>>,
    selected: Int?,
    tint: Color,
    language: Language,
    onSelect: (Int?) -> Unit,
) {
    val measurer = rememberTextMeasurer()
    val axis = TextStyle(fontSize = 10.sp, color = WebyarTheme.colors.labelTertiary)
    val grid = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
    val rule = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
    val surface = MaterialTheme.colorScheme.surfaceContainerLow
    val top = niceCeiling(points.maxOf { it.second })
    val ticks = (0..4).map { top * it / 4 }
    val yLabels = remember(top, language) { ticks.map { AnalyticsFormat.count(it, language) } }
    val xIndices = remember(points.size) {
        if (points.size <= 1) listOf(0) else (0 until 5).map { (it * (points.size - 1) / 4f).toInt() }.distinct()
    }
    val xLabels = remember(points, language) { xIndices.associateWith { AnalyticsFormat.dayLabel(points[it].first, language) } }

    // Time runs left to right in every language, as on the web and the Mac.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(210.dp)
                .testTag(A11y.ANALYTICS_CHART)
                .pointerInput(points.size) {
                    detectTapGestures { onSelect(chartIndex(it.x, size.width.toFloat(), density, points.size)) }
                }
                .pointerInput(points.size) {
                    detectHorizontalDragGestures { change, _ ->
                        onSelect(chartIndex(change.position.x, size.width.toFloat(), density, points.size))
                    }
                },
        ) {
            val left = 40.dp.toPx()
            val right = 8.dp.toPx()
            val bottom = 22.dp.toPx()
            val topPad = 8.dp.toPx()
            val w = size.width - left - right
            val h = size.height - bottom - topPad
            fun x(i: Int) = left + if (points.size <= 1) w / 2 else w * i / (points.size - 1)
            fun y(v: Int) = topPad + h - h * v / top.toFloat()

            ticks.forEachIndexed { i, t ->
                val yy = y(t)
                drawLine(grid, Offset(left, yy), Offset(size.width - right, yy), strokeWidth = 1f)
                val label = measurer.measure(yLabels[i], axis)
                drawText(label, topLeft = Offset(left - label.size.width - 6.dp.toPx(), yy - label.size.height / 2f))
            }
            xLabels.forEach { (i, text) ->
                val label = measurer.measure(text, axis)
                val cx = (x(i) - label.size.width / 2f).coerceIn(left - label.size.width / 2f, size.width - label.size.width)
                drawText(label, topLeft = Offset(cx, size.height - label.size.height))
            }

            val line = Path()
            points.forEachIndexed { i, (_, v) ->
                val px = x(i)
                val py = y(v)
                if (i == 0) {
                    line.moveTo(px, py)
                } else {
                    // Mid-point control points: smooth, and never overshooting
                    // below zero the way a free spline would.
                    val prevX = x(i - 1)
                    val prevY = y(points[i - 1].second)
                    val mid = (prevX + px) / 2f
                    line.cubicTo(mid, prevY, mid, py, px, py)
                }
            }
            val area = Path().apply {
                addPath(line)
                lineTo(x(points.lastIndex), topPad + h)
                lineTo(x(0), topPad + h)
                close()
            }
            drawPath(area, Brush.verticalGradient(listOf(tint.copy(alpha = 0.26f), tint.copy(alpha = 0.02f)), startY = topPad, endY = topPad + h))
            drawPath(line, tint, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))

            selected?.takeIf { it in points.indices }?.let { i ->
                val px = x(i)
                drawLine(rule, Offset(px, topPad), Offset(px, topPad + h), strokeWidth = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)))
                val py = y(points[i].second)
                drawCircle(surface, radius = 6.dp.toPx(), center = Offset(px, py))
                drawCircle(tint, radius = 4.5.dp.toPx(), center = Offset(px, py))
            }
        }
    }
}

/** The day nearest [x] on a chart [width] wide, with the axis's 40dp on the left. */
private fun chartIndex(x: Float, width: Float, density: Float, count: Int): Int {
    val left = 40f * density
    val w = width - left - 8f * density
    if (count <= 1 || w <= 0f) return 0
    return Math.round((x - left) / w * (count - 1)).coerceIn(0, count - 1)
}

/** 1, 2, 5 × 10ⁿ at or above [max], so the grid lines land on round numbers. */
private fun niceCeiling(max: Int): Int {
    if (max <= 4) return 4
    val magnitude = 10.0.pow(ceil(log10(max.toDouble())) - 1)
    for (step in listOf(1.0, 2.0, 2.5, 5.0, 10.0)) {
        val candidate = (ceil(max / (step * magnitude)) * step * magnitude).toInt()
        if (candidate % 4 == 0 && candidate >= max) return candidate
    }
    return ((max + 3) / 4) * 4
}

// MARK: - Breakdowns

@Composable
private fun Sources(state: AnalyticsState, language: Language, onDimension: (String) -> Unit) {
    val tint = AnalyticsSection.SOURCES.tint()
    val dim = state.sourceDimension
    val result = state.breakdowns[state.sourcesKey]
    val rows = result?.rows.orEmpty().map { r ->
        BarItem(
            id = r.key,
            label = if (dim == "channel") AnalyticsFormat.channel(r.key, language) else AnalyticsFormat.unknown(r.label ?: r.key, language),
            value = r.sessions ?: 0,
            secondary = r.pageviews?.let { AnalyticsFormat.count(it, language) + " " + StrInsights.waViews(language) },
            latin = dim != "channel",
        )
    }
    if (result != null && rows.isNotEmpty()) InsightStrip(rows, StrInsights.waTotal(language), tint, language)
    AnalyticsCard(StrInsights.waSources(language), InsightGlyph.Split, tint) {
        Dimensions(
            listOf("channel" to StrInsights.waChannel(language), "source" to StrInsights.waSource(language), "campaign" to StrInsights.waCampaign(language)),
            dim, language, onDimension,
        )
        BarList(rows, loading = result == null, language = language, limit = 25, tint = tint)
    }
}

@Composable
private fun Pages(state: AnalyticsState, language: Language, onKind: (String) -> Unit) {
    val tint = AnalyticsSection.PAGES.tint()
    val result = state.pageLists[state.pagesKey]
    val rows = result?.rows.orEmpty().map { BarItem(it.path, it.path, it.views ?: 0, latin = true) }
    if (result != null && rows.isNotEmpty()) InsightStrip(rows, StrInsights.waPageviews(language), tint, language)
    AnalyticsCard(StrInsights.waPages(language), Glyph.Document, tint) {
        Dimensions(
            listOf("top" to StrInsights.waPagesTop(language), "entry" to StrInsights.waPagesEntry(language), "exit" to StrInsights.waPagesExit(language)),
            state.pagesKind, language, onKind,
        )
        BarList(rows, loading = result == null, language = language, limit = 25, tint = tint)
    }
}

@Composable
private fun Geography(state: AnalyticsState, language: Language, onDimension: (String) -> Unit) {
    val tint = AnalyticsSection.GEOGRAPHY.tint()
    val dim = state.geoDimension
    val result = state.breakdowns[state.geoKey]
    val rows = result?.rows.orEmpty().map { r ->
        val raw = r.label ?: r.key
        when (dim) {
            "country" -> {
                val (flag, name) = AnalyticsFormat.country(raw, language)
                BarItem(r.key, AnalyticsFormat.unknown(name, language), r.sessions ?: 0, leading = flag)
            }
            "language" -> BarItem(r.key, AnalyticsFormat.unknown(AnalyticsFormat.language(raw, language), language), r.sessions ?: 0)
            else -> BarItem(r.key, AnalyticsFormat.unknown(raw, language), r.sessions ?: 0)
        }
    }
    if (result != null && rows.isNotEmpty()) InsightStrip(rows, StrInsights.waTotal(language), tint, language)
    AnalyticsCard(StrInsights.waGeography(language), InsightGlyph.Globe, tint) {
        Dimensions(
            listOf("country" to StrInsights.waCountry(language), "city" to StrInsights.waCity(language), "language" to StrInsights.waLanguage(language)),
            dim, language, onDimension,
        )
        BarList(rows, loading = result == null, language = language, limit = 25, tint = tint)
    }
}

@Composable
private fun Technology(state: AnalyticsState, language: Language) {
    val tint = AnalyticsSection.TECHNOLOGY.tint()
    TechCard(state.breakdowns["tech.device"], StrInsights.waDevice(language), InsightGlyph.Devices, tint, language, symbol = ::deviceGlyph) {
        AnalyticsFormat.device(it, language)
    }
    TechCard(state.breakdowns["tech.os"], StrInsights.waOs(language), InsightGlyph.Desktop, tint, language, os = true)
    TechCard(state.breakdowns["tech.browser"], StrInsights.waBrowser(language), InsightGlyph.Browser, tint, language)
}

@Composable
private fun TechCard(
    result: AnalyticsRows?,
    title: String,
    icon: ImageVector,
    tint: Color,
    language: Language,
    symbol: ((String) -> ImageVector)? = null,
    os: Boolean = false,
    name: ((String) -> String)? = null,
) {
    val rows = result?.rows.orEmpty().map { r ->
        BarItem(
            id = r.key,
            label = AnalyticsFormat.unknown(name?.invoke(r.key) ?: r.label ?: r.key, language),
            value = r.sessions ?: 0,
            symbol = symbol?.invoke(r.key),
            os = if (os) OsKind.resolve(r.key) else null,
        )
    }
    AnalyticsCard(title, icon, tint) {
        BarList(rows, loading = result == null, language = language, limit = 8, tint = tint)
    }
}

private fun deviceGlyph(key: String): ImageVector {
    val k = key.lowercase()
    return when {
        "mobile" in k || "phone" in k -> InsightGlyph.Phone
        "tablet" in k || "ipad" in k -> InsightGlyph.Tablet
        else -> InsightGlyph.Desktop
    }
}

@Composable
private fun Events(state: AnalyticsState, language: Language) {
    val tint = AnalyticsSection.EVENTS.tint()
    val events = state.events
    val rows = events?.rows.orEmpty()
    val best = max(0.0001, rows.mapNotNull { it.conversionRate }.maxOrNull() ?: 0.0)
    AnalyticsCard(StrInsights.waEvents(language), InsightGlyph.TouchApp, tint) {
        when {
            events == null -> Box(Modifier.fillMaxWidth().heightIn(min = 120.dp), contentAlignment = Alignment.Center) {
                LoadingIndicator(size = 36.dp)
            }
            rows.isEmpty() -> SmallEmpty(InsightGlyph.TouchApp, StrInsights.waNoEvents(language), StrInsights.waNoEventsHint(language))
            else -> Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
                rows.forEach { e ->
                    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            LatinText(
                                e.eventName,
                                style = WebyarType.bodyMediumEmphasized,
                                maxLines = 1,
                                align = rowTextAlign(),
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                AnalyticsFormat.percent(e.conversionRate ?: 0.0, language),
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.SemiBold,
                                color = tint,
                                modifier = Modifier.padding(start = Space.sm),
                            )
                        }
                        Text(
                            StrInsights.waEventCount(language) + ": " + AnalyticsFormat.count(e.count ?: 0, language) + "   ·   " +
                                StrInsights.waEventSessions(language) + ": " + AnalyticsFormat.count(e.uniqueSessions ?: 0, language) + "   ·   " +
                                StrInsights.waConversion(language),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        ShareBar((e.conversionRate ?: 0.0) / best, tint)
                    }
                }
            }
        }
    }
}

// MARK: - Pieces

/** A card with a small coloured icon and a title over its content. */
@Composable
private fun AnalyticsCard(title: String, icon: ImageVector, tint: Color, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(Radius.xl), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
                Text(title, style = WebyarType.titleMediumEmphasized)
            }
            content()
        }
    }
}

/** The report's dimension, on the pages that have several. */
@Composable
private fun Dimensions(options: List<Pair<String, String>>, selected: String, language: Language, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
        options.forEach { (wire, label) ->
            ChoiceButton(label, wire == selected, language, { onSelect(wire) }, Modifier.weight(1f))
        }
    }
}

/** One line of a ranked list. */
private data class BarItem(
    val id: String,
    val label: String,
    val value: Int,
    val secondary: String? = null,
    /** A flag before the label. */
    val leading: String? = null,
    val symbol: ImageVector? = null,
    val os: OsKind? = null,
    /** Addresses and campaign names read left to right in every language. */
    val latin: Boolean = false,
)

/** A ranked list: each line's label, count and share over a bar showing it against the first. */
@Composable
private fun BarList(items: List<BarItem>, loading: Boolean, language: Language, limit: Int, tint: Color) {
    when {
        loading -> Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
            repeat(4) {
                Box(Modifier.fillMaxWidth().height(22.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(6.dp)))
            }
        }
        items.isEmpty() -> SmallEmpty(InsightGlyph.BarChart, StrInsights.waNoData(language), StrInsights.waNoDataHint(language))
        else -> {
            val total = max(1, items.sumOf { it.value })
            val top = max(1, items.maxOf { it.value })
            Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
                items.take(limit).forEach { item ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            item.leading?.let { Text(it, fontSize = 15.sp) }
                            item.symbol?.let {
                                Icon(it, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                            }
                            item.os?.let { kind ->
                                val px = with(androidx.compose.ui.platform.LocalDensity.current) { 16.dp.toPx() }
                                OsGlyph(kind, px, Modifier.size(16.dp))
                            }
                            if (item.latin) {
                                LatinText(item.label, style = WebyarType.bodyMediumEmphasized, maxLines = 1, align = rowTextAlign(), modifier = Modifier.weight(1f))
                            } else {
                                Text(
                                    item.label,
                                    style = WebyarType.bodyMediumEmphasized.bidiContent(),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            item.secondary?.let {
                                Text(it, style = MaterialTheme.typography.labelSmall, color = WebyarTheme.colors.labelTertiary, maxLines = 1)
                            }
                            Text(AnalyticsFormat.count(item.value, language), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                            Text(
                                AnalyticsFormat.percent(item.value.toDouble() / total, language),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.End,
                                modifier = Modifier.widthIn(min = 40.dp),
                            )
                        }
                        ShareBar(item.value.toDouble() / top, tint)
                    }
                }
            }
        }
    }
}

/** A thin rounded bar, filled to [fraction] (0–1) from the reading edge. */
@Composable
private fun ShareBar(fraction: Double, tint: Color) {
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Canvas(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(Radius.pill))) {
        val r = CornerRadius(size.height / 2, size.height / 2)
        drawRoundRect(track, cornerRadius = r)
        val w = max(size.height, size.width * fraction.coerceIn(0.0, 1.0).toFloat())
        val start = if (rtl) size.width - w else 0f
        drawRoundRect(
            Brush.horizontalGradient(listOf(tint.copy(alpha = 0.75f), tint), startX = start, endX = start + w),
            topLeft = Offset(start, 0f),
            size = GeoSize(w, size.height),
            cornerRadius = r,
        )
    }
}

/** The total, the line in first place and how many lines there are, over a ranked report. */
@Composable
private fun InsightStrip(items: List<BarItem>, totalLabel: String, tint: Color, language: Language) {
    val total = items.sumOf { it.value }
    val lead = items.maxByOrNull { it.value }
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            InsightTile(InsightGlyph.Sum, totalLabel, tint, Modifier.weight(1f)) {
                Text(AnalyticsFormat.count(total, language), style = WebyarType.titleLargeEmphasized)
            }
            InsightTile(InsightGlyph.Numbered, StrInsights.waDistinct(language), tint, Modifier.weight(1f)) {
                Text(AnalyticsFormat.count(items.size, language), style = WebyarType.titleLargeEmphasized)
            }
        }
        if (lead != null) {
            InsightTile(InsightGlyph.Crown, StrInsights.waLeader(language), tint, Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    lead.leading?.let { Text(it, fontSize = 16.sp) }
                    if (lead.latin) {
                        LatinText(lead.label, style = WebyarType.titleMediumEmphasized, maxLines = 1, align = rowTextAlign(), modifier = Modifier.weight(1f, fill = false))
                    } else {
                        Text(
                            lead.label,
                            style = WebyarType.titleMediumEmphasized.bidiContent(),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    Text(
                        AnalyticsFormat.percent(lead.value.toDouble() / max(1, total), language),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun InsightTile(icon: ImageVector, label: String, tint: Color, modifier: Modifier, value: @Composable () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(Radius.lg), modifier = modifier) {
        Row(Modifier.padding(Space.md), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).background(tint.copy(alpha = 0.14f), RoundedCornerShape(Radius.sm)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            }
            Column(Modifier.padding(start = Space.md)) {
                value()
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        }
    }
}

@Composable
private fun SmallEmpty(icon: ImageVector, title: String, body: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(22.dp))
        }
        Text(title, style = WebyarType.bodyLargeEmphasized, modifier = Modifier.padding(top = Space.xs))
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
