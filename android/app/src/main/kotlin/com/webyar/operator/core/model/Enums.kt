package com.webyar.operator.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * An enum that degrades instead of failing when the server adds a case.
 *
 * kotlinx.serialization throws on an unknown enum value by default, which
 * would drop a whole conversation list the day someone adds a status. iOS
 * writes a custom `init(from:)` per enum for exactly this; one serializer here
 * covers all of them.
 */
internal abstract class FallbackEnumSerializer<T : Enum<T>>(
    name: String,
    private val values: Array<T>,
    private val wire: (T) -> String,
    private val fallback: T,
) : KSerializer<T> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor(name, PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: T) = encoder.encodeString(wire(value))

    override fun deserialize(decoder: Decoder): T {
        val raw = decoder.decodeString()
        return values.firstOrNull { wire(it) == raw } ?: fallback
    }
}
