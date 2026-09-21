package com.webyar.operator.core.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToLong

/**
 * Reading a handful of keys out of a free-form object without modelling it.
 *
 * `metadata` carries server bookkeeping that changes independently of the app,
 * so decoding it into a concrete class would break the whole response the
 * first time a field was added. iOS models this with its own `JSONValue` enum;
 * kotlinx.serialization already ships the same thing as `JsonElement`, so
 * these are just the accessors that enum carried.
 */

/** The value as a string, or null if it is anything else. */
val JsonElement.stringOrNull: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * A whole number, whether the server sent it as one or as a string.
 * Postgres `jsonb` round-trips both, depending on who wrote the row.
 */
val JsonElement.intOrNull: Int?
    get() {
        val primitive = this as? JsonPrimitive ?: return null
        if (primitive.isString) return primitive.content.toIntOrNull()
        // `.toInt()` on a Double is a silent truncation on overflow and throws
        // on NaN, and this value came off the wire.
        val rounded = primitive.doubleOrNull?.takeIf { it.isFinite() }?.roundToLong() ?: return null
        return if (rounded in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) rounded.toInt() else null
    }

val JsonElement.boolOrNull: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** Key lookup that answers null for anything that is not an object. */
operator fun JsonElement?.get(key: String): JsonElement? =
    (this as? JsonObject)?.get(key)

/** Convenience for the common `meta["kind"]?.stringOrNull` shape. */
fun JsonElement?.string(key: String): String? = this[key]?.stringOrNull

internal fun JsonElement.asObjectOrNull(): JsonObject? = this as? JsonObject

@Suppress("unused")
internal fun JsonElement.primitiveContentOrNull(): String? = runCatching { jsonPrimitive.content }.getOrNull()

@Suppress("unused")
internal fun JsonElement.objectOrEmpty(): JsonObject = runCatching { jsonObject }.getOrDefault(JsonObject(emptyMap()))
