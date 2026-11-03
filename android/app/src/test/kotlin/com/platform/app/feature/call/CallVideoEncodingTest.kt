package com.platform.app.feature.call

import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.VideoCodec
import io.livekit.android.room.track.VideoEncoding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max

/**
 * What a call's camera is sent at ([CallVideoEncoding]), held to the numbers
 * chosen to halve a call's traffic after the calls on Iranian mobile data
 * measured on 2026-11-03.
 *
 * The SDK's own types, not a copy of the numbers: they are plain Kotlin, and
 * [VideoEncoding.toRtpEncoding] builds WebRTC's Java `RtpParameters.Encoding`,
 * which needs no native library, so this runs on the JVM.
 */
class CallVideoEncodingTest {

    private val capture = CallVideoEncoding.captureDefaults
    private val publish = CallVideoEncoding.publishDefaults
    private val top = checkNotNull(publish.videoEncoding) { "no top layer named" }
    private val layers = checkNotNull(publish.simulcastLayers) { "no simulcast layers named" }

    @Test
    fun `the camera is the front one at 1280 x 720, as before`() {
        assertEquals(CameraPosition.FRONT, capture.position)
        assertEquals(1280, capture.captureParams.width)
        assertEquals(720, capture.captureParams.height)
        assertFalse(capture.isScreencast)
    }

    @Test
    fun `the full picture is sent at 1 Mbps and 24 fps`() {
        assertEquals(VideoEncoding(maxBitrate = 1_000_000, maxFps = 24), top)
    }

    @Test
    fun `simulcast stays on with two small layers, smallest first`() {
        assertTrue(publish.simulcast)
        assertEquals(listOf(320 to 180, 640 to 360), layers.map { it.capture.width to it.capture.height })
        assertEquals(
            listOf(VideoEncoding(maxBitrate = 120_000, maxFps = 15), VideoEncoding(maxBitrate = 400_000, maxFps = 20)),
            layers.map { it.encoding },
        )
    }

    @Test
    fun `VP8 with no SVC mode and no backup codec`() {
        assertEquals(VideoCodec.VP8.codecName, publish.videoCodec)
        assertNull(publish.scalabilityMode)
        assertNull(publish.backupCodec)
    }

    /** The units: WebRTC is handed bits per second and frames per second, the same numbers. */
    @Test
    fun `WebRTC is handed the same numbers`() {
        val full = top.toRtpEncoding()
        assertEquals(1_000_000, full.maxBitrateBps)
        assertEquals(24, full.maxFramerate)

        val low = layers[0].encoding.toRtpEncoding(rid = "q", scaleDownBy = 4.0)
        assertEquals(120_000, low.maxBitrateBps)
        assertEquals(15, low.maxFramerate)
        assertEquals(4.0, low.scaleResolutionDownBy!!, 0.0)
    }

    /**
     * The SDK scales each layer down by the capture's long side over the
     * layer's. Whole numbers, so each layer is exactly the size named, and the
     * same 16:9 as the capture.
     */
    @Test
    fun `the layers are a quarter and a half of the capture`() {
        val long = max(capture.captureParams.width, capture.captureParams.height).toDouble()
        assertEquals(listOf(4.0, 2.0), layers.map { long / max(it.capture.width, it.capture.height) })
        layers.forEach { assertEquals(16 * it.capture.height, 9 * it.capture.width) }
    }

    /** Never more than this: 1.52 Mbps with every layer sending, against 2.31 Mbps at LiveKit's defaults. */
    @Test
    fun `all three layers together stay within 1_52 Mbps`() {
        val total = top.maxBitrate + layers.sumOf { it.encoding.maxBitrate }
        assertEquals(1_520_000, total)
    }

    /** The SDK caps a layer at the top layer's rate anyway; this keeps the numbers honest about it. */
    @Test
    fun `no layer is faster than the full picture`() {
        layers.forEach { assertTrue(it.encoding.maxFps <= top.maxFps) }
    }
}
