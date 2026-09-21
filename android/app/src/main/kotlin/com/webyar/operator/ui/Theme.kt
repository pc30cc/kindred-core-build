package com.webyar.operator.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/**
 * A placeholder palette, deliberately small.
 *
 * The real one is a port of `ios/WebyarNative/Sources/DesignSystem/Theme.swift`
 * and belongs to a later step — ADR-003 puts the design system deliberately
 * AFTER the vertical slice, because a theme built before anything uses it gets
 * built twice. The one colour that is not arbitrary is the launch background,
 * which matches iOS exactly so the two platforms open on the same shade.
 */
private val LaunchBackground = Color(0xFF0B1220)

private val DarkColors = darkColorScheme(
    background = LaunchBackground,
    surface = LaunchBackground,
)

private val LightColors = lightColorScheme()

@Composable
fun WebyarTheme(
    dark: Boolean = isSystemInDarkTheme(),
    // Material You, where the platform has it. Off by default: the product is
    // white-label and its colours are the customer's, not the handset's.
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
