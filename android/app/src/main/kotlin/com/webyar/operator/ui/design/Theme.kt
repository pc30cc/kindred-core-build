package com.webyar.operator.ui.design

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import com.webyar.operator.i18n.Language
import android.provider.Settings
import androidx.compose.runtime.remember

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
     * Material You, where the platform has it (Android 12 and later).
     *
     * Off unless the operator turns it on in Settings. This is a white-label
     * product: the blue belongs to the customer whose logo is on the login
     * screen, and recolouring it from the wallpaper is the operator's choice
     * to make, not the default.
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
    // The brand extras are hand-tuned against the brand scheme. Under
    // wallpaper colours the bubbles and badge follow the scheme instead, or
    // a blue outgoing bubble would sit in an otherwise green app.
    val extras = when {
        colors !== WebyarLightColors && colors !== WebyarDarkColors -> extrasFrom(colors, dark)
        dark -> WebyarDarkExtras
        else -> WebyarLightExtras
    }

    val context = LocalContext.current
    val reducedMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }

    CompositionLocalProvider(
        LocalWebyarColors provides extras,
        LocalLayoutDirection provides language.layoutDirection,
        LocalReducedMotion provides reducedMotion,
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
