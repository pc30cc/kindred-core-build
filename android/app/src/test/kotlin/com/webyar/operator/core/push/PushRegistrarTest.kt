package com.webyar.operator.core.push

import com.webyar.operator.core.Diag
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The device registration's whole life: the first token, a rotated one, a
 * new workspace, the permission changing, signing out, somebody else
 * signing in.
 */
class PushRegistrarTest {

    private val api = ScriptedApi()

    private class Tokens : PushTokens {
        var token: String? = "token-1"
        var deleted = 0
        override suspend fun current(): String? = token
        override suspend fun delete() {
            deleted++
            token = "token-after-delete-$deleted"
        }
    }

    private class State : PushState {
        var device: String? = null
        var last: Pair<String, Long>? = null
        var session: PushSession? = null
        override suspend fun deviceId() = device
        override suspend fun setDeviceId(value: String) {
            device = value
        }
        override suspend fun lastRegistration() = last
        override suspend fun setLastRegistration(fingerprint: String?, at: Long) {
            last = fingerprint?.let { it to at }
        }
        override suspend fun session() = session
        override suspend fun setSession(session: PushSession?) {
            this.session = session
        }
    }

    private val tokens = Tokens()
    private val state = State()
    private var permission = "granted"
    private var retries = 0
    private var now = 1_000_000L

    private val registrar = PushRegistrar(
        api = api,
        tokens = tokens,
        state = state,
        permission = { permission },
        device = PushRegistrar.DeviceInfo("Pixel · Android 15", "1.0 (1)"),
        clock = { now },
        diag = Diag.Silent,
        scheduleRetry = { retries++ },
    )

    @Test
    fun `the first sign-in registers the token for android over fcm`() = runTest {
        assertEquals(PushResult.REGISTERED, registrar.bind(PushSession("user-a", "ws-1"), "sign-in"))

        val sent = api.registrations.single()
        assertEquals("token-1", sent.pushToken)
        assertEquals("android", sent.platform)
        assertEquals("fcm", sent.transport)
        assertEquals("granted", sent.permissionStatus)
        assertEquals("ws-1", sent.workspaceId)
        assertTrue(sent.deviceId.startsWith("android-"))
    }

    @Test
    fun `nothing is sent again while nothing changed`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        assertEquals(PushResult.UNCHANGED, registrar.sync("foreground"))
        assertEquals(1, api.registrations.size)
    }

    @Test
    fun `a stable device id across registrations`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        tokens.token = "token-2"
        registrar.onNewToken()
        assertEquals(api.registrations[0].deviceId, api.registrations[1].deviceId)
    }

    @Test
    fun `a rotated token is registered`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        tokens.token = "token-2"

        assertEquals(PushResult.REGISTERED, registrar.onNewToken())
        assertEquals("token-2", api.registrations.last().pushToken)
    }

    @Test
    fun `a workspace switch is registered`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        registrar.bind(PushSession("user-a", "ws-2"), "workspace")
        assertEquals("ws-2", api.registrations.last().workspaceId)
    }

    @Test
    fun `an unchanged registration is refreshed weekly`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        now += PushRegistrar.REFRESH_MS + 1
        assertEquals(PushResult.REGISTERED, registrar.sync("foreground"))
    }

    @Test
    fun `sign-out unregisters first, then deletes the token`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")

        registrar.beforeSignOut()
        registrar.afterSignOut()

        assertEquals(listOf(state.device), api.unregistrations)
        assertEquals(1, tokens.deleted)
        assertEquals(PushResult.SIGNED_OUT, registrar.sync("foreground"))
    }

    @Test
    fun `a sign-out that fails leaves the device registered again on the next sync`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")

        // The device row is gone, then the server refuses the sign-out: the
        // operator is still signed in and must still get notifications.
        registrar.beforeSignOut()

        assertEquals(PushResult.REGISTERED, registrar.sync("foreground"))
        assertEquals(2, api.registrations.size)
        assertEquals(0, tokens.deleted)
    }

    @Test
    fun `the next operator registers a new token under their own account`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")
        registrar.beforeSignOut()
        registrar.afterSignOut()

        assertEquals(PushResult.REGISTERED, registrar.bind(PushSession("user-b", "ws-9"), "sign-in"))
        val second = api.registrations.last()
        assertEquals("token-after-delete-1", second.pushToken)
        assertEquals("ws-9", second.workspaceId)
        // A's token is not the one B is registered with.
        assertTrue(api.registrations.first().pushToken != second.pushToken)
    }

    @Test
    fun `no permission, no registration`() = runTest {
        permission = "denied"
        assertEquals(PushResult.NOT_PERMITTED, registrar.bind(PushSession("user-a", "ws-1"), "sign-in"))
        assertTrue(api.registrations.isEmpty())
    }

    @Test
    fun `permission withdrawn unregisters, and granted again registers`() = runTest {
        registrar.bind(PushSession("user-a", "ws-1"), "sign-in")

        permission = "denied"
        assertEquals(PushResult.UNREGISTERED, registrar.sync("permission"))
        assertEquals(1, api.unregistrations.size)

        permission = "granted"
        assertEquals(PushResult.REGISTERED, registrar.sync("permission"))
        assertEquals(2, api.registrations.size)
    }

    @Test
    fun `a failed registration is handed to a retry`() = runTest {
        api.failRegistration = ApiError.Transport(null)
        assertEquals(PushResult.RETRY_LATER, registrar.bind(PushSession("user-a", "ws-1"), "sign-in"))
        assertEquals(1, retries)

        api.failRegistration = null
        assertEquals(PushResult.REGISTERED, registrar.sync("retry"))
    }

    @Test
    fun `a build without firebase registers nothing`() = runTest {
        tokens.token = null
        assertEquals(PushResult.UNAVAILABLE, registrar.bind(PushSession("user-a", "ws-1"), "sign-in"))
        assertTrue(api.registrations.isEmpty())
    }
}
