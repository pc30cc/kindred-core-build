package com.webyar.ai.feature.visitors

import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Point
import android.view.MotionEvent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.webyar.ai.ui.design.WebyarTheme
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.util.MapTileIndex
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Overlay
import java.io.File
import kotlin.math.hypot

const val VISITORS_MAP_TAG = "visitors.map"

/**
 * Where the visitors are: a dot per visitor, green with a halo when online,
 * amber when idle, grey when offline; the selected one larger with a brand
 * ring. Tapping a dot opens that visitor.
 *
 * Drawn with the tiles the workspace's `map-config` names — OpenStreetMap
 * unless a platform admin chose other — exactly as the web console and the
 * Windows app's Leaflet map draw them, so there is no Google key to hold and
 * nothing that does not load where Google does not.
 */
@Composable
fun VisitorsMap(
    setup: VisitorMapSetup,
    pins: List<VisitorPin>,
    selectedId: String?,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current.density
    // The app's own light or dark, which can differ from the phone's.
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val online = WebyarTheme.colors.success.toArgb()
    val brand = MaterialTheme.colorScheme.primary.toArgb()
    val pick = rememberUpdatedState(onPick)
    // One overlay for the life of the map, its density set as the colours
    // are rather than keyed on it. The activity handles a density change
    // itself (a display-size change, a foldable moving to its other screen),
    // so this composition carries on through one — and an overlay remembered
    // per density was a new one the map had never been given, while the map
    // kept drawing the old one: dots frozen where they were, new visitors
    // never appearing.
    val overlay = remember { PinsOverlay { pick.value(it) } }
    overlay.density = density
    overlay.colors = PinColors(online = online, idle = 0xFFF5A524.toInt(), offline = 0xFF98A2B3.toInt(), ring = brand)
    // Framed once, on the first dots; after that the operator's pan and zoom are theirs.
    val fitted = remember { booleanArrayOf(false) }

    Box(modifier) {
        AndroidView(
            modifier = Modifier.testTag(VISITORS_MAP_TAG),
            factory = { context ->
                Configuration.getInstance().apply {
                    // Tile servers ask to be told who is asking (OSM's usage
                    // policy); the cache lives with the app's other caches.
                    userAgentValue = context.packageName
                    osmdroidBasePath = File(context.cacheDir, "osmdroid")
                    osmdroidTileCache = File(context.cacheDir, "osmdroid/tiles")
                }
                MapView(context).apply {
                    // Torn down by [onRelease] alone, not by leaving the
                    // window. Navigation moves a screen's content between
                    // panes — a phone turned to landscape goes from one pane
                    // to list and detail side by side — which takes this view
                    // out of the window and puts it back. By default osmdroid
                    // reads that as the end and shuts its tile loaders down,
                    // and the map came back grey and never loaded another tile.
                    setDestroyMode(false)
                    setTileSource(TemplateTileSource(setup.tileUrl, setup.minZoom, setup.maxZoom, setup.attribution))
                    setMultiTouchControls(true)
                    zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
                    setTilesScaledToDpi(true)
                    isHorizontalMapRepetitionEnabled = true
                    isVerticalMapRepetitionEnabled = false
                    setScrollableAreaLimitLatitude(MapView.getTileSystem().maxLatitude, MapView.getTileSystem().minLatitude, 0)
                    minZoomLevel = setup.minZoom.toDouble().coerceAtLeast(2.0)
                    maxZoomLevel = setup.maxZoom.toDouble()
                    controller.setZoom(setup.zoom.coerceIn(2.0, 17.0))
                    controller.setCenter(GeoPoint(setup.centerLat ?: 32.0, setup.centerLng ?: 53.0))
                    overlays.add(overlay)
                    // The first framing needs a size, which `update` — run as
                    // the view attaches, before layout — does not have yet.
                    addOnFirstLayoutListener { _, _, _, _, _ ->
                        if (!fitted[0] && canFrame(this, overlay.pins)) {
                            fitted[0] = true
                            frame(this, overlay.pins)
                        }
                    }
                    onResume()
                }
            },
            update = { map ->
                overlay.pins = pins
                overlay.selected = selectedId
                map.overlayManager.tilesOverlay.setColorFilter(if (dark) DIM else null)
                if (!fitted[0] && canFrame(map, pins)) {
                    fitted[0] = true
                    frame(map, pins)
                }
                map.invalidate()
            },
            onRelease = { map -> map.onDetach() },
        )
        // The tiles' credit, which their licence asks for.
        Surface(
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.78f),
            shape = RoundedCornerShape(6.dp),
            modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp),
        ) {
            Text(
                setup.attribution,
                fontSize = 9.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

/** The margin [frame] keeps around the dots, in pixels, on every side. */
private const val FRAME_BORDER_PX = 48

/**
 * Whether [frame] can frame [pins] in the map as it is laid out now.
 *
 * Several dots are framed by fitting their box inside the map less the
 * border, and osmdroid computes that zoom from the logarithm of what is left:
 * a map no taller (or wider) than the two borders — a phone in landscape,
 * where the header, the numbers and the filters leave the map a sliver, or
 * none — gets a NaN zoom. osmdroid keeps it: the map is blank from then on,
 * pinch and all, and being framed once it is never framed again. Until the
 * map has the room, it is left at its opening view and the next update tries
 * again.
 */
private fun canFrame(map: MapView, pins: List<VisitorPin>): Boolean = when {
    pins.isEmpty() || map.width <= 0 -> false
    pins.size == 1 -> true
    else -> map.width > 2 * FRAME_BORDER_PX && map.height > 2 * FRAME_BORDER_PX
}

/** Frames every dot, no closer than a country. */
private fun frame(map: MapView, pins: List<VisitorPin>) {
    if (pins.size == 1) {
        map.controller.setZoom(5.0)
        map.controller.setCenter(GeoPoint(pins[0].lat, pins[0].lng))
        return
    }
    val box = BoundingBox.fromGeoPoints(pins.map { GeoPoint(it.lat, it.lng) })
    map.zoomToBoundingBox(box.increaseByScale(1.4f), false, FRAME_BORDER_PX)
    if (map.zoomLevelDouble > 6.0) map.controller.setZoom(6.0)
}

/** Flies to [pin], zooming in to at least country level. */
fun flyTo(map: MapView, pin: VisitorPin) {
    map.controller.animateTo(GeoPoint(pin.lat, pin.lng), maxOf(map.zoomLevelDouble, 5.0), 600L)
}

private class PinColors(val online: Int, val idle: Int, val offline: Int, val ring: Int)

/** The dots, drawn straight onto the map and tapped by distance. */
private class PinsOverlay(
    private val onTap: (String) -> Unit,
) : Overlay() {
    /** Pixels per dp, set by the composable as it composes. */
    var density: Float = 1f
    var pins: List<VisitorPin> = emptyList()
    var selected: String? = null
    var colors = PinColors(0xFF22C55E.toInt(), 0xFFF5A524.toInt(), 0xFF98A2B3.toInt(), 0xFF3B82F6.toInt())

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val point = Point()

    override fun draw(canvas: Canvas, mapView: MapView, shadow: Boolean) {
        if (shadow) return
        val projection = mapView.projection
        // The selected dot last, so it sits on top of any it overlaps.
        for (pin in pins.sortedBy { it.id == selected }) {
            projection.toPixels(GeoPoint(pin.lat, pin.lng), point)
            val chosen = pin.id == selected
            val radius = (if (chosen) 9.5f else 7f) * density
            val color = when (pin.status) {
                "online" -> colors.online
                "idle" -> colors.idle
                else -> colors.offline
            }
            if (pin.status == "online") {
                fill.color = color
                fill.alpha = 56
                canvas.drawCircle(point.x.toFloat(), point.y.toFloat(), radius * 1.9f, fill)
            }
            fill.color = color
            fill.alpha = 255
            canvas.drawCircle(point.x.toFloat(), point.y.toFloat(), radius, fill)
            stroke.color = if (chosen) colors.ring else 0xFFFFFFFF.toInt()
            stroke.strokeWidth = 2f * density
            canvas.drawCircle(point.x.toFloat(), point.y.toFloat(), radius, stroke)
        }
    }

    override fun onSingleTapConfirmed(e: MotionEvent, mapView: MapView): Boolean {
        val projection = mapView.projection
        var best: VisitorPin? = null
        var bestDistance = TAP_SLOP_DP * density
        for (pin in pins) {
            projection.toPixels(GeoPoint(pin.lat, pin.lng), point)
            val d = hypot(point.x - e.x, point.y - e.y)
            if (d <= bestDistance) {
                best = pin
                bestDistance = d
            }
        }
        best ?: return false
        onTap(best.id)
        return true
    }

    private companion object {
        const val TAP_SLOP_DP = 24f
    }
}

/**
 * An XYZ template — `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` —
 * as a tile source: `{s}` rotates through a, b and c, `{r}` (a retina suffix
 * some providers take) is left empty.
 */
private class TemplateTileSource(
    private val template: String,
    minZoom: Int,
    maxZoom: Int,
    attribution: String,
) : OnlineTileSourceBase("webyar-${template.hashCode()}", minZoom, maxZoom, 256, ".png", arrayOf(template), attribution) {
    override fun getTileURLString(pMapTileIndex: Long): String {
        val z = MapTileIndex.getZoom(pMapTileIndex)
        val x = MapTileIndex.getX(pMapTileIndex)
        val y = MapTileIndex.getY(pMapTileIndex)
        return template
            .replace("{z}", z.toString())
            .replace("{x}", x.toString())
            .replace("{y}", y.toString())
            .replace("{s}", "abc"[Math.floorMod(x + y, 3)].toString())
            .replace("{r}", "")
    }
}

/** The light tiles, dimmed for a dark screen rather than glaring from it. */
private val DIM = ColorMatrixColorFilter(
    ColorMatrix().apply {
        setSaturation(0.55f)
        postConcat(ColorMatrix(floatArrayOf(0.62f, 0f, 0f, 0f, 0f, 0f, 0.62f, 0f, 0f, 0f, 0f, 0f, 0.66f, 0f, 0f, 0f, 0f, 0f, 1f, 0f)))
    },
)
