package com.webyar.ai.core.push

import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.webyar.ai.core.Diag
import com.webyar.ai.core.model.FirebaseClientConfig
import com.webyar.ai.core.model.MobileAppConfig
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Push on Android starts Firebase with the project Super Admin sets — read
 * from the app's config, kept, and used at every launch after, including the
 * cold start a push itself causes. A build that carries its own project keeps
 * it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushConfigTest {

    private val context get() = ApplicationProvider.getApplicationContext<android.app.Application>()

    private val project = FirebaseClientConfig(
        appId = "1:123456789012:android:0a1b2c3d4e5f6a7b",
        apiKey = "AIzaSyDq3b7mX0v9QeLr4TnKw2HsZc5Uf8Ga1pE",
        projectId = "webyar-app",
        senderId = "123456789012",
    )

    private fun stopFirebase() = FirebaseApp.getApps(context).forEach { it.delete() }

    @Before fun setUp() {
        stopFirebase()
        context.getSharedPreferences("webyar.firebase", 0).edit().clear().commit()
    }

    @After fun tearDown() = stopFirebase()

    @Test
    fun `the server's config carries the project, and an older server's carries none`() {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
        val config = json.decodeFromString(
            MobileAppConfig.serializer(),
            """{"platform":"android","showStorage":true,"firebase":{"appId":"${project.appId}","apiKey":"${project.apiKey}","projectId":"webyar-app","senderId":"123456789012"}}""",
        )
        assertEquals(project, config.firebase)
        assertNull(json.decodeFromString(MobileAppConfig.serializer(), """{"platform":"android","firebase":null}""").firebase)
        assertNull(json.decodeFromString(MobileAppConfig.serializer(), """{"platform":"android"}""").firebase)
    }

    @Test
    fun `the build's own project wins, and a partial set is no project`() {
        val other = project.copy(projectId = "someone-else", appId = "1:999999999999:android:ffff0000ffff0000", senderId = "999999999999")
        assertEquals(other, PushConfig.choose(build = other, stored = project))
        assertEquals(project, PushConfig.choose(build = null, stored = project))
        assertNull(PushConfig.choose(build = null, stored = project.copy(apiKey = "")))
        assertNull(PushConfig.choose(build = null, stored = null))
    }

    @Test
    fun `Super Admin's project starts Firebase once, and is there at the next launch`() {
        assertFalse("no project yet: push stays off", PushConfig.initialize(context, Diag.Silent))

        assertTrue("just started: the caller registers now", PushConfig.adopt(context, project, Diag.Silent))
        assertTrue(PushConfig.isReady(context))
        assertEquals("webyar-app", FirebaseApp.getInstance().options.projectId)
        assertFalse("already running: nothing more to do", PushConfig.adopt(context, project, Diag.Silent))

        // The next launch — or a push waking a killed process — before any
        // config has been read again.
        stopFirebase()
        assertTrue(PushConfig.initialize(context, Diag.Silent))
        assertEquals("123456789012", FirebaseApp.getInstance().options.gcmSenderId)
    }

    @Test
    fun `nothing, or a partial set, leaves the kept project alone`() {
        PushConfig.adopt(context, project, Diag.Silent)
        assertFalse(PushConfig.adopt(context, null, Diag.Silent))
        assertFalse(PushConfig.adopt(context, project.copy(senderId = ""), Diag.Silent))
        assertEquals(project, PushConfig.stored(context))
    }
}
