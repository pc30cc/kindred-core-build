package com.webyar.ai.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.BrandFooterOverlay
import com.webyar.ai.ui.components.LaunchLoader

/**
 * What a launch shows while it confirms the session: the iOS app's
 * `LaunchView` — the launch colour, the loader turning in the middle, and the
 * "WEBYAR AI" signature at the foot. No mark, no line of text.
 *
 * It follows the system splash, which shows the same loader at rest in the
 * same place (res/drawable/launch_loader.xml), so the hand-over is the
 * loader starting to turn. The signature stays exactly where it is into sign
 * in.
 */
@Composable
fun RestoringScreen(language: Language, modifier: Modifier = Modifier) {
    // The launch colour (res/values/colors.xml), in the app's own light or
    // dark — so the hand-over from the system splash is not a change of shade.
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    Box(
        modifier
            .fillMaxSize()
            .background(if (dark) LAUNCH_DARK else LAUNCH_LIGHT)
            .semantics { contentDescription = StrAndroid.restoringSession(language) }
            .testTag(A11y.RESTORING),
    ) {
        // Centred on the whole screen, not on the space between the bars:
        // that is where the system splash centres it.
        LaunchLoader(Modifier.align(Alignment.Center))
        BrandFooterOverlay()
    }
}

/** `launch_background`, light and night — iOS's LaunchBackground, the Mac's appBackground. */
private val LAUNCH_LIGHT = Color(0xFFF4F6F9)
private val LAUNCH_DARK = Color(0xFF0C0E14)
