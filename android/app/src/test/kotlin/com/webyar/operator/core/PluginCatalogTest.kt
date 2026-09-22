package com.webyar.operator.core

import com.webyar.operator.core.model.PluginCatalogResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The channel switcher reads `/api/plugins/catalog`, and that endpoint
 * answers in camelCase while most of this API is snake_case.
 *
 * The fields were annotated to match the rest — `supports_inbox`,
 * `plan_allowed` — so they decoded to null on every item, `isUsableInbox` was
 * false for every channel, and the switcher stayed empty on a workspace with
 * Telegram installed and allowed. Nothing threw. The list was simply always
 * empty, which is why this is pinned against the server's real bytes.
 */
class PluginCatalogTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    /** Trimmed from an actual answer, keys and casing untouched. */
    private val body = """
        {"items":[
          {"id":"telegram","slug":"telegram","category":"channels","supportsInbox":true,
           "planChannelKey":"telegram","enabled":true,"planAllowed":true,
           "installed":true,"installationStatus":"installed"},
          {"id":"x","slug":"x","category":"channels","supportsInbox":true,
           "enabled":true,"planAllowed":false,"installed":false,"installationStatus":null},
          {"id":"whatsapp","slug":"whatsapp","category":"channels","supportsInbox":true,
           "enabled":true,"planAllowed":true,"installed":false,"installationStatus":null}
        ]}
    """.trimIndent()

    @Test
    fun `camelCase fields actually decode`() {
        val items = json.decodeFromString<PluginCatalogResponse>(body).items.orEmpty()
        val telegram = items.first { it.slug == "telegram" }

        assertEquals(true, telegram.supportsInbox)
        assertEquals(true, telegram.planAllowed)
        assertEquals("installed", telegram.installationStatus)
    }

    @Test
    fun `an installed, allowed, inbox-capable channel is offered`() {
        val items = json.decodeFromString<PluginCatalogResponse>(body).items.orEmpty()
        assertTrue(items.first { it.slug == "telegram" }.isUsableInbox)
    }

    @Test
    fun `a channel the plan refuses is not offered, installed or not`() {
        val items = json.decodeFromString<PluginCatalogResponse>(body).items.orEmpty()
        assertFalse(items.first { it.slug == "x" }.isUsableInbox)
    }

    /** Allowed by the plan but never connected: nothing would arrive in it. */
    @Test
    fun `a channel that is not installed is not offered`() {
        val items = json.decodeFromString<PluginCatalogResponse>(body).items.orEmpty()
        assertFalse(items.first { it.slug == "whatsapp" }.isUsableInbox)
    }

    @Test
    fun `exactly the usable ones survive the filter`() {
        val usable = json.decodeFromString<PluginCatalogResponse>(body)
            .items.orEmpty().filter { it.isUsableInbox }.mapNotNull { it.slug }
        assertEquals(listOf("telegram"), usable)
    }
}
