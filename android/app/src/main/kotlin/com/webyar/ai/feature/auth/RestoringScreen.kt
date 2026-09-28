package com.webyar.ai.feature.auth

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.ai.R
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.BrandFooterOverlay
import com.webyar.ai.ui.components.BrandPalette

/**
 * What a launch shows while it confirms the session: the Mac app's
 * `SplashView` — the brand mark with a soft blue glow under it, a small
 * spinner, and one quiet line saying what is happening.
 *
 * It follows the system's own splash (the icon on the launch colour) and
 * gives way to the inbox or to sign in. The "WEBYAR AI" signature at the foot
 * is the iOS launch screen's, and it stays exactly where it is into sign in.
 */
@Composable
fun RestoringScreen(language: Language, modifier: Modifier = Modifier) {
    // The launch colour (res/values/colors.xml), in the app's own light or
    // dark — so the hand-over from the system splash is not a change of shade.
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .background(if (dark) LAUNCH_DARK else LAUNCH_LIGHT)
            .testTag(A11y.RESTORING),
    ) {
        // Exactly in the middle, where the system splash put it a moment ago;
        // the spinner and the line hang below it rather than pushing it up.
        Image(
            painter = painterResource(R.drawable.brand_mark),
            contentDescription = null,
            modifier = Modifier
                .align(Alignment.Center)
                .size(MARK)
                // The mark's own corner, so the glow follows its outline
                // rather than a square around it.
                .shadow(
                    elevation = 18.dp,
                    shape = RoundedCornerShape(16.dp),
                    ambientColor = BrandPalette.deep.copy(alpha = 0.35f),
                    spotColor = BrandPalette.deep.copy(alpha = 0.35f),
                ),
        )
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .padding(top = maxHeight / 2 + MARK / 2 + GAP),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(GAP),
        ) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Text(
                StrAndroid.restoringSession(language),
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        BrandFooterOverlay()
    }
}

private val MARK = 72.dp
private val GAP = 18.dp

/** `launch_background`, light and night — iOS's LaunchBackground, the Mac's appBackground. */
private val LAUNCH_LIGHT = Color(0xFFF4F6F9)
private val LAUNCH_DARK = Color(0xFF0C0E14)
