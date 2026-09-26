package com.webyar.operator.ui.design

import android.graphics.Matrix
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.graphics.shapes.CornerRounding
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.RoundedPolygon
import androidx.graphics.shapes.circle
import androidx.graphics.shapes.star
import androidx.graphics.shapes.toPath

/**
 * Material's shape scale, on the Expressive corner radii.
 *
 * Components read these — a dialog is `extraLarge`, a card `medium`, a text
 * field `extraSmall` — so the whole app moves to the Expressive corners by
 * way of this one object.
 */
internal val WebyarShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.xs),
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.lg),
    extraLarge = RoundedCornerShape(Radius.xl),
)

/**
 * The shapes Material 3 Expressive uses as graphic elements: a scalloped
 * "cookie" behind an avatar, a burst behind an empty state, the shapes a
 * loading indicator morphs between.
 *
 * Built from `graphics-shapes`, the library Material's own shape set is
 * built on — the stable line of material3 keeps that set internal. Every one
 * is normalised to a unit square, so [PolygonShape] can stretch it to any
 * box, and they are all made of rounded corners, so any two can be morphed
 * into each other.
 */
object ExpressiveShapes {
    /** Nine soft scallops — the avatar frame on a profile header. */
    val cookie9: RoundedPolygon = RoundedPolygon.star(
        numVerticesPerRadius = 9,
        innerRadius = 0.8f,
        rounding = CornerRounding(radius = 0.5f),
    ).normalized()

    /** Four lobes. */
    val cookie4: RoundedPolygon = RoundedPolygon.star(
        numVerticesPerRadius = 4,
        innerRadius = 0.72f,
        rounding = CornerRounding(radius = 0.55f),
    ).normalized()

    /** Eight gentle rays — a "sunny" badge. */
    val sunny: RoundedPolygon = RoundedPolygon.star(
        numVerticesPerRadius = 8,
        innerRadius = 0.83f,
        rounding = CornerRounding(radius = 0.15f),
    ).normalized()

    /** Twelve short spikes, softened — the burst behind an empty state. */
    val softBurst: RoundedPolygon = RoundedPolygon.star(
        numVerticesPerRadius = 12,
        innerRadius = 0.78f,
        rounding = CornerRounding(radius = 0.09f, smoothing = 0.6f),
    ).normalized()

    /** A four-leaf clover. */
    val clover: RoundedPolygon = RoundedPolygon.star(
        numVerticesPerRadius = 4,
        innerRadius = 0.35f,
        rounding = CornerRounding(radius = 0.32f),
        innerRounding = CornerRounding(radius = 0.2f),
    ).normalized()

    /** A soft pentagon. */
    val pentagon: RoundedPolygon = RoundedPolygon(
        numVertices = 5,
        rounding = CornerRounding(radius = 0.25f),
    ).normalized()

    /** A rounded square, the calm end of every morph. */
    val softSquare: RoundedPolygon = RoundedPolygon(
        numVertices = 4,
        rounding = CornerRounding(radius = 0.4f),
    ).normalized()

    /** A circle, as a polygon, so it can be morphed to and from. */
    val circle: RoundedPolygon = RoundedPolygon.circle(numVertices = 10).normalized()

    /** What [com.webyar.operator.ui.components.LoadingIndicator] cycles through. */
    val loadingSequence: List<RoundedPolygon> = listOf(softBurst, cookie9, pentagon, cookie4, sunny, softSquare)
}

/**
 * A [RoundedPolygon] as a Compose [Shape], stretched to the box it clips.
 *
 * The polygon must already be normalised (0..1 on both axes). Rotation is in
 * degrees about the centre, which is how the loading indicator turns without
 * a separate graphics layer.
 */
@Immutable
class PolygonShape(
    private val polygon: RoundedPolygon,
    private val rotation: Float = 0f,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline =
        Outline.Generic(polygon.toPath().scaledTo(size, rotation).asComposePath())

    override fun equals(other: Any?): Boolean =
        other is PolygonShape && other.polygon === polygon && other.rotation == rotation

    override fun hashCode(): Int = 31 * polygon.hashCode() + rotation.hashCode()
}

/** Part of the way from one polygon to another, as a [Shape]. */
@Immutable
class MorphShape(
    private val morph: Morph,
    private val progress: Float,
    private val rotation: Float = 0f,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline =
        Outline.Generic(morph.toPath(progress).scaledTo(size, rotation).asComposePath())

    override fun equals(other: Any?): Boolean =
        other is MorphShape && other.morph === morph && other.progress == progress && other.rotation == rotation

    override fun hashCode(): Int = (31 * morph.hashCode() + progress.hashCode()) * 31 + rotation.hashCode()
}

private fun android.graphics.Path.scaledTo(size: Size, rotation: Float): android.graphics.Path {
    val matrix = Matrix()
    if (rotation != 0f) matrix.postRotate(rotation, 0.5f, 0.5f)
    matrix.postScale(size.width, size.height)
    transform(matrix)
    return this
}
