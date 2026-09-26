package com.webyar.operator.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.operator.ui.design.Size

/**
 * A contact or visitor avatar, matching the web inbox exactly.
 *
 * The fallback order is the one `src/components/inbox/ContactAvatar.tsx` uses,
 * and it matters: an uploaded picture wins; failing that, a visitor whose
 * operating system we know gets that brand mark on its brand gradient; only a
 * visitor we know nothing about falls back to initials. That is what makes a
 * row recognisable at a glance — an anonymous Windows visitor looks like a
 * Windows visitor rather than like the letter "V".
 *
 * A country flag rides in the bottom-leading corner when the IP resolved to
 * one, so an operator can see where a thread comes from without opening it.
 */
@Composable
fun Avatar(
    name: String,
    imageUrl: String? = null,
    size: Dp = Size.avatarMedium,
    /** Visitor operating system, e.g. "Windows", "macOS", "Android". */
    os: String? = null,
    /** Visitor device class — "desktop", "mobile", "tablet". */
    device: String? = null,
    /** ISO-3166 alpha-2 country code; anything else is ignored. */
    countryCode: String? = null,
    modifier: Modifier = Modifier,
) {
    // An uploaded picture always wins, so the OS is not even resolved.
    val osKind = remember(imageUrl, os, device) {
        if (imageUrl.isNullOrBlank()) OsKind.resolve(os, device) else null
    }
    // The flag if this device can draw one, and the country's two letters if
    // it cannot. See [countryMark].
    val flag = remember(countryCode) { countryMark(countryCode) }
    val flagSize = maxOf(12.dp, size * 0.38f)
    val separator = MaterialTheme.colorScheme.outlineVariant

    Box(
        modifier
            .size(size)
            // The whole thing is decoration: the row around it already says
            // whose conversation this is, and a screen reader that also read
            // out "M H, Windows, Germany" would be reading the same row twice.
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(size)
                .clip(CircleShape)
                .border(0.5.dp, separator.copy(alpha = 0.5f), CircleShape)
        ) {
            RemoteImage(
                url = imageUrl,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
            ) {
                if (osKind != null) OsFace(osKind, size) else InitialsFace(name, size)
            }
        }

        if (flag != null) {
            // The badge overhangs the circle deliberately — the same placement
            // as the web and iOS. `BottomStart` rather than `BottomLeft`: on a
            // Persian row the whole layout is mirrored and the flag should
            // travel with it.
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .offset(x = (-flagSize.value * 0.25f).dp, y = (flagSize.value * 0.25f).dp)
                    .size(flagSize)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .border(0.5.dp, separator.copy(alpha = 0.7f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                // Flags are emoji: they are already directional images and
                // must not be mirrored a second time by the layout.
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    // A flag is one wide glyph; the fallback is two narrow
                    // letters that have to fit side by side in the same
                    // circle, so they are set smaller and heavier.
                    val isLetters = flag.length == 2
                    Text(
                        flag,
                        style = glyphStyle(flagSize * if (isLetters) 0.44f else 0.62f),
                        fontWeight = if (isLetters) FontWeight.Bold else null,
                        color = if (isLetters) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            Color.Unspecified
                        },
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/**
 * An operator's face — the operator's own, a colleague's, an assignee's.
 *
 * Never initials. While the photo loads the circle is a skeleton, and it is
 * replaced by the photo that came; with no photo, or one that would not
 * load, it stays that same quiet circle rather than turning into letters.
 * A face that shows «SK» and then swaps it for a photograph reads as the row
 * changing its mind, and the letters say nothing a name beside them does
 * not already say.
 *
 * Visitors keep [Avatar]: for them the fallback carries information — the
 * operating system's mark, the country's flag — that nothing else on the row
 * does.
 */
@Composable
fun OperatorAvatar(
    imageUrl: String?,
    size: Dp = Size.avatarMedium,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            // Decoration: the name beside it is what a screen reader reads.
            .clearAndSetSemantics { },
    ) {
        RemoteImage(
            url = imageUrl,
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
        ) {
            // No photo, or one that failed: still, not pulsing — nothing is
            // on its way, so nothing should look like it is.
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHighest))
        }
    }
}

/**
 * A style for a glyph that has to fit a circle, whatever the font scale is.
 *
 * `12.sp` is not twelve points on a phone set to large text — it is
 * twenty-four, which is the point of `sp` and is right for nearly every
 * string in this app. It is wrong for the two here: a flag and a pair of
 * initials are marks filling a circle measured in `dp`, and scaling them
 * while the circle stays put clips them.
 *
 * Both the size AND the line height have to be pinned, which is the part
 * that took two goes. Fixing the size alone left the flag invisible at 2x:
 * the line height came from the ambient text style, was still in `sp`, and
 * laid the glyph out inside a line box twice the height of the circle
 * containing it. The trim is what removes the rest of the font's own
 * leading, so the mark sits in the middle rather than near the top.
 */
@Composable
private fun glyphStyle(value: Dp): TextStyle {
    val size = with(LocalDensity.current) { value.toSp() }
    return TextStyle(
        fontSize = size,
        lineHeight = size,
        platformStyle = PlatformTextStyle(includeFontPadding = false),
        lineHeightStyle = LineHeightStyle(
            alignment = LineHeightStyle.Alignment.Center,
            trim = LineHeightStyle.Trim.Both,
        ),
    )
}

@Composable
private fun OsFace(kind: OsKind, size: Dp) {
    val sizePx = with(LocalDensity.current) { size.toPx() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxSize().background(kind.brush(sizePx)))
        // The same soft top-light the web applies, which is what stops the
        // mark looking flat against a solid fill.
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.White.copy(alpha = 0.28f),
                    0.5f to Color.Transparent,
                )
            )
        )
        OsGlyph(kind, sizePx * 0.5f, Modifier.size(size * 0.5f))
    }
}

