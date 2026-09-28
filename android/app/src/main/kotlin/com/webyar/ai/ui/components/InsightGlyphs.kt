package com.webyar.ai.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The Visitors and Website analytics tabs' marks — Material Symbols the core
 * icon set does not carry, drawn the way [Glyph] draws its own: a 24-unit
 * viewport and no colour of their own, so `Icon` tints them with the theme.
 */
object InsightGlyph {
    /** The Website analytics tab: three bars. */
    val BarChart: ImageVector by lazy { vector("BarChart", "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z") }

    /** The overview's trend. */
    val ShowChart: ImageVector by lazy { vector("ShowChart", "M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z") }

    val Map: ImageVector by lazy {
        vector(
            "Map",
            "M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 " +
                "5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z",
        )
    }

    val Copy: ImageVector by lazy {
        vector(
            "Copy",
            "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7" +
                "c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
        )
    }

    /** Geography, and a visitor nobody can place. */
    val Globe: ImageVector by lazy {
        vector(
            "Globe",
            "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 " +
                "0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1" +
                "H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
        )
    }

    /** Devices & browsers. */
    val Devices: ImageVector by lazy {
        vector(
            "Devices",
            "M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 " +
                "1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z",
        )
    }

    /** Custom events. */
    val TouchApp: ImageVector by lazy {
        vector(
            "TouchApp",
            "M9 11.24V7.5C9 6.12 10.12 5 11.5 5S14 6.12 14 7.5v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3" +
                "S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6c0-.83-.67-1.5" +
                "-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72c-.08-.01-.15-.03-.24-.03-.31 0-.59.13-.79.33l-.79.8 4.94 4.94" +
                "c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38z",
        )
    }

    /** Traffic sources: where the paths part. */
    val Split: ImageVector by lazy {
        vector("Split", "M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4zm-4 0H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3z")
    }

    val People: ImageVector by lazy {
        vector(
            "People",
            "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 " +
                "2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z" +
                "m8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
        )
    }

    val Eye: ImageVector by lazy {
        vector(
            "Eye",
            "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17" +
                "c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
        )
    }

    /** Visits, stacked: sessions, and pages per visit. */
    val Layers: ImageVector by lazy {
        vector("Layers", "M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z")
    }

    /** The bounce rate: a visit that turned back. */
    val TurnBack: ImageVector by lazy {
        vector(
            "TurnBack",
            "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 " +
                "7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
        )
    }

    val TrendUp: ImageVector by lazy { vector("TrendUp", "M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z") }

    val TrendDown: ImageVector by lazy { vector("TrendDown", "M16 18l2.29-2.29-4.88-4.88-4 4L2 7.41 3.41 6l6 6 4-4 6.3 6.29L22 12v6z") }

    val Equal: ImageVector by lazy { vector("Equal", "M19 10H5V8h14v2zm0 6H5v-2h14v2z") }

    /** Start or open a chat with a visitor. */
    val Chat: ImageVector by lazy {
        vector(
            "Chat",
            "M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2z" +
                "m4-6H6V6h12v2z",
        )
    }

    /** Where they came from. */
    val Link: ImageVector by lazy {
        vector(
            "Link",
            "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1z" +
                "M8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
        )
    }

    /** The IP address. */
    val Network: ImageVector by lazy { vector("Network", "M13 22h8v-7h-3v-4h-5V9h3V2H8v7h3v2H6v4H3v7h8v-7H8v-2h8v2h-3z") }

    /** The browser. */
    val Browser: ImageVector by lazy {
        vector(
            "Browser",
            "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 14H4v-4h11v4z" +
                "m0-5H4V9h11v4zm5 5h-4V9h4v9z",
        )
    }

    val Phone: ImageVector by lazy {
        vector(
            "Phone",
            "M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 " +
                "15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z",
        )
    }

    val Desktop: ImageVector by lazy {
        vector(
            "Desktop",
            "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
        )
    }

    val Tablet: ImageVector by lazy {
        vector("Tablet", "M21 4H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 1.99-.9 1.99-2L23 6c0-1.1-.9-2-2-2zm-2 14H5V6h14v12z")
    }

    /** The line in first place. */
    val Crown: ImageVector by lazy {
        vector(
            "Crown",
            "M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4" +
                "v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 " +
                "9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z",
        )
    }

    /** A report's total. */
    val Sum: ImageVector by lazy { vector("Sum", "M18 4H6v2l6.5 6L6 18v2h12v-3h-7l5-5-5-5h7z") }

    /** How many lines a report has. */
    val Numbered: ImageVector by lazy {
        vector(
            "Numbered",
            "M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14" +
                "V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z",
        )
    }

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
                fill = SolidColor(Color.Black),
            )
        }.build()
}
