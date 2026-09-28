package com.webyar.ai.feature.visitors

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.LiveVisitor
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrInsights
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.DetailRow
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.GroupHeader
import com.webyar.ai.ui.components.InsightGlyph
import com.webyar.ai.ui.components.LatinText
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.components.PillTone
import com.webyar.ai.ui.components.SegmentGap
import com.webyar.ai.ui.components.ShapeFrame
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.components.rememberPressShape
import com.webyar.ai.ui.components.rowTextAlign
import com.webyar.ai.ui.components.segmentedShape
import com.webyar.ai.ui.design.ExpressiveShapes
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
import com.webyar.ai.ui.design.WebyarType
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * One visitor, as the Mac app's inspector shows them: who they are and
 * whether they are here, start or open the chat, where they are and on what,
 * and the pages they have read on the way.
 */
@Composable
fun VisitorDetailScreen(
    visitor: LiveVisitor?,
    now: Instant,
    history: VisitorHistoryState?,
    chatBusy: Boolean,
    language: Language,
    onChat: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    onRetryHistory: () -> Unit = {},
) {
    if (visitor == null) {
        // Reachable: a visitor opened from a map dot the list has not loaded
        // yet, or one restored after the process was away.
        EmptyState(
            icon = InsightGlyph.Globe,
            title = StrInsights.visitorsEmptyTitle(language),
            body = null,
            modifier = modifier.fillMaxSize(),
        )
        return
    }
    val v = visitor
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .padding(bottom = Space.xxl)
            .testTag(A11y.VISITOR_DETAIL),
    ) {
        Identity(v, language)
        Actions(v, chatBusy, language, onChat)
        Facts(v, now, language)
        History(history, now, language, onRetryHistory)
    }
}

@Composable
private fun Identity(v: LiveVisitor, language: Language) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = Space.sm, bottom = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(Modifier.size(HeroSize), contentAlignment = Alignment.Center) {
            ShapeFrame(
                polygon = ExpressiveShapes.softBurst,
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.fillMaxSize(),
            )
            PresenceAvatar(v, HeroSize - 20.dp)
        }
        Text(
            VisitorText.name(v, language),
            style = WebyarType.headlineSmallEmphasized.bidiContent(),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = Space.screenInset),
        )
        when (v.presence) {
            "online" -> StatusPill(StrInsights.visitorOnline(language), tone = PillTone.SUCCESS)
            "idle" -> StatusPill(StrInsights.visitorIdle(language), tone = PillTone.WARNING)
            else -> StatusPill(StrInsights.visitorOffline(language))
        }
    }
}

/** Start the chat — or open it, when there is one — and copy the session id. */
@Composable
private fun Actions(v: LiveVisitor, busy: Boolean, language: Language, onChat: () -> Unit) {
    val context = LocalContext.current
    var copied by remember(v.id) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_800)
            copied = false
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg)
            .padding(bottom = Space.xl)
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val interaction = remember { MutableInteractionSource() }
        Button(
            onClick = onChat,
            enabled = !busy,
            shape = rememberPressShape(interaction),
            interactionSource = interaction,
            contentPadding = PaddingValues(horizontal = Space.xl, vertical = Space.md),
            modifier = Modifier
                .weight(1f)
                .heightIn(min = Size.buttonHeight)
                .testTag(A11y.VISITOR_CHAT),
        ) {
            if (busy) {
                LoadingIndicator(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f), size = 28.dp)
            } else {
                Icon(InsightGlyph.Chat, contentDescription = null, modifier = Modifier.size(20.dp))
                Text(
                    if (v.conversation == null) StrInsights.visitorStartChat(language) else StrInsights.visitorOpenChat(language),
                    style = WebyarType.labelLargeEmphasized,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = Space.sm),
                )
            }
        }
        val copyLabel = if (copied) StrInsights.visitorCopied(language) else StrInsights.visitorCopySession(language)
        FilledTonalIconButton(
            onClick = {
                context.getSystemService(ClipboardManager::class.java)
                    ?.setPrimaryClip(ClipData.newPlainText(StrInsights.visitorCopySession(language), v.id))
                copied = true
            },
            shape = RoundedCornerShape(Radius.lg),
            modifier = Modifier
                .size(Size.buttonHeight)
                .semantics { contentDescription = copyLabel }
                .testTag(A11y.VISITOR_COPY_SESSION),
        ) {
            Icon(if (copied) Icons.Filled.Check else InsightGlyph.Copy, contentDescription = null)
        }
    }
}

