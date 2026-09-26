package com.webyar.operator.ui.design

import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
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

/**
 * Corner radii — Material 3 Expressive's corner scale.
 *
 * Expressive leans on larger, softer corners than the 2021 scale did, and
 * uses the difference between them as hierarchy: a sheet is rounder than a
 * card, a card rounder than a chip. These are the scale's own steps, so a
 * surface here reads like the same surface in the system's own apps.
 */
object Radius {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val lgIncreased = 20.dp
    val xl = 28.dp
    val xlIncreased = 32.dp
    val xxl = 48.dp
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
 * Motion — Material 3 Expressive's springs.
 *
 * Springs rather than durations: a spring answers an interruption (a second
 * tap, a flick back) from wherever it is, where a tween restarts or jumps.
 * The values are the Expressive scheme's own tokens (material3's
 * `ExpressiveMotionTokens`), which the stable line of the library keeps
 * internal, so they are restated here and used by every animation the app
 * draws itself.
 *
 * **Spatial** springs move and resize things and are allowed to overshoot a
 * little — that bounce is the "expressive" part. **Effects** springs change
 * colour and opacity and never overshoot, because an alpha of 1.04 is not a
 * bounce, it is a flicker.
 */
object Motion {
    /** Most movement: a panel opening, an indicator sliding, a row settling. */
    fun <T> spatial(): SpringSpec<T> = spring(dampingRatio = 0.8f, stiffness = 380f)

    /** Small, quick movement — a button's shape on press, a toggle's thumb. */
    fun <T> fastSpatial(): SpringSpec<T> = spring(dampingRatio = 0.6f, stiffness = 800f)

    /** Large movement across the screen — a pane, a sheet, a hero. */
    fun <T> slowSpatial(): SpringSpec<T> = spring(dampingRatio = 0.8f, stiffness = 200f)

    /** Colour and opacity. */
    fun <T> effects(): SpringSpec<T> = spring(dampingRatio = 1f, stiffness = 1600f)

    fun <T> fastEffects(): SpringSpec<T> = spring(dampingRatio = 1f, stiffness = 3800f)

    fun <T> slowEffects(): SpringSpec<T> = spring(dampingRatio = 1f, stiffness = 800f)

    /** Content appearing or changing. */
    fun <T> standard(): SpringSpec<T> = effects()

    /** A message arriving in the transcript — springy, because it is an event. */
    fun <T> bubble(): SpringSpec<T> = spatial()

    /** The navigation indicator: short travel, so crisp not wobbly. */
    fun <T> tabIndicator(): SpringSpec<T> = fastSpatial()

    /**
     * Half a cycle of a loading placeholder's pulse.
     *
     * Slow on purpose. A placeholder is on screen for a second at most on a
     * good connection and several on a bad one, and a quick pulse reads as
     * alarm rather than patience — which is the wrong note to strike at
     * exactly the moment the app is asking somebody to wait.
     */
    const val skeletonPulse = 750
}
