package com.webyar.operator.feature.settings

import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.AccountProfile
import com.webyar.operator.core.model.AccountSessionsResponse
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The account screens' rules.
 *
 * Both screens share one view model, so the tests are in one file for the
 * same reason the code is in one class: a password change invalidates the
 * session list, and the two halves have to agree about that without telling
 * each other.
 *
 * Plain JUnit rather than Robolectric — nothing here draws.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    /** Built and settled: `init` loads the profile and the sessions. */
    private fun TestScope.model(api: StubAccountApi = StubAccountApi()) =
        AccountViewModel(api) { Language.FA }.also { testScheduler.advanceUntilIdle() }

    // MARK: - The profile form

    @Test
    fun `opening the screen fills the name from the account`() = runTest(dispatcher) {
        val account = model()
        assertEquals("Sara Karimi", account.profile.value.name)
        assertEquals("operator@webyar.app", account.profile.value.email)
        assertTrue(account.profile.value.loaded)
    }

    /**
     * The reason `loaded` exists.
     *
     * Saving re-reads the account, and any refresh that lands while somebody
     * is halfway through typing their name would put the old one back under
     * the cursor.
     */
    @Test
    fun `a refresh does not overwrite a name being typed`() = runTest(dispatcher) {
        val account = model()

        account.setFirstName("رضا")
        account.setLastName("نوری")
        account.loadProfile()
        testScheduler.advanceUntilIdle()

        assertEquals("رضا نوری", account.profile.value.name)
    }

    /**
     * Editing one part leaves the other where it was.
     *
     * The stored name arrives as one string and is split for the form, so a
     * refresh landing mid-edit must not re-split the server's copy over the
     * half the operator has already changed.
     */
    @Test
    fun `changing the first name leaves the family name alone`() = runTest(dispatcher) {
        val account = model()

        account.setFirstName("رضا")
        account.loadProfile()
        testScheduler.advanceUntilIdle()

        assertEquals("رضا", account.profile.value.firstName)
        assertEquals("Karimi", account.profile.value.lastName)
    }

    @Test
    fun `an empty name is not saved at all`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.setFirstName("   ")
        account.saveProfile()
        testScheduler.advanceUntilIdle()

        assertEquals(0, api.profileSaves)
        // And no spinner left running on a request that never left.
        assertFalse(account.profile.value.busy)
    }

    @Test
    fun `a saved name is trimmed and reported back`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)
        var done = false

        account.setFirstName("  رضا  ")
        account.setLastName("  نوری  ")
        account.saveProfile { done = true }
        testScheduler.advanceUntilIdle()

        // The parts are what travels now; the route composes `full_name`.
        assertEquals("رضا", api.lastSavedFirst)
        assertEquals("نوری", api.lastSavedLast)
        assertEquals("رضا نوری", account.profile.value.name)
        assertFalse(account.profile.value.busy)
        assertTrue(done)
    }

    @Test
    fun `a failed save says why, in the operator's language`() = runTest(dispatcher) {
        val api = StubAccountApi(profileError = ApiError.Server(403, "Forbidden"))
        val account = model(api)
        var done = false

        account.setFirstName("رضا")
        account.saveProfile { done = true }
        testScheduler.advanceUntilIdle()

        assertEquals(Str.errorNotAllowed(Language.FA), account.profile.value.error)
        assertFalse(account.profile.value.busy)
        // The screen must not navigate away from a save that did not happen.
        assertFalse(done)
    }

    @Test
    fun `typing again clears the last error`() = runTest(dispatcher) {
        val api = StubAccountApi(profileError = ApiError.Transport())
        val account = model(api)

        account.setFirstName("رضا")
        account.saveProfile()
        testScheduler.advanceUntilIdle()
        assertNotNull(account.profile.value.error)

        account.setFirstName("رضا ن")
        assertNull(account.profile.value.error)
    }

    /**
     * Super Admin locked the name (the default): it is not in the request at
     * all, so a rename made on the web meanwhile is not written back over.
     */
    @Test
    fun `a locked name is left out of the save`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.setPhone("+989121234567")
        account.saveProfile(nameEditable = false, phoneEditable = true)
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.profileSaves)
        assertNull("the name travelled although it is locked", api.lastSavedFirst)
        assertNull(api.lastSavedLast)
        assertEquals("+989121234567", api.lastSavedPhone)
    }

    @Test
    fun `a locked phone is left out of the save`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.setFirstName("رضا")
        account.saveProfile(nameEditable = true, phoneEditable = false)
        testScheduler.advanceUntilIdle()

        assertEquals("رضا", api.lastSavedFirst)
        assertNull("the phone travelled although it is locked", api.lastSavedPhone)
    }

    /** With the name locked, an empty first name is no reason to refuse. */
    @Test
    fun `a locked empty name does not block saving the phone`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.setFirstName("")
        account.saveProfile(nameEditable = false, phoneEditable = true)
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.profileSaves)
    }

    @Test
    fun `nothing editable means nothing is sent`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.saveProfile(nameEditable = false, phoneEditable = false)
        testScheduler.advanceUntilIdle()

        assertEquals(0, api.profileSaves)
        assertFalse(account.profile.value.busy)
    }

    // MARK: - The avatar

    /**
     * The cap is checked here, before the upload, because the server has the
     * same one. Sending four megabytes up a metered connection to be told no
     * is somebody's money.
     */
    @Test
    fun `a photo over the cap never leaves the phone`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)

        account.uploadAvatar(ByteArray(2 * 1024 * 1024 + 1), "image/jpeg", "big.jpg")
        testScheduler.advanceUntilIdle()

        assertEquals(0, api.uploadCalls)
        assertEquals(Str.photoTooLarge(Language.FA), account.profile.value.error)
        assertFalse(account.profile.value.busy)
    }

    @Test
    fun `a photo under the cap is uploaded and shown`() = runTest(dispatcher) {
        val api = StubAccountApi(
            avatarAnswer = AccountProfile(id = "u-1", avatarUrl = "https://cdn/av.png"),
        )
        val account = model(api)

        account.uploadAvatar(ByteArray(64 * 1024), "image/png", "small.png")
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.uploadCalls)
        assertEquals("https://cdn/av.png", account.profile.value.avatarUrl)
        assertFalse(account.profile.value.busy)
    }

    @Test
    fun `removing the avatar clears it`() = runTest(dispatcher) {
        val api = StubAccountApi(
            accountAnswer = Account(
                id = "u-1",
                email = "operator@webyar.app",
                profile = AccountProfile(id = "u-1", fullName = "Sara", avatarUrl = "https://cdn/old.png"),
            ),
        )
        val account = model(api)
        assertEquals("https://cdn/old.png", account.profile.value.avatarUrl)

        account.removeAvatar()
        testScheduler.advanceUntilIdle()

        assertNull(account.profile.value.avatarUrl)
        assertFalse(account.profile.value.busy)
    }

    // MARK: - Security

    @Test
    fun `the session list arrives with the current one named`() = runTest(dispatcher) {
        val account = model()
        val security = account.security.value

        assertEquals(listOf("s-1", "s-2"), security.sessions.map { it.id })
        assertEquals("s-1", security.currentSessionId)
    }

    /**
     * Two things at once, and both matter: the fields are emptied because a
     * password left in a box is a password on screen, and the session list is
     * re-read because the server has just ended the other sessions.
     */
    @Test
    fun `a changed password empties the fields and re-reads the sessions`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)
        val loadsBefore = api.sessionLoads

        account.setCurrentPassword("old-one")
        account.setNewPassword("a-much-better-one")
        account.changePassword()
        testScheduler.advanceUntilIdle()

        assertEquals("old-one" to "a-much-better-one", api.lastPassword)
        assertEquals("", account.security.value.currentPassword)
        assertEquals("", account.security.value.newPassword)
        assertEquals(Str.passwordChanged(Language.FA), account.security.value.message)
        assertFalse(account.security.value.isError)
        assertFalse(account.security.value.busy)
        assertEquals(loadsBefore + 1, api.sessionLoads)
    }

    /**
     * A rejected change keeps what was typed. Emptying the boxes on failure
     * makes somebody type a long password again to find out they mistyped the
     * short one.
     */
    @Test
    fun `a rejected password change keeps what was typed`() = runTest(dispatcher) {
        val api = StubAccountApi(passwordError = ApiError.Server(400, "Wrong password"))
        val account = model(api)

        account.setCurrentPassword("wrong")
        account.setNewPassword("new-one")
        account.changePassword()
        testScheduler.advanceUntilIdle()

        assertEquals("wrong", account.security.value.currentPassword)
        assertEquals("new-one", account.security.value.newPassword)
        assertEquals(Str.errorInvalidInput(Language.FA), account.security.value.message)
        assertTrue(account.security.value.isError)
        assertFalse(account.security.value.busy)
    }

    @Test
    fun `revoking a session re-reads the list`() = runTest(dispatcher) {
        val api = StubAccountApi()
        val account = model(api)
        val loadsBefore = api.sessionLoads

        account.revoke(account.security.value.sessions.first())
        testScheduler.advanceUntilIdle()

        assertEquals(loadsBefore + 1, api.sessionLoads)
        assertFalse(account.security.value.isError)
    }

    @Test
    fun `a revoke that fails says so and leaves the list alone`() = runTest(dispatcher) {
        val api = StubAccountApi(revokeError = ApiError.Server(500, null))
        val account = model(api)
        val before = account.security.value.sessions
        val loadsBefore = api.sessionLoads

        account.revoke(before.first())
        testScheduler.advanceUntilIdle()

        assertEquals(Str.errorServerProblem(Language.FA), account.security.value.message)
        assertTrue(account.security.value.isError)
        assertEquals(before, account.security.value.sessions)
        assertEquals(loadsBefore, api.sessionLoads)
    }

    @Test
    fun `typing a password clears the last message`() = runTest(dispatcher) {
        val api = StubAccountApi(passwordError = ApiError.Transport())
        val account = model(api)

        account.setCurrentPassword("a")
        account.setNewPassword("b")
        account.changePassword()
        testScheduler.advanceUntilIdle()
        assertNotNull(account.security.value.message)

        account.setNewPassword("bc")
        assertNull(account.security.value.message)
    }

    /**
     * The sample backend with the account endpoints replaced, so a test can
     * say what the server does and count what was asked of it.
     */
    private class StubAccountApi(
        private val real: SampleApi = SampleApi(),
        private val accountAnswer: Account? = null,
        private val profileError: Throwable? = null,
        private val avatarAnswer: AccountProfile? = null,
        private val avatarError: Throwable? = null,
        private val passwordError: Throwable? = null,
        private val revokeError: Throwable? = null,
    ) : WebyarApi by real {

        var uploadCalls = 0
            private set
        var profileSaves = 0
            private set
        var sessionLoads = 0
            private set
        var lastSavedName: String? = null
            private set
        var lastPassword: Pair<String, String>? = null
            private set

        override suspend fun account(): Account = accountAnswer ?: real.account()

        var lastSavedFirst: String? = null
            private set
        var lastSavedLast: String? = null
            private set
        var lastSavedPhone: String? = null
            private set

        override suspend fun updateProfile(
            fullName: String?,
            preferredLocale: String?,
            firstName: String?,
            lastName: String?,
            phone: String?,
        ): Account {
            profileSaves++
            lastSavedName = fullName
            lastSavedFirst = firstName
            lastSavedLast = lastName
            lastSavedPhone = phone
            profileError?.let { throw it }
            // What the route does: compose the stored name from the two parts.
            val composed = listOfNotNull(firstName, lastName)
                .map { it.trim() }.filter { it.isNotEmpty() }
                .joinToString(" ").ifEmpty { fullName }
            return Account(
                id = "u-1",
                email = "operator@webyar.app",
                phone = phone?.ifEmpty { null },
                profile = AccountProfile(id = "u-1", fullName = composed),
            )
        }

        override suspend fun uploadAvatar(
            bytes: ByteArray,
            contentType: String,
            fileName: String?,
        ): AccountProfile? {
            uploadCalls++
            avatarError?.let { throw it }
            return avatarAnswer
        }

        override suspend fun sessions(): AccountSessionsResponse {
            sessionLoads++
            return real.sessions()
        }

        override suspend fun changePassword(current: String, new: String) {
            lastPassword = current to new
            passwordError?.let { throw it }
        }

        override suspend fun revokeSession(id: String) {
            revokeError?.let { throw it }
        }
    }
}
