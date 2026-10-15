package com.platform.app.feature.auth

import android.app.Activity
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.platform.app.core.model.MaintenanceNotice
import com.platform.app.i18n.BrandStr
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.components.PrimaryButton
import com.platform.app.ui.components.ShapeFrame
import com.platform.app.ui.design.ExpressiveShapes
import com.platform.app.ui.design.Radius
import com.platform.app.ui.design.Space
import com.platform.app.ui.design.AppTheme
import com.platform.app.ui.design.AppType
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

/**
 * Super Admin's maintenance notice, over the whole app — the sign-in screen
 * and the signed-in shell alike — while the platform says it is down: the
 * Mac app's `MaintenanceOverlay`. What is going on, in the operator's
 * language; until when, if Super Admin said; and Try again, which asks at
 * once rather than at the next minute's check.
 *
 * Nothing beneath takes a tap, a key or a Back meanwhile — Back leaves the
 * app, as it would from its first screen. The caller blurs what is beneath,
 * so it is plain the app will be back as it was.
 */
@Composable
fun MaintenanceOverlay(
    notice: MaintenanceNotice,
    language: Language,
    checking: Boolean,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    // A half-typed password must not keep the keyboard, or its keys, open
    // under the notice.
    LaunchedEffect(Unit) { focus.clearFocus(force = true) }
    BackHandler { (context as? Activity)?.moveTaskToBack(true) }
    // Past its end time the notice is off by itself: asked again then, not
    // at the next minute's check.
    val until = notice.untilInstant
    LaunchedEffect(until) {
        if (until == null) return@LaunchedEffect
        val wait = Duration.between(Instant.now(), until).toMillis()
        if (wait > 0) delay(wait)
        onRetry()
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            // A veil over the app beneath: light enough that it shows through
            // blurred (Android 12 and later), heavy enough to read the card
            // over it unblurred.
            .background(MaterialTheme.colorScheme.surface.copy(alpha = if (Build.VERSION.SDK_INT >= 31) 0.55f else 0.88f))
            // Every tap lands here, never on the app beneath.
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics {
                isTraversalGroup = true
                paneTitle = BrandStr.maintenanceTitle(language)
            }
            .testTag(A11y.MAINTENANCE)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        // Centred, and scrolling only when a large font needs it to.
        Box(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                shape = RoundedCornerShape(Radius.xl),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shadowElevation = 12.dp,
                modifier = Modifier
                    .padding(Space.xl)
                    .widthIn(max = 440.dp)
                    .fillMaxWidth(),
            ) {
                NoticeCard(notice, language, checking, onRetry)
            }
        }
    }
}

@Composable
private fun NoticeCard(
    notice: MaintenanceNotice,
    language: Language,
    checking: Boolean,
    onRetry: () -> Unit,
) {
    val warning = AppTheme.colors.warning
    Column(
        Modifier.padding(horizontal = Space.xxl, vertical = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        ShapeFrame(
            polygon = ExpressiveShapes.cookie4,
            color = warning.copy(alpha = 0.14f),
            modifier = Modifier.size(84.dp),
        ) {
            Icon(Glyph.Build, contentDescription = null, tint = warning, modifier = Modifier.size(34.dp))
        }
        Text(
            BrandStr.maintenanceTitle(language),
            style = AppType.titleLargeEmphasized,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Space.sm),
        )
        Text(
            notice.message(language) ?: StrAndroid.maintenanceBody(language),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        notice.untilInstant?.let { until ->
            Row(
                Modifier
                    .background(warning.copy(alpha = 0.12f), RoundedCornerShape(Radius.pill))
                    .padding(horizontal = Space.md, vertical = Space.xs + Space.xxs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.xs + Space.xxs),
            ) {
                Icon(Glyph.Schedule, contentDescription = null, tint = warning, modifier = Modifier.size(16.dp))
                Text(
                    StrAndroid.maintenanceUntil(language, Format.timeOrDateTime(until, language)),
                    style = MaterialTheme.typography.labelLarge,
                    color = warning,
                )
            }
        }
        PrimaryButton(
            label = Str.retry(language),
            onClick = onRetry,
            busy = checking,
            modifier = Modifier
                .padding(top = Space.md)
                .testTag(A11y.MAINTENANCE_RETRY),
        )
    }
}
