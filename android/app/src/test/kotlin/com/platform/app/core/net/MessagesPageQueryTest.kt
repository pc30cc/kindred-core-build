package com.platform.app.core.net

import com.platform.app.core.model.OlderCursor
import io.ktor.http.Url
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The thread read's query as it goes on the wire (docs/operations/THREAD_PAGING_APPS.md). */
class MessagesPageQueryTest {

    private val older = OlderCursor("2026-11-08T10:00:00.123456+00:00", "4443f8b3-d060-4b9f-90f7-c9b5dbc6c83e")

    @Test
    fun `an older page sends the cursor exactly, its plus encoded`() {
        val query = queryString(messagesPageQuery(null, 100, older))
        assertTrue(query, "%2B00%3A00" in query)
        assertTrue(query, "+" !in query)
        // What the HTTP client sends, parsed back: the server's own string.
        val url = Url("https://api.example/api/conversations/c-1/messages?$query")
        assertEquals("100", url.parameters["limit"])
        assertEquals(older.before, url.parameters["before"])
        assertEquals(older.beforeId, url.parameters["before_id"])
    }

    @Test
    fun `a delta sends only since, never a page`() {
        assertEquals(listOf("since" to "2026-11-08T10:00:00.000Z"), messagesPageQuery("2026-11-08T10:00:00.000Z", 100, older))
    }

    @Test
    fun `a newest page sends only its limit`() {
        assertEquals(listOf("limit" to "100"), messagesPageQuery(null, 100, null))
        assertEquals(emptyList<Pair<String, String>>(), messagesPageQuery(" ", null, null))
    }
}
