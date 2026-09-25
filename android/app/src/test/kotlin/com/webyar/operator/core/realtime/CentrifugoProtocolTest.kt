package com.webyar.operator.core.realtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The frames, pinned: what this app says to Centrifugo and what it understands back. */
class CentrifugoProtocolTest {

    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test
    fun `connect carries the token and names the client`() {
        val frame = obj(CentrifugoProtocol.connect(1, "tok", "webyar-android", "1.0"))
        assertEquals("1", frame["id"].toString())
        val connect = frame["connect"]!!.jsonObject
        assertEquals("tok", connect["token"]!!.jsonPrimitive.content)
        assertEquals("webyar-android", connect["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `subscribe asks for recovery only when it has a position`() {
        val plain = obj(CentrifugoProtocol.subscribe(2, "ws:w:inbox", "t", null))["subscribe"]!!.jsonObject
        assertFalse(plain.containsKey("recover"))

        val resume = obj(
            CentrifugoProtocol.subscribe(2, "ws:w:inbox", "t", CentrifugoProtocol.StreamPosition(41, "e")),
        )["subscribe"]!!.jsonObject
        assertEquals("true", resume["recover"].toString())
        assertEquals("41", resume["offset"].toString())
        assertEquals("e", resume["epoch"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an empty object is a ping, and several frames can share a message`() {
        val frames = CentrifugoProtocol.parse("{}\n{\"id\":1,\"connect\":{}}\n")
        assertEquals(Inbound.Ping, frames[0])
        assertEquals(1, (frames[1] as Inbound.Reply).id)
    }

    @Test
    fun `a subscribe reply says what it recovered`() {
        val reply = CentrifugoProtocol.parse(
            """{"id":2,"subscribe":{"recoverable":true,"epoch":"e1","offset":7,"recovered":true,"publications":[{"data":{"type":"event"},"offset":6}]}}""",
        ).single() as Inbound.Reply
        val result = reply.result!!
        assertTrue(result.recovered)
        assertEquals(7L, result.offset)
        assertEquals("e1", result.epoch)
        assertEquals(6L, result.publications.single().offset)
    }

    @Test
    fun `publications, disconnects and errors are told apart`() {
        val pub = CentrifugoProtocol.parse("""{"push":{"channel":"ws:w:inbox","pub":{"data":{"type":"message"},"offset":3}}}""").single()
        assertEquals("ws:w:inbox", (pub as Inbound.Publication).channel)
        assertEquals(3L, pub.offset)

        val bye = CentrifugoProtocol.parse("""{"push":{"disconnect":{"code":3500,"reason":"invalid token"}}}""").single()
        assertEquals(3500, (bye as Inbound.Disconnect).code)
        assertTrue(CentrifugoProtocol.isTerminal(3500))
        assertFalse(CentrifugoProtocol.isTerminal(3000))

        val error = CentrifugoProtocol.parse("""{"id":2,"error":{"code":103,"message":"permission denied"}}""").single()
        assertEquals(103, (error as Inbound.Reply).error?.code)
    }

    @Test
    fun `garbage is ignored, not thrown`() {
        assertEquals(listOf(Inbound.Unknown), CentrifugoProtocol.parse("not json"))
        assertEquals(listOf(Inbound.Unknown), CentrifugoProtocol.parse("""{"push":{"join":{}}}"""))
    }
}
