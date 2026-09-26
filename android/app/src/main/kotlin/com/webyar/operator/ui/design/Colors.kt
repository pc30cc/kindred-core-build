package com.webyar.operator.ui.design

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The brand tint, and the Material 3 roles built around it.
 *
 * The two brand values are the same ones the iOS app uses — `Theme.swift`
 * writes them as `UIColor(red: 0.231, green: 0.478, blue: 0.949)` for light
 * and `(0.353, 0.580, 1.0)` for dark, which are these. Everything else is an
 * Android palette rather than a translation of Apple's semantic colours,
 * because Material 3 has its own set of roles and half-filling them produces a
 * scheme that looks broken in exactly the places nobody previews.
 *
 * The neutrals are deliberately cool-grey rather than tinted with the brand
 * hue. Material's own generator would tint them, and on a screen that is
 * mostly white cards holding other people's words that reads as a lilac cast
 * over the whole product — which is what the first build of this app looked
 * like.
 */
private val BrandLight = Color(0xFF3B7AF2)
private val BrandDark = Color(0xFF5A94FF)

internal val WebyarLightColors = lightColorScheme(
    primary = BrandLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6FF),
    onPrimaryContainer = Color(0xFF001945),
    inversePrimary = BrandDark,

    secondary = Color(0xFF565E71),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDAE2F9),
    onSecondaryContainer = Color(0xFF131B2C),

    tertiary = Color(0xFF705574),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFAD8FC),
    onTertiaryContainer = Color(0xFF28132E),

    error = Color(0xFFBA1A1A),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),

    background = Color(0xFFFDFBFF),
    onBackground = Color(0xFF1A1C1E),
    surface = Color(0xFFFDFBFF),
    onSurface = Color(0xFF1A1C1E),
    surfaceVariant = Color(0xFFE0E2EC),
    onSurfaceVariant = Color(0xFF43474E),

    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF7F9FC),
    surfaceContainer = Color(0xFFF1F4F9),
    surfaceContainerHigh = Color(0xFFEBEEF3),
    surfaceContainerHighest = Color(0xFFE5E8ED),

    outline = Color(0xFF73777F),
    outlineVariant = Color(0xFFC3C6CF),

    inverseSurface = Color(0xFF2F3033),
    inverseOnSurface = Color(0xFFF1F0F4),
    scrim = Color(0xFF000000),
)

internal val WebyarDarkColors = darkColorScheme(
    primary = BrandDark,
    onPrimary = Color(0xFF002C71),
    primaryContainer = Color(0xFF15439E),
    onPrimaryContainer = Color(0xFFDCE6FF),
    inversePrimary = BrandLight,

    secondary = Color(0xFFBEC6DC),
    onSecondary = Color(0xFF283041),
    secondaryContainer = Color(0xFF3E4759),
    onSecondaryContainer = Color(0xFFDAE2F9),

    tertiary = Color(0xFFDDBCE0),
    onTertiary = Color(0xFF3F2844),
    tertiaryContainer = Color(0xFF573E5B),
    onTertiaryContainer = Color(0xFFFAD8FC),

    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),

    background = Color(0xFF111318),
    onBackground = Color(0xFFE2E2E9),
    surface = Color(0xFF111318),
    onSurface = Color(0xFFE2E2E9),
    surfaceVariant = Color(0xFF43474E),
    onSurfaceVariant = Color(0xFFC3C6CF),

    surfaceContainerLowest = Color(0xFF0C0E13),
    surfaceContainerLow = Color(0xFF191C20),
    surfaceContainer = Color(0xFF1D2024),
    surfaceContainerHigh = Color(0xFF282A2F),
    surfaceContainerHighest = Color(0xFF33353A),

    outline = Color(0xFF8D9199),
    outlineVariant = Color(0xFF43474E),

    inverseSurface = Color(0xFFE2E2E9),
    inverseOnSurface = Color(0xFF2F3033),
    scrim = Color(0xFF000000),
)

/**
 * The handful of colours Material has no role for.
 *
 * Reaching for `MaterialTheme.colorScheme.primary` to paint an outgoing chat
 * bubble would work until the day the brand changes and every bubble changes
 * with it — which may or may not be wanted, and should be a decision rather
 * than a side effect. So the bubbles name their own colours, and point them at
 * the brand today.
 *
 * `success` and `warning` are here for the same reason: Material 3 has `error`
 * and nothing else, and an availability dot needs three states.
 */
@Immutable
data class WebyarColors(
    val bubbleOutgoing: Color,
    val onBubbleOutgoing: Color,
    val bubbleIncoming: Color,
    val onBubbleIncoming: Color,
    /** A timestamp or a counter — quieter than `onSurfaceVariant`. */
    val labelTertiary: Color,
    val success: Color,
    val warning: Color,
    /** The unread badge, which must read against both bubble colours. */
    val badge: Color,
    val onBadge: Color,
)

internal val WebyarLightExtras = WebyarColors(
    bubbleOutgoing = BrandLight,
    onBubbleOutgoing = Color.White,
    // Not the page background: an incoming bubble painted the same shade as
    // the transcript behind it is invisible, which is exactly what happened on
    // iOS before `bubbleIncoming` stopped being `.secondarySystemBackground`.
    bubbleIncoming = Color(0xFFEBEEF3),
    onBubbleIncoming = Color(0xFF1A1C1E),
    labelTertiary = Color(0xFF8A8E97),
    success = Color(0xFF2E7D32),
    warning = Color(0xFFB26A00),
    badge = Color(0xFFBA1A1A),
    onBadge = Color.White,
)

internal val WebyarDarkExtras = WebyarColors(
    bubbleOutgoing = Color(0xFF15439E),
    onBubbleOutgoing = Color(0xFFDCE6FF),
    bubbleIncoming = Color(0xFF282A2F),
    onBubbleIncoming = Color(0xFFE2E2E9),
    labelTertiary = Color(0xFF8D9199),
    success = Color(0xFF7BD389),
    warning = Color(0xFFFFB95C),
    badge = Color(0xFFFF6B6B),
    onBadge = Color(0xFF410002),
)

/**
 * The same roles, read off a scheme that is not the brand's — wallpaper
 * colours. Success and warning keep their meaning (green is still "online")
 * and only the brand-derived colours follow the scheme.
 */
internal fun extrasFrom(scheme: ColorScheme, dark: Boolean): WebyarColors {
    val base = if (dark) WebyarDarkExtras else WebyarLightExtras
    return base.copy(
        bubbleOutgoing = if (dark) scheme.primaryContainer else scheme.primary,
        onBubbleOutgoing = if (dark) scheme.onPrimaryContainer else scheme.onPrimary,
        bubbleIncoming = scheme.surfaceContainerHigh,
        onBubbleIncoming = scheme.onSurface,
        labelTertiary = scheme.outline,
        badge = scheme.error,
        onBadge = scheme.onError,
    )
}

/**
 * Static rather than dynamic: these change only when the theme does, and a
 * dynamic local would invalidate every reader on every recomposition of the
 * provider.
 */
val LocalWebyarColors = staticCompositionLocalOf { WebyarLightExtras }
