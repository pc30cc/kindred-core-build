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

    /**
     * A smiling face, for the emoji strip.
     *
     * `SentimentSatisfied` is `material-icons-extended` only, and pulling in
     * several megabytes for one shape is the trade this file exists to avoid.
     */
    val Mood: ImageVector by lazy {
        vector(
            "Mood",
            "M15.5 11q.63 0 1.06-.44Q17 10.13 17 9.5q0-.63-.44-1.06Q16.13 8 15.5 8q-.63 0-1.06.44Q14 8.87 14 " +
                "9.5q0 .63.44 1.06.43.44 1.06.44Zm-7 0q.63 0 1.06-.44Q10 10.13 10 9.5q0-.63-.44-1.06Q9.13 8 " +
                "8.5 8q-.63 0-1.06.44Q7 8.87 7 9.5q0 .63.44 1.06.43.44 1.06.44Zm3.5 6.5q1.7 0 3.11-.96 " +
                "1.41-.95 2.04-2.54H6.85q.63 1.59 2.04 2.54 1.41.96 3.11.96Zm0 4.5q-2.08 0-3.9-.79-1.83-.79-3.19-2.15" +
                "-1.36-1.36-2.14-3.18Q2 14.07 2 12t.78-3.9q.78-1.83 2.14-3.19Q6.28 3.55 8.1 2.77 9.92 2 12 " +
                "2q2.08 0 3.9.77 1.83.78 3.19 2.14 1.36 1.36 2.14 3.19.77 1.82.77 3.9 0 2.07-.77 3.89-.78 " +
                "1.82-2.14 3.18-1.36 1.36-3.19 2.15-1.82.79-3.9.79Zm0-2q3.35 0 5.67-2.33Q20 15.35 20 12t-2.33-5.67" +
                "Q15.35 4 12 4T6.33 6.33Q4 8.65 4 12t2.33 5.67Q8.65 20 12 20Z",
        )
    }

    /**
     * A lightning bolt, for saved replies.
     *
     * The control used to borrow `Icons.Filled.Face`, which is a face — next
     * to an emoji button that is also a face, on a row where one inserts a
     * smiley and the other opens a list of canned answers. A bolt is what the
     * web console uses and what "quick reply" looks like everywhere else.
     */
    val Bolt: ImageVector by lazy {
        vector(
            "Bolt",
            "M7.85 22 9.6 14H5.5l6.7-12h1.75l-1.75 8h4.1L9.6 22H7.85Z",
        )
    }

    /**
     * Two bars. `Icons.Filled.PlayArrow` is in the core set and its partner
     * is not, which would leave a transport with one drawn icon and one
     * borrowed shape.
     */
    val Pause: ImageVector by lazy {
        vector(
            "Pause",
            "M14 19V5h4v14h-4Zm-8 0V5h4v14H6Z",
        )
    }

    /**
     * A microphone with a line through it.
     *
     * The call controls need both states as shapes, not one shape lit and
     * unlit: a round button on a black screen gives an operator nothing to
     * compare "highlighted" against, and being wrong about it means talking
     * to nobody. The iOS screen swaps the shape for the same reason.
     *
     * This one and the five below are Material Icons' own paths rather than
     * Material Symbols', which is what [Mic] above is drawn from. The two
     * sets differ by a hair of optical weight at 24dp and not at all at the
     * 22dp these are rendered at, and a shape whose geometry is certain beats
     * one that merely matches in spirit.
     */
    val MicOff: ImageVector by lazy {
        vector(
            "MicOff",
            "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11" +
                ".02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 " +
                "1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 " +
                "0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 " +
                "21 21 19.73 4.27 3z",
        )
    }

    /** A video camera, for the camera control on a video call. */
    val Videocam: ImageVector by lazy {
        vector(
            "Videocam",
            "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 " +
                "1-1v-3.5l4 4v-11l-4 4z",
        )
    }

    /** The same camera, struck through. */
    val VideocamOff: ImageVector by lazy {
        vector(
            "VideocamOff",
            "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 " +
                "1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
        )
    }

    /**
     * A loudspeaker, sounding.
     *
     * The waves are the whole signal: with the loudspeaker off the same cone
     * is drawn without them, which is how every phone's own dialler — and the
     * iOS screen this mirrors — says "in your ear" rather than "in the room".
     */
    val Speaker: ImageVector by lazy {
        vector(
            "Speaker",
            "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 " +
                "2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 " +
                "7-4.49 7-8.77s-2.99-7.86-7-8.77z",
        )
    }

    /** The same cone with the sound gone: the earpiece, not the room. */
    val SpeakerOff: ImageVector by lazy {
        vector(
            "SpeakerOff",
            "M7 9v6h4l5 5V4l-5 5H7z",
        )
    }

    /**
     * A handset tipped over: what every phone on earth means by "end the
     * call", and what the iOS screen puts under the same thumb.
     */
    val CallEnd: ImageVector by lazy {
        vector(
            "CallEnd",
            "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 " +
                "1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 " +
                "0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 " +
                "0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 " +
                "9.25 13.6 9 12 9z",
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
