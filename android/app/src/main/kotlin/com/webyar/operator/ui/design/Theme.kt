package com.webyar.operator.ui.design

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import com.webyar.operator.i18n.Language

/** Material's shape scale, from the app's own radius tokens. */
private val WebyarShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.sm),
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.lg),
    extraLarge = RoundedCornerShape(Radius.xl),
)

/**
 * The app's theme.
 *
 * Wraps Material's, and adds two things Material has no opinion about: the
 * handful of colours in [WebyarColors], and the layout direction.
 *
 * **Direction comes from [language], not from the device.** Every other
 * Android app takes it from the system locale, and this one must not: the
 * operator picks a language in Settings and it sticks, which is the same
 * contract the web app and the iOS app keep. A Persian operator on an English
 * handset gets a right-to-left app; an English operator on a Persian handset
 * does not. Leaving this to the platform would quietly break that, and break
 * it only for the people whose device language differs from their choice —
 * which is most of them.
 */
@Composable
fun WebyarTheme(
    language: Language = Language.DEFAULT,
    dark: Boolean = isSystemInDarkTheme(),
    /**
     * Material You, where the platform has it.
     *
     * Off by default and expected to stay off. This is a white-label product:
     * the blue belongs to the customer whose logo is on the login screen, and
     * recolouring it from the operator's wallpaper would be recolouring
     * somebody else's brand.
     */
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        dark -> WebyarDarkColors
        else -> WebyarLightColors
    }
    val extras = if (dark) WebyarDarkExtras else WebyarLightExtras

    CompositionLocalProvider(
        LocalWebyarColors provides extras,
        LocalLayoutDirection provides language.layoutDirection,
    ) {
        MaterialTheme(
            colorScheme = colors,
            typography = WebyarTypography,
            shapes = WebyarShapes,
            content = content,
        )
    }
}

/**
 * The colours Material has no role for.
 *
 * Read as `WebyarTheme.colors.bubbleOutgoing`, which reads like
 * `MaterialTheme.colorScheme.primary` and is meant to.
 */
object WebyarTheme {
    val colors: WebyarColors
        @Composable get() = LocalWebyarColors.current
}
