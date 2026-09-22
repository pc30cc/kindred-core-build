package com.webyar.operator.core.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone has to say which surface it is.
 *
 * Preferences are stored per surface. `server/routes/notifications.ts` reads
 * `platform` from the query on a GET and from the body on a PATCH, and when a
 * request does not say, it answers 'web' — deliberately, because the console
 * shipped before that column existed and a tab open right now still asks the
 * old way.
 *
 * So silence is not a default here, it is the wrong row: a phone that omits
 * `platform` reads and writes the browser's settings. This was live — the
 * response captured from a device read `"platform":"web"` — and these are the
 * assertions that stop it coming back.
 */
class NotificationSurfaceTest {

    private val json = Json { encodeDefaults = false }

    @Test
    fun thisAppCallsItselfMobile() {
        assertEquals("mobile", NotificationPrefs.SURFACE)
    }

    /**
     * `encodeDefaults = false` is what keeps a PATCH down to the one field that
     * changed, and it would drop the surface along with everything else. The
     * `@EncodeDefault(ALWAYS)` on that field is the exception, so this asserts
     * the exception still holds.
     */
    @Test
    fun everyUpdateCarriesTheSurfaceEvenThoughNothingSetsIt() {
        val body = json.encodeToString(
            NotificationPrefsUpdate.serializer(),
            NotificationPrefsUpdate(pushScope = "none"),
        )

        assertEquals("""{"platform":"mobile","push_scope":"none"}""", body)
    }

    /** An empty update still names the surface, and still carries nothing else. */
    @Test
    fun theSurfaceIsTheOnlyThingAnEmptyUpdateSends() {
        val body = json.encodeToString(
            NotificationPrefsUpdate.serializer(),
            NotificationPrefsUpdate(),
        )

        assertEquals("""{"platform":"mobile"}""", body)
    }

    /**
     * The point of the field is that it does not crowd out the PATCH's real
     * job: one preference in, one preference on the wire.
     */
    @Test
    fun oneChangedPreferenceIsStillTheOnlyPreferenceSent() {
        val body = json.encodeToString(
            NotificationPrefsUpdate.serializer(),
            NotificationPrefsUpdate(disableAll = true),
        )

        assertTrue(body, body.contains(""""disable_all":true"""))
        // Anything else would overwrite a value this screen never touched.
        assertEquals(2, body.split(",").size)
    }
}
