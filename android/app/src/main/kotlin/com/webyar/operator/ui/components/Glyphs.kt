package com.webyar.operator.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The glyphs `material-icons-core` does not carry.
 *
 * The core artifact is a curated subset — `Mic` and a document icon are not in
 * it — and `material-icons-extended` is several megabytes and a noticeable
 * drag on every compile, for a handful of shapes. So the shapes are here, as
 * the same SVG path data any icon set would ship, turned into an `ImageVector`
 * by Compose's own parser.
 *
 * Paths are Material Symbols' own, on the 24-unit grid every Material icon
 * uses, so these sit at the same optical weight as the ones that did make the
 * cut.
 */
object Glyph {

    /** A microphone. Voice notes, and nothing else so far. */
    val Mic: ImageVector by lazy {
        vector(
            "Mic",
            "M12 14q-1.25 0-2.12-.88T9 11V5q0-1.25.88-2.12T12 2q1.25 0 2.13.88T15 5v6q0 1.25-.87 " +
                "2.12T12 14Zm-1 7v-3.08q-2.6-.35-4.3-2.32T5 11h2q0 2.08 1.46 3.54T12 16q2.08 0 " +
                "3.54-1.46T17 11h2q0 2.63-1.7 4.6T13 17.92V21h-2Z",
        )
    }

    /** A document. Any attachment that is not a picture. */
    val Document: ImageVector by lazy {
        vector(
            "Document",
            "M7 21q-.83 0-1.41-.59T5 19V5q0-.83.59-1.41T7 3h7l5 5v11q0 .83-.59 1.41T17 21H7Zm6-13V5H7v14h10V9h-4Z",
        )
    }

    /** A paperclip, for the attach control where a plus would read as "new". */
    val Paperclip: ImageVector by lazy {
        vector(
            "Paperclip",
            "M18 15.75q0 2.4-1.68 4.08T12.25 21.5q-2.4 0-4.07-1.67T6.5 15.75V6.25q0-1.77 " +
                "1.24-3.01T10.75 2q1.77 0 3.01 1.24T15 6.25v8.9q0 1.15-.8 1.95t-1.95.8q-1.15 " +
                "0-1.95-.8t-.8-1.95V6.5h1.5v9.15q0 .52.36.87t.89.36q.52 0 .88-.36t.37-.87v-8.9q0-1.15-.8-1.95T10.75 " +
                "3.5q-1.15 0-1.95.8t-.8 1.95v9.5q0 1.77 1.24 3.01T12.25 20q1.77 0 3.01-1.24T16.5 15.75V6.5H18v9.25Z",
        )
    }

    /**
     * Turns SVG path data into an icon.
     *
     * `defaultWidth`/`Height` in dp and a 24-unit viewport is what every
     * Material icon declares, and it is what lets `Icon` size and tint these
     * exactly as it sizes and tints the ones from the library.
     */
    private fun vector(name: String, pathData: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            addPath(
                pathData = PathParser().parsePathString(pathData).toNodes(),
                // Unspecified, so `Icon` supplies the tint — an icon with its
                // own colour baked in ignores the theme and shows up white on
                // white the first time somebody turns dark mode on.
                fill = SolidColor(Color.Black),
            )
        }.build()
}
