package com.webyar.operator.feature.visitors

import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Point
import android.view.MotionEvent
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.webyar.operator.ui.design.WebyarTheme
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
    val dark = isSystemInDarkTheme()
    val online = WebyarTheme.colors.success.toArgb()
    val brand = MaterialTheme.colorScheme.primary.toArgb()
    val pick = rememberUpdatedState(onPick)
    val overlay = remember(density) { PinsOverlay(density) { pick.value(it) } }
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
                    if (dark) overlayManager.tilesOverlay.setColorFilter(DIM)
                    overlays.add(overlay)
                    onResume()
                }
            },
            update = { map ->
                overlay.pins = pins
                overlay.selected = selectedId
                if (!fitted[0] && pins.isNotEmpty() && map.width > 0) {
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

/** Frames every dot, no closer than a country. */
private fun frame(map: MapView, pins: List<VisitorPin>) {
    if (pins.size == 1) {
        map.controller.setZoom(5.0)
        map.controller.setCenter(GeoPoint(pins[0].lat, pins[0].lng))
        return
    }
    val box = BoundingBox.fromGeoPoints(pins.map { GeoPoint(it.lat, it.lng) })
    map.zoomToBoundingBox(box.increaseByScale(1.4f), false, 48)
    if (map.zoomLevelDouble > 6.0) map.controller.setZoom(6.0)
}

/** Flies to [pin], zooming in to at least country level. */
fun flyTo(map: MapView, pin: VisitorPin) {
    map.controller.animateTo(GeoPoint(pin.lat, pin.lng), maxOf(map.zoomLevelDouble, 5.0), 600L)
}

private class PinColors(val online: Int, val idle: Int, val offline: Int, val ring: Int)

/** The dots, drawn straight onto the map and tapped by distance. */
private class PinsOverlay(
    private val density: Float,
    private val onTap: (String) -> Unit,
) : Overlay() {
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
