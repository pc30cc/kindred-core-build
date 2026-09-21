package com.webyar.operator.ui.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import com.webyar.operator.R

/**
 * Vazirmatn, bundled, in four weights.
 *
 * Three reasons it is bundled rather than left to the platform:
 *
 * The product is Persian first, and the platform's Persian is whatever the
 * OEM shipped. Roboto has no Arabic-script glyphs at all, so every Persian
 * string falls back — to Noto Naskh on a Pixel, to something else on a Samsung,
 * to something else again on a Xiaomi. The same screen is a different app on
 * each, and the differences are not subtle: naskh and sans forms of the same
 * word have different widths, so lines wrap in different places.
 *
 * Downloadable fonts would avoid the 480KB, and were rejected: the provider is
 * Play Services, and a large share of this product's operators are on handsets
 * that do not have it. A font that arrives on some devices and not others is
 * worse than one that is simply there.
 *
 * Static weights rather than the variable build, for `minSdk 24`: the weight
 * axis of a variable font needs API 26, and on 24 and 25 every weight would
 * render at Regular — bold titles silently flattening on the oldest devices,
 * which is exactly where nobody would look. Four files cost 480KB; the
 * variable one cost 240KB and two Android versions.
 *
 * Licensed SIL OFL 1.1; the licence ships in `res/raw/license_vazirmatn.txt`
 * and is shown in Settings, which is what the licence asks for.
 */
val Vazirmatn = FontFamily(
    Font(R.font.vazirmatn_regular, FontWeight.Normal),
    Font(R.font.vazirmatn_medium, FontWeight.Medium),
    Font(R.font.vazirmatn_semibold, FontWeight.SemiBold),
    Font(R.font.vazirmatn_bold, FontWeight.Bold),
)

/**
 * Trim the font's own vertical padding and centre what is left.
 *
 * Without this, Compose adds the font's ascent/descent metrics on top of the
 * line height. Vazirmatn's metrics are generous — they have to be, to leave
 * room for Persian diacritics — so a row of text carries several device pixels
 * of dead space above and below it, and a bubble sized to its text looks
 * loosely padded at the top and tight at the bottom.
 */
private val Trim = PlatformTextStyle(includeFontPadding = false)
private val Centred = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private fun style(
    size: Int,
    lineHeight: Int,
    weight: FontWeight = FontWeight.Normal,
    letterSpacing: Double = 0.0,
) = TextStyle(
    fontFamily = Vazirmatn,
    fontWeight = weight,
    // sp, never dp: text that ignores the reader's font-size setting is an
    // accessibility failure, and on this product it is also a practical one —
    // operators read these screens all day.
    fontSize = size.sp,
    // Roughly 1.5x, which Latin wants; Persian wants it because a line with
    // both a diacritic above and a descender below is taller than Latin ever
    // gets, and tighter leading makes consecutive lines collide.
    lineHeight = lineHeight.sp,
    letterSpacing = letterSpacing.sp,
    platformStyle = Trim,
    lineHeightStyle = Centred,
)

/**
 * The Material 3 scale, in Vazirmatn.
 *
 * Every component that reads `MaterialTheme.typography` — which is all of
 * them — picks the font up from here, so nothing has to name a family.
 */
val WebyarTypography = Typography(
    displayLarge = style(54, 62, FontWeight.Bold, -0.25),
    displayMedium = style(43, 52, FontWeight.Bold),
    displaySmall = style(34, 42, FontWeight.Bold),

    headlineLarge = style(30, 40, FontWeight.Bold),
    headlineMedium = style(26, 36, FontWeight.Bold),
    headlineSmall = style(22, 32, FontWeight.SemiBold),

    titleLarge = style(21, 30, FontWeight.SemiBold),
    titleMedium = style(16, 24, FontWeight.SemiBold, 0.1),
    titleSmall = style(14, 20, FontWeight.SemiBold, 0.1),

    bodyLarge = style(16, 25, letterSpacing = 0.15),
    bodyMedium = style(14, 21, letterSpacing = 0.15),
    bodySmall = style(12, 18, letterSpacing = 0.2),

    labelLarge = style(14, 20, FontWeight.SemiBold, 0.1),
    labelMedium = style(12, 16, FontWeight.Medium, 0.4),
    labelSmall = style(11, 16, FontWeight.Medium, 0.4),
)

/**
 * The names the screens actually use.
 *
 * These say what a style is FOR rather than how big it is, which is the whole
 * point of having a scale: a row title stays a row title when somebody decides
 * row titles should be a notch larger. The iOS app names the same seven, so a
 * screen described on one platform can be built on the other without
 * translating a type ramp in your head.
 */
object WebyarType {
    /** Screen hero title — the login screen, and nowhere else so far. */
    val hero = WebyarTypography.headlineLarge
    /** A row's primary line: a contact name, a conversation subject. */
    val rowTitle = WebyarTypography.titleMedium
    /** A row's supporting line: the message preview. */
    val rowSubtitle = WebyarTypography.bodyMedium
    /** Timestamps, counters, channel badges. */
    val meta = WebyarTypography.bodySmall
    val metaEmphasis = WebyarTypography.labelMedium
    /** Button labels. */
    val button = WebyarTypography.labelLarge
    /** Chat message text. */
    val message = WebyarTypography.bodyLarge
}
