package com.webyar.ai.feature.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The card at the top of a platform-support conversation in the support
 * team's inbox: read from the notice's metadata exactly as the server writes
 * it (server/services/platformSupport/requester.ts).
 */
class RequesterCardTest {

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    private val meta = json(
        """
        {
          "kind": "platform_support_requester",
          "internal": true,
          "user": {
            "id": "u-1", "name": "Sara Ahmadi", "email": "sara@shop.example", "phone": "+989121234567",
            "company": "Sara Shop", "website": null, "member_since": "2026-08-01T09:00:00.123456+00:00",
            "client_platform": "android", "source_workspace": "Sara Shop"
          },
          "workspace_count": 3,
          "workspaces": [
            {
              "id": "ws-1", "name": "Sara Shop", "role": "owner", "status": "active", "created_at": null,
              "plan": {
                "name": "Startup", "names": { "fa": "شروع" }, "slug": "pro", "is_free": false,
                "status": "active", "period_end": "2026-10-15T00:00:00.000Z", "trial_end": null,
                "cancel_at_period_end": false
              },
              "operators": { "used": 2, "limit": 3 },
              "contacts": { "used": 1, "limit": 500 },
              "usage": {
                "period": "2026-09",
                "conversations": { "used": 42, "limit": 1000 },
                "visitors": { "used": 900, "limit": -1 },
                "messages": 310,
                "ai_credits": { "used": 0, "limit": null },
                "call_minutes": 0,
                "storage_bytes": 1536,
                "storage_limit_gb": 1
              }
            },
            { "id": "ws-2", "name": "Other", "role": "agent", "plan": null }
          ],
          "captured_at": "2026-09-30T19:00:00.000Z"
        }
        """,
    )

    @Test
    fun `a requester notice reads as its card`() {
        val card = RequesterCard.parse(meta)!!
        assertEquals("Sara Ahmadi", card.name)
        assertEquals("sara@shop.example", card.email)
        assertEquals("+989121234567", card.phone)
        assertEquals(Instant.parse("2026-08-01T09:00:00.123456Z"), card.memberSince)
        assertEquals("android", card.clientPlatform)
        assertEquals(3, card.workspaceCount)
        assertEquals(Instant.parse("2026-09-30T19:00:00Z"), card.capturedAt)

        val shop = card.workspaces[0]
        assertTrue(shop.hasPlan)
        assertEquals("Startup", shop.planName)
        assertEquals("شروع", shop.planNames["fa"])
        assertEquals("active", shop.planStatus)
        assertEquals(Instant.parse("2026-10-15T00:00:00Z"), shop.periodEnd)
        assertEquals(RequesterCard.Metered(2, 3), shop.operators)
        assertEquals(RequesterCard.Metered(42, 1000), shop.conversations)
        assertEquals(RequesterCard.Metered(900, -1), shop.visitors)
        // A limit the plan does not set is no limit to show.
        assertEquals(RequesterCard.Metered(0, null), shop.aiCredits)
        assertEquals(1536L, shop.storageBytes)
        assertEquals(1L, shop.storageLimitGb)

        val other = card.workspaces[1]
        assertFalse(other.hasPlan)
        assertEquals("agent", other.role)
        assertEquals(RequesterCard.Metered(0, null), other.operators)
    }

    @Test
    fun `any other notice is not a card`() {
        assertNull(RequesterCard.parse(json("""{"kind":"support_rating","score":4}""")))
        assertNull(RequesterCard.parse(null))
    }

    @Test
    fun `a card with little in it still reads`() {
        val card = RequesterCard.parse(json("""{"kind":"platform_support_requester","user":{"name":"Ali"}}"""))!!
        assertEquals("Ali", card.name)
        assertTrue(card.workspaces.isEmpty())
        assertEquals(0, card.workspaceCount)
        assertNull(card.capturedAt)
    }
}
