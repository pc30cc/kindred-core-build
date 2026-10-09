package com.webyar.ai.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.ai.R
import com.webyar.ai.core.AppBrand
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.design.Space

/**
 * The brand's two colours, as the launch loader draws them (`BrandPalette`
 * in the iOS app): a deep one and a bright one. WebYar's are its brand kit's
 * turquoise, Deep Turquoise #0B7D6C and Turquoise #16C7A8; RESPOK's are its
 * kit's Signal Deep #D3361A and Signal #FF5A3C (as on iOS; Ink would vanish on
 * the dark launch colour).
 *
 * Read from the resources (`brand_deep`, `brand_bright` in
 * res/values/colors.xml, and in src/respok/res for RESPOK), which the splash
 * and the launch window draw too (drawable/launch_loader.xml): one value per
 * brand, so the system's picture and the app's loader cannot disagree.
 *
 * Brand art, not the interface's theme: the app's own accent stays
 * `ui/design/Colors.kt`'s, the same for both brands (as on Windows and Mac).
 */
object BrandPalette {
    val deep: Color
        @Composable @ReadOnlyComposable get() = colorResource(R.color.brand_deep)
    val bright: Color
        @Composable @ReadOnlyComposable get() = colorResource(R.color.brand_bright)
}

/**
 * WebYar's "WEBYAR AI", small and letter-spaced: the name in the label's
 * quiet grey, the "AI" in the brand's two colours. The iOS app's
 * `BrandFooter`. RESPOK's is its name alone ([AppBrand.wordmark],
 * [AppBrand.wordmarkSuffix]).
 *
 * The product's signature on the screens that come before the app proper —
 * the loading screen, sign in and password reset — placed with
 * [BrandFooterOverlay] so that it is in the same spot on all three.
 *
 * Latin in every language — it is the mark, not prose — so it is pinned
 * left-to-right; a right-to-left layout would set it as "AI WEBYAR".
 */
@Composable
fun BrandFooter(modifier: Modifier = Modifier) {
    val style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = TRACKING.sp)
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            // Tracking adds its space after the last letter too, which would
            // sit the centred name half a letter to the left.
            modifier
                .padding(start = TRACKING.dp)
                // Read as the one name it is, not as two words TalkBack stops on.
                .semantics(mergeDescendants = true) {}
                .testTag(A11y.BRAND_FOOTER),
            horizontalArrangement = Arrangement.spacedBy((TRACKING * 1.6f).dp),
        ) {
            Text(AppBrand.wordmark, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AppBrand.wordmarkSuffix?.let { suffix ->
                Text(
                    suffix,
                    style = style.copy(brush = Brush.linearGradient(listOf(BrandPalette.deep, BrandPalette.bright))),
                )
            }
        }
    }
}

/**
 * Signs the screen with [BrandFooter]: centred, [Space.xl] above the bottom
 * of the navigation bar.
 *
 * Fixed to the screen rather than carried by its content, and under the
 * keyboard rather than riding up on it: it is a signature, not part of the
 * form, and a name floating over the keyboard is one more thing between the
 * operator and the field they are typing in. It takes no touches. A screen
 * that scrolls ends its content with [BrandFooterClearance] of room, so the
 * last control never comes to rest under the name.
 */
@Composable
fun BrandFooterOverlay(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize()) {
        BrandFooter(
            Modifier
                .align(Alignment.BottomCenter)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(bottom = Space.xl),
        )
    }
}

/** The footer's line and the gap under it, for a scrolling screen to leave clear. */
val BrandFooterClearance: Dp = Space.xl + Space.lg + 16.dp

private const val TRACKING = 3f
