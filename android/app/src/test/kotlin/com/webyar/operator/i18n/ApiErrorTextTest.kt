package com.webyar.operator.i18n

import com.webyar.operator.core.net.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * What an operator is told when a request fails.
 *
 * This is a policy rather than a lookup table, and the policy is the thing
 * worth pinning: the server answers every client in English, so the app says
 * it in the operator's language and shows the server's own wording only where
 * the interface is already English.
 *
 * Plain JUnit, no Robolectric: none of this touches a Context.
 */
class ApiErrorTextTest {

    // MARK: - The connection is not always the answer

    /**
     * The fault that prompted these tests.
     *
     * Every status the `when` did not name fell through to "check your
     * connection", including 403 and 500. The server ANSWERED in both cases,
     * so the connection is the one part of the system that has just proved it
     * works — and an operator who is told to check it over a permission
     * error will check it, repeatedly, and get nowhere.
     */
    @Test
    fun `a status the server answered never blames the connection`() {
        val offline = Str.offlineBody(Language.FA)
        for (status in listOf(400, 403, 404, 409, 418, 422, 429, 451, 500, 502, 503)) {
            val text = ApiError.Server(status, null).text(Language.FA)
            assertNotEquals("status $status blamed the connection", offline, text)
        }
    }

    @Test
    fun `403 says not allowed, not signed out`() {
        val text = ApiError.Server(403, null).text(Language.FA)
        assertEquals(Str.errorNotAllowed(Language.FA), text)
        // And emphatically not the session-expired line: `ApiClient.orThrow`
        // keeps 403 out of `Unauthorized` precisely so one endpoint refusing
        // cannot read as the whole session going.
        assertNotEquals(Str.sessionExpired(Language.FA), text)
    }

    @Test
    fun `the 500s say the server broke`() {
        for (status in listOf(500, 502, 503, 504)) {
            assertEquals(
                "status $status",
                Str.errorServerProblem(Language.FA),
                ApiError.Server(status, null).text(Language.FA),
            )
        }
    }

    @Test
    fun `the named 4xx each keep their own wording`() {
        fun fa(status: Int) = ApiError.Server(status, null).text(Language.FA)
        assertEquals(Str.errorInvalidInput(Language.FA), fa(400))
        assertEquals(Str.errorInvalidInput(Language.FA), fa(422))
        assertEquals(Str.errorNotFound(Language.FA), fa(404))
        assertEquals(Str.errorConflict(Language.FA), fa(409))
        assertEquals(Str.errorTooManyRequests(Language.FA), fa(429))
    }

    /** A 4xx nobody has met yet is still a rejected request, not an outage. */
    @Test
    fun `an unnamed 4xx falls back to invalid input`() {
        assertEquals(Str.errorInvalidInput(Language.FA), ApiError.Server(418, null).text(Language.FA))
        assertEquals(Str.errorInvalidInput(Language.TR), ApiError.Server(451, null).text(Language.TR))
    }

    // MARK: - Whose words

    /**
     * The server's sentence is strictly more specific than anything here —
     * but it is an English sentence, and only an English interface can show
     * it without putting English under a Persian heading.
     */
    @Test
    fun `English shows the server's own words`() {
        val error = ApiError.Server(400, "Invalid email or password")
        assertEquals("Invalid email or password", error.text(Language.EN))
    }

    @Test
    fun `Persian and Turkish say it themselves`() {
        val error = ApiError.Server(400, "Invalid email or password")
        assertEquals(Str.errorInvalidInput(Language.FA), error.text(Language.FA))
        assertEquals(Str.errorInvalidInput(Language.TR), error.text(Language.TR))
    }

    /** An empty message is not a message; fall back rather than show nothing. */
    @Test
    fun `English with no server message falls back to its own`() {
        assertEquals(Str.errorNotFound(Language.EN), ApiError.Server(404, "").text(Language.EN))
        assertEquals(Str.errorNotFound(Language.EN), ApiError.Server(404, null).text(Language.EN))
    }

    // MARK: - The other three kinds

    @Test
    fun `transport is the one that really is the connection`() {
        assertEquals(Str.offlineBody(Language.FA), ApiError.Transport().text(Language.FA))
        assertEquals(Str.offlineBody(Language.EN), ApiError.Transport(IOException("reset")).text(Language.EN))
    }

    /**
     * Unauthorized means a wrong password on the login screen and a session
     * that has gone everywhere else, so the caller names it and the default
     * covers the common case.
     */
    @Test
    fun `unauthorized takes the caller's wording when given one`() {
        assertEquals(Str.sessionExpired(Language.FA), ApiError.Unauthorized.text(Language.FA))
        assertEquals("رمز اشتباه است", ApiError.Unauthorized.text(Language.FA, "رمز اشتباه است"))
    }

    @Test
    fun `a decoding failure asks for an update, not a retry`() {
        val text = ApiError.Decoding().text(Language.FA)
        assertEquals(Str.errorUnreadableAnswer(Language.FA), text)
        assertNotEquals(Str.offlineBody(Language.FA), text)
    }

    // MARK: - Anything at all

    @Test
    fun `a throwable that is not an ApiError still says something`() {
        assertEquals(Str.offlineBody(Language.FA), IllegalStateException("boom").displayText(Language.FA))
        assertEquals(Str.offlineBody(Language.TR), IOException().displayText(Language.TR))
    }

    @Test
    fun `displayText routes an ApiError through the same policy`() {
        assertEquals(
            Str.errorNotAllowed(Language.FA),
            (ApiError.Server(403, null) as Throwable).displayText(Language.FA),
        )
    }

    // MARK: - Every language, every kind

    /**
     * Nothing may come back blank or leak a placeholder. A message that is
     * empty is a dialog with a title and no body, which is worse than the
     * wrong sentence: it looks like the app broke rather than the request.
     */
    @Test
    fun `every kind in every language says something`() {
        val errors = listOf(
            ApiError.Unauthorized,
            ApiError.Transport(),
            ApiError.Decoding(),
        ) + listOf(400, 403, 404, 409, 422, 429, 500, 599).map { ApiError.Server(it, null) }

        for (language in Language.entries) {
            for (error in errors) {
                val text = error.text(language)
                assertTrue("$error in $language was blank", text.isNotBlank())
                assertTrue("$error in $language looks like a key", !text.contains("_"))
            }
        }
    }
}