@Composable
private fun InitialsFace(name: String, size: Dp) {
    val sizePx = with(LocalDensity.current) { size.toPx() }
    val initials = remember(name) { initialsOf(name) }
    Box(
        Modifier.fillMaxSize().background(initialsBrush(name, sizePx)),
        contentAlignment = Alignment.Center,
    ) {
        // Initials are Latin-derived; pinning them left-to-right keeps a mixed
        // name from rendering its two letters in the wrong order.
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Text(
                text = initials,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                // Sized from the circle rather than from the type scale: this
                // has to fill a fixed circle, so it is one of the very few
                // places in the app where text does NOT scale with the
                // reader's font setting — it would overflow the circle.
                style = glyphStyle(size * 0.38f),
            )
        }
    }
}

/**
 * Two letters, the way the web picks them: one from each of the first two
 * words, or the first two characters of a single word.
 */
internal fun initialsOf(name: String): String {
    val source = name.trim()
    if (source.isEmpty()) return "?"
    val parts = source.split(' ').filter { it.isNotEmpty() }

    // A visitor nobody has named is not a person with a first name and a
    // surname — the label is a generated one, «بازدیدکننده 4ZTK», a word and
    // an opaque code. Taking the first letter of each produced «ب4»: two
    // scripts jammed into one circle, identifying nothing, and every
    // anonymous visitor in a Persian inbox looked like that.
    //
    // The code is the only part that tells one visitor from another, so the
    // code is what shows. Narrow on purpose: this fires only when a
    // non-Latin word is followed by a Latin code, which a real name never is.
    if (parts.size >= 2) {
        val leadsInAnotherScript = parts[0].any { it.isLetter() && it.code > 127 }
        val code = parts[1].takeIf { it.length >= 2 && it.all { c -> c.isLetterOrDigit() && c.code < 128 } }
        if (leadsInAnotherScript && code != null) return code.take(2).uppercase()
        return "${parts[0].first()}${parts[1].first()}".uppercase()
    }
    val first = parts.firstOrNull() ?: return "?"
    return first.take(if (first.length >= 2) 2 else 1).uppercase()
}

/**
 * The same twelve-hue family the web cycles through, chosen by the same djb2
 * hash of the same seed — so a given contact is the same colour in both
 * inboxes, on every device, on every launch.
 */
private fun initialsBrush(name: String, sizePx: Float): Brush {
    val palette = listOf(
        212f to 92f, 262f to 78f, 192f to 78f, 152f to 62f,
        172f to 70f, 232f to 88f, 292f to 70f, 332f to 78f,
        16f to 86f, 36f to 90f, 142f to 64f, 202f to 88f,
    )
    val seed = name.lowercase().ifEmpty { "?" }
    val (hue, sat) = palette[(djb2(seed) % palette.size.toUInt()).toInt()]
    val saturation = sat / 100f
    return Brush.linearGradient(
        colors = listOf(
            Color.hsv(hue, saturation, 0.56f),
            Color.hsv((hue + 28f) % 360f, saturation, 0.44f),
        ),
        start = Offset.Zero,
        end = Offset(sizePx, sizePx),
    )
}

/**
 * Kotlin's own `hashCode` would do here, but djb2 is what the web already
 * uses, and the point of this whole function is that both agree.
 */
internal fun djb2(value: String): UInt {
    var hash = 5381u
    for (char in value) {
        hash = ((hash shl 5) + hash) xor (char.code.toUInt() and 0xFFFFu)
    }
    return hash
}

/** ISO alpha-2 to a regional-indicator pair, or null for anything malformed. */
internal fun flagEmoji(countryCode: String?): String? {
    val code = countryCode?.trim()?.uppercase() ?: return null
    if (code.length != 2 || !code.all { it in 'A'..'Z' }) return null
    return buildString {
        for (char in code) appendCodePoint(0x1F1E6 + (char - 'A'))
    }
}

/**
 * What to put in the badge: a flag, or the two letters instead.
 *
 * Not every Android device can draw a flag. Several large OEMs ship ROMs with
 * the flag range removed from the emoji font — it is a legal requirement in
 * one of this app's larger markets — and on those the regional-indicator pair
 * renders as two empty boxes. A badge showing tofu is worse than a badge
 * showing "IR", which at least says something.
 *
 * `Paint.hasGlyph` is the question Android provides for exactly this, and it
 * asks the system font rather than guessing from the API level: a device that
 * has the glyph gets the flag whatever version it runs, and one that does not
 * gets the letters whatever version it runs.
 *
 * The answer is cached because it cannot change while the app is running —
 * a font does not appear mid-session — and `hasGlyph` measures text.
 */
internal fun countryMark(countryCode: String?): String? {
    val code = countryCode?.trim()?.uppercase() ?: return null
    if (code.length != 2 || !code.all { it in 'A'..'Z' }) return null
    val flag = flagEmoji(code) ?: return null
    return if (deviceDrawsFlags(flag)) flag else code
}

private val flagSupport = java.util.concurrent.atomic.AtomicReference<Boolean?>(null)

private fun deviceDrawsFlags(sample: String): Boolean =
    flagSupport.get() ?: runCatching { android.graphics.Paint().hasGlyph(sample) }
        .getOrDefault(false)
        .also { flagSupport.set(it) }