/** Where they are, on what, from where, and when they last did anything. */
@Composable
private fun Facts(v: LiveVisitor, now: Instant, language: Language) {
    val browserOs = listOfNotNull(v.browser, v.os).map(String::trim).filter(String::isNotEmpty).joinToString(" · ")
    val referrer = v.referrer?.trim()?.takeIf { it.isNotEmpty() }
    val facts = buildList {
        add(Fact(StrInsights.visitorCurrentPage(language), v.currentPage?.takeIf { it.isNotBlank() } ?: "—", Glyph.Document, latin = true))
        add(
            Fact(
                StrInsights.visitorLocation(language),
                VisitorText.location(v.geo) ?: StrInsights.visitorsUnknownLocation(language),
                Icons.Outlined.LocationOn,
            ),
        )
        v.ipDisplay?.takeIf { it.isNotBlank() }?.let { add(Fact(StrInsights.visitorIp(language), it, InsightGlyph.Network, latin = true)) }
        if (browserOs.isNotEmpty()) add(Fact(StrInsights.visitorBrowserOs(language), browserOs, InsightGlyph.Browser, latin = true))
        v.device?.takeIf { it.isNotBlank() }?.let { add(Fact(StrInsights.visitorDeviceLabel(language), deviceName(it, language), deviceGlyph(it))) }
        add(
            Fact(
                StrInsights.visitorReferrer(language),
                referrer ?: StrInsights.visitorCameFromDirect(language),
                InsightGlyph.Link,
                latin = referrer != null,
            ),
        )
        v.lastActivityAt?.let { add(Fact(StrInsights.visitorLastActivity(language), VisitorText.ago(it, now, language), Glyph.Schedule)) }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg),
        verticalArrangement = Arrangement.spacedBy(SegmentGap),
    ) {
        facts.forEachIndexed { index, fact ->
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = segmentedShape(index, facts.size)) {
                DetailRow(label = fact.label, value = fact.value, latin = fact.latin, icon = fact.icon)
            }
        }
    }
}

private data class Fact(val label: String, val value: String, val icon: ImageVector, val latin: Boolean = false)

private fun deviceName(raw: String, language: Language): String =
    StrInsights.waDeviceOf(raw.trim().lowercase(), language) ?: raw

private fun deviceGlyph(raw: String): ImageVector = when (raw.trim().lowercase()) {
    "mobile", "phone" -> InsightGlyph.Phone
    "tablet" -> InsightGlyph.Tablet
    "desktop" -> InsightGlyph.Desktop
    else -> InsightGlyph.Devices
}

/** The visit on a line: where they came in, where they went, where they are. */
@Composable
private fun History(history: VisitorHistoryState?, now: Instant, language: Language, onRetry: () -> Unit) {
    GroupHeader(StrInsights.visitorPageHistory(language), Modifier.padding(top = Space.sm))
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(Radius.xl),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg)
            .testTag(A11y.VISITOR_HISTORY),
    ) {
        val steps = history?.steps
        when {
            history == null || (history.loading && steps == null) -> Box(
                Modifier.fillMaxWidth().padding(Space.xl),
                contentAlignment = Alignment.Center,
            ) { LoadingIndicator(size = 36.dp) }
            history.failed -> Row(
                Modifier.fillMaxWidth().padding(start = Space.lg, end = Space.sm, top = Space.xs, bottom = Space.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    StrInsights.visitorsErrorTitle(language),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onRetry) { Text(StrInsights.visitorsRetry(language)) }
            }
            steps.isNullOrEmpty() -> Text(
                StrInsights.visitorPageHistoryEmpty(language),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(Space.lg),
            )
            else -> Column(Modifier.padding(start = Space.lg, end = Space.lg, top = Space.lg)) {
                steps.forEachIndexed { i, step -> StepRow(step, last = i == steps.lastIndex, now = now, language = language) }
            }
        }
    }
}

/** A step: a dot on the rail, what it was, its title, its address and when. */
@Composable
private fun StepRow(step: VisitStep, last: Boolean, now: Instant, language: Language) {
    val dot = if (step.current) WebyarTheme.colors.success else MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(14.dp).fillMaxHeight()) {
            if (!last) {
                Box(
                    Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 16.dp)
                        .width(2.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.outlineVariant),
                )
            }
            Box(
                Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 4.dp)
                    .size(10.dp)
                    .background(dot, CircleShape),
            )
        }
        Column(
            Modifier
                .weight(1f)
                .padding(start = Space.md, bottom = Space.lg),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Text(
                step.label,
                style = MaterialTheme.typography.labelMedium,
                color = if (step.current) WebyarTheme.colors.success else WebyarTheme.colors.labelTertiary,
            )
            step.title?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = WebyarType.bodyMediumEmphasized.bidiContent(), color = MaterialTheme.colorScheme.onSurface)
            }
            val url = VisitorText.shortUrl(step.url)
            if (url.isNotEmpty()) {
                LatinText(
                    url,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    align = rowTextAlign(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            step.at?.let {
                Text(
                    VisitorText.ago(it, now, language),
                    style = MaterialTheme.typography.labelSmall,
                    color = WebyarTheme.colors.labelTertiary,
                )
            }
        }
    }
}

private val HeroSize = 104.dp
