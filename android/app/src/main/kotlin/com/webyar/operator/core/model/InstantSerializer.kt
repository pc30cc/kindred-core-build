package com.webyar.operator.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder

/**
 * Parses the three shapes this API's timestamps actually arrive in.
 *
 * The port of `DateParsing` in `ios/WebyarNative/.../APIClient.swift`, and it
 * exists for the same reason: Postgres writes however many fractional digits
 * the value needs — real rows in this database carry 3, 5 and 6 — and a
 * formatter pinned to milliseconds drops the whole response when it meets one
 * of the others.
 *
 * `ISO_OFFSET_DATE_TIME` accepts 0–9 fractional digits on its own, so the
 * truncate-and-retry step iOS needs is not needed here. What is still needed
 * is the space-separated form Postgres emits when a row is serialised without
 * going through the API's own JSON encoder.
 */
object DateParsing {
    private val postgres: DateTimeFormatter = DateTimeFormatterBuilder()
        .appendPattern("yyyy-MM-dd HH:mm:ss")
        .appendFraction(java.time.temporal.ChronoField.NANO_OF_SECOND, 0, 9, true)
        .appendOffset("+HH:MM", "Z")
        .toFormatter()

    fun parse(raw: String): Instant? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        // Both ISO forms, with or without a fraction, in one pass.
        runCatching { return OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant() }
        runCatching { return Instant.parse(text) }
        runCatching { return OffsetDateTime.parse(text, postgres).toInstant() }
        return null
    }

    fun format(instant: Instant): String = DateTimeFormatter.ISO_INSTANT.format(instant)
}

/**
 * A timestamp the server may send in any of those shapes, or omit.
 *
 * An unparseable value becomes null rather than throwing. iOS throws here and
 * loses the response; that is the stricter choice and it is the wrong one for
 * a chat timestamp — a row with no date still has a body worth reading.
 */
object InstantSerializer : KSerializer<Instant?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant?) {
        if (value == null) encoder.encodeString("") else encoder.encodeString(DateParsing.format(value))
    }

    override fun deserialize(decoder: Decoder): Instant? = DateParsing.parse(decoder.decodeString())
}
