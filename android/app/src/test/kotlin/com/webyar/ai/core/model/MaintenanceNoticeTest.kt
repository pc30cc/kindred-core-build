package com.webyar.ai.core.model

import com.webyar.ai.i18n.Language
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Super Admin's maintenance notice, as the app reads it. */
class MaintenanceNoticeTest {

    private val now = Instant.parse("2026-09-29T10:00:00Z")

    @Test
    fun `off is off, whatever else it says`() {
        assertFalse(MaintenanceNotice(enabled = false, until = "2026-09-30T00:00:00Z").isActive(now))
    }

    @Test
    fun `on without an end time stays on`() {
        assertTrue(MaintenanceNotice(enabled = true).isActive(now))
    }

    @Test
    fun `on until a moment still ahead, and off once it has passed`() {
        // Written with an offset, as a browser in Tehran sends it.
        val notice = MaintenanceNotice(enabled = true, until = "2026-09-29T14:00:00+03:30")
        assertEquals(Instant.parse("2026-09-29T10:30:00Z"), notice.untilInstant)
        assertTrue(notice.isActive(now))
        assertFalse(notice.isActive(Instant.parse("2026-09-29T10:30:00Z")))
    }

    @Test
    fun `an end time nobody can read does not end it`() {
        val notice = MaintenanceNotice(enabled = true, until = "tomorrow")
        assertNull(notice.untilInstant)
        assertTrue(notice.isActive(now))
    }

    @Test
    fun `the message is in the operator's language, else in the one it was written in`() {
        val notice = MaintenanceNotice(enabled = true, message = mapOf("fa" to "به‌زودی برمی‌گردیم", "en" to "  "))
        assertEquals("به‌زودی برمی‌گردیم", notice.message(Language.FA))
        // English was left blank, so an English operator reads the Persian.
        assertEquals("به‌زودی برمی‌گردیم", notice.message(Language.EN))
        assertNull(MaintenanceNotice(enabled = true).message(Language.TR))
    }

    @Test
    fun `the public config reads, and a server without the fields leaves them null`() {
        val json = Json { ignoreUnknownKeys = true }
        val config = json.decodeFromString(
            MobileAppConfig.serializer(),
            """{"platform":"android","defaultLanguage":"en","maintenance":{"enabled":true,"message":{"en":"Back soon"},"until":null}}""",
        )
        assertEquals("en", config.defaultLanguage)
        assertEquals("Back soon", config.maintenance?.message(Language.EN))
        assertTrue(config.maintenance!!.isActive(now))

        val older = json.decodeFromString(MobileAppConfig.serializer(), """{"showStorage":true}""")
        assertNull(older.defaultLanguage)
        assertNull(older.maintenance)
    }
}
