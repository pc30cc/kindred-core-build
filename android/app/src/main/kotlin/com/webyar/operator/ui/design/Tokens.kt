package com.webyar.operator.ui.design

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.ui.unit.dp

/**
 * Spacing, radius and size, in one place.
 *
 * Port of the corresponding sections of
 * `ios/WebyarNative/Sources/DesignSystem/Theme.swift`. The numbers are the
 * same ones, because a title on Android should sit where a title on iOS sits —
 * the two apps are the same product and an operator moves between them.
 *
 * What is deliberately NOT the same is everything below the numbers: colour
 * roles, shapes and motion follow Material 3 rather than UIKit. An Android app
 * that imitates iOS chrome reads as a port, and a port is what this must not
 * look like. The brand is shared; the platform's manners are not.
 */
object Space {
    /** 2 — hairline separation inside a single control. */
    val xxs = 2.dp
    /** 4 — between a label and the value directly under it. */
    val xs = 4.dp
    /** 8 — between tightly related elements in a row. */
    val sm = 8.dp
    /** 12 — between rows in a stack. */
    val md = 12.dp
    /** 16 — the standard reading margin; the default screen inset. */
    val lg = 16.dp
    /** 20 — between a section and the next one. */
    val xl = 20.dp
    /** 28 — around a focal element such as a form's submit button. */
    val xxl = 28.dp
    /** 40 — top of a hero/branding block. */
    val huge = 40.dp

    /** The horizontal inset every full-width screen uses. */
    val screenInset = lg
}

object Radius {
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 22.dp
    /** Fully rounded — pills, avatars, the composer field. */
    val pill = 999.dp
}

object Size {
    /**
     * The minimum touch target.
     *
     * 48dp, not iOS's 44pt: this is Android's own guidance and Material's
     * components are built to it. Using 44 here would make every control one
     * notch smaller than the system's own, which is the kind of difference
     * nobody names and everybody feels.
     */
    val minTouchTarget = 48.dp

    val avatarSmall = 32.dp
    val avatarMedium = 44.dp
    val avatarLarge = 76.dp

    /**
     * A list row's minimum height.
     *
     * A minimum, never a fixed height: at a large font scale the row has to be
     * allowed to grow, and a hard height is how text ends up clipped on the
     * devices of the people who most need it not to be.
     */
    val rowMinHeight = 60.dp

    /** The floating tab bar: one item plus the capsule's padding. */
    val floatingBarHeight = minTouchTarget + 4.dp + Space.sm * 2

    /**
     * How far the bar's bottom edge sits from the bottom of the window.
     *
     * Measured from the window, not from the safe area, because the bar
     * deliberately reaches into the gesture-navigation strip — the same
     * arrangement as iOS, for the same reason: the strip is wasted space
     * otherwise, and the bar is the one thing that can share it.
     */
    val floatingBarBottomGap = 16.dp

    /** Stroke for hairline dividers, thin enough not to read as a border. */
    val hairline = 1.dp

    /**
     * Material's own icon size, named so a layout can reserve the slot.
     *
     * A menu that shows a tick beside the current item has to hold the space
     * whether the tick is there or not, or every label in the section steps
     * sideways by 24dp as the selection moves.
     */
    val icon = 24.dp
}

/**
 * Motion.
 *
 * Durations are short on purpose. This is a tool an operator uses for hours,
 * and an animation that is charming on the first run is friction on the
 * thousandth.
 */
object Motion {
    /** Content appearing or changing. */
    fun <T> standard() = tween<T>(durationMillis = 220)

    /** A message arriving in the transcript — springy, because it is an event. */
    fun <T> bubble() = spring<T>(
        dampingRatio = 0.82f,
        stiffness = Spring.StiffnessMediumLow,
    )

    /** The tab bar's selection indicator: short travel, so crisp not wobbly. */
    fun <T> tabIndicator() = spring<T>(
        dampingRatio = 0.86f,
        stiffness = Spring.StiffnessMedium,
    )
}
