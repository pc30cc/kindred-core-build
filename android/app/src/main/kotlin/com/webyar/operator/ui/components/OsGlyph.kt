package com.webyar.operator.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser

/**
 * The operating-system families the inbox draws a brand mark for.
 *
 * Resolution mirrors `src/components/visitors/OsIcon.tsx` and the iOS
 * `OSKind` exactly — the same strings map to the same family, so a visitor
 * shown as Windows in the web inbox is Windows here too.
 */
enum class OsKind {
    APPLE, WINDOWS, LINUX, ANDROID;

    companion object {
        fun resolve(os: String?, device: String? = null): OsKind? {
            val value = os.orEmpty().lowercase()
            if (value.isEmpty()) return null
            return when {
                "mac" in value || "ios" in value ||
                    "iphone" in value || "ipad" in value -> APPLE
                "win" in value -> WINDOWS
                "android" in value -> ANDROID
                "linux" in value || "ubuntu" in value -> LINUX
                else -> null
            }
        }
    }
}

/**
 * The brand gradients, transcribed from `OS_GRADIENT` in `ContactAvatar.tsx`.
 *
 * Written as HSV here because that is how the web states them and how the iOS
 * port states them; converting to hex would make the next person diff three
 * lists of opaque numbers to check they still agree.
 */
internal fun OsKind.brush(size: Float): Brush {
    val stops = when (this) {
        OsKind.APPLE -> Color.hsv(220f, 0.08f, 0.42f) to Color.hsv(220f, 0.12f, 0.16f)
        OsKind.WINDOWS -> Color.hsv(201f, 0.92f, 0.56f) to Color.hsv(217f, 0.90f, 0.44f)
        OsKind.LINUX -> Color.hsv(38f, 0.96f, 0.58f) to Color.hsv(22f, 0.90f, 0.48f)
        OsKind.ANDROID -> Color.hsv(150f, 0.68f, 0.50f) to Color.hsv(142f, 0.72f, 0.34f)
    }
    return Brush.linearGradient(
        colors = listOf(stops.first, stops.second),
        start = Offset.Zero,
        end = Offset(size, size),
    )
}

/**
 * The mark itself, drawn from the SAME SVG path data the web ships.
 *
 * Compose parses SVG path strings natively, so these are the web's strings
 * rather than a redrawing of them — which is the only way two codebases end up
 * showing the same visitor the same logo a year from now. The iOS port had to
 * write its own mini path parser to manage this; here it is one call.
 */
@Composable
fun OsGlyph(kind: OsKind, sizePx: Float, modifier: Modifier = Modifier) {
    val path = remember(kind) { PathParser().parsePathString(kind.pathData).toPath() }
    Canvas(modifier) { drawGlyph(path, sizePx) }
}

private fun DrawScope.drawGlyph(path: Path, sizePx: Float) {
    // Every path below is drawn against a 24-unit viewBox, the way an SVG
    // states it; this maps that box onto whatever the caller asked for.
    val factor = sizePx / VIEW_BOX
    scale(factor, factor, pivot = Offset.Zero) {
        drawPath(path, Color.White)
    }
}

private const val VIEW_BOX = 24f

private val OsKind.pathData: String
    get() = when (this) {
        // Four-pane monogram — `WindowsGlyph` in OsIcon.tsx.
        OsKind.WINDOWS ->
            "M3 5.5l8-1.1v7.1H3V5.5zm0 13l8 1.1v-7H3v5.9zm9 1.2l9 1.3v-8.5h-9v7.2zm0-15.4l9-1.3v8.5h-9V4.3z"
        // Simplified Tux silhouette — `LinuxGlyph` in OsIcon.tsx.
        OsKind.LINUX ->
            "M12 2.4c-2 0-3.4 1.7-3.4 3.9 0 1 .3 1.9.7 2.6-.9.6-1.8 1.6-2.4 2.9-.9 2-1.4 4-2.2 5.5-.4.7-.9 " +
                "1.2-.9 1.8 0 .8.8 1.3 1.7 1.5.7.2 1.4.3 1.7.6.4.4.8 1 2.1 1.2 1 .2 2.1-.1 2.7-.5.6.4 1.7.7 " +
                "2.7.5 1.3-.2 1.7-.8 2.1-1.2.3-.3 1-.4 1.7-.6.9-.2 1.7-.7 1.7-1.5 0-.6-.5-1.1-.9-1.8-.8-1.5-1.3-3.5-2.2-5.5-.6-1.3-1.5-2.3-2.4-2.9.4-.7.7-1.6.7-2.6 0-2.2-1.4-3.9-3.4-3.9zm-1.4 " +
                "4.1c.3 0 .5.4.5.9 0 .2 0 .4-.1.5-.1-.1-.3-.1-.4-.1-.4 0-.7.3-.7.7v.1c-.2-.2-.3-.5-.3-.8 0-.7.5-1.3 " +
                "1-1.3zm2.8 0c.5 0 1 .6 1 1.3 0 .3-.1.6-.3.8v-.1c0-.4-.3-.7-.7-.7-.1 0-.3 0-.4.1-.1-.1-.1-.3-.1-.5 0-.5.2-.9.5-.9z"
        // iOS reaches for the `apple.logo` SF Symbol here; Android has no such
        // catalogue, so the mark is a path like the other two.
        OsKind.APPLE ->
            "M16.1 12.7c0-2.2 1.8-3.2 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 " +
                "0-2.8.8-3.6 2.1-1.5 2.7-.4 6.6 1.1 8.8.7 1.1 1.6 2.3 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 " +
                "0 1.9-1.1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.5-.1 0-2.2-.9-2.2-3.5zM14 5.9c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 " +
                "1.3-.6.6-1.1 1.7-.9 2.6 1 .1 2-.5 2.6-1.2z"
        // The web uses Lucide's generic `Smartphone`; this is its filled form,
        // which reads as a handset at 16dp where the outline version does not.
        OsKind.ANDROID ->
            "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm3.5 " +
                "16.2h3a.8.8 0 0 0 0-1.6h-3a.8.8 0 0 0 0 1.6z"
    }
