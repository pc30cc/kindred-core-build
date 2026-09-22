package com.webyar.operator.core.model

import com.webyar.operator.i18n.Language
import kotlinx.serialization.Serializable

/**
 * A messaging channel the workspace has actually installed — Telegram, Bale,
 * WhatsApp and the rest.
 *
 * These are inboxes in the operator's sense but not queues in the server's:
 * the conversations endpoint has no `channel` parameter, and the console
 * narrows its own list the same way. So a channel is a filter laid over
 * whichever queue is open, exactly as `?channel=` is on the web.
 */
data class ChannelInbox(
    /**
     * The plugin slug, which is also what a conversation carries in
     * `metadata.channel`.
     */
    val key: String,
) {
    val id: String get() = key

    /**
     * Written the way the channel writes itself.
     *
     * A product name is not translated — except Bale, which is Persian to
     * begin with, and SMS, which is a common noun rather than a brand.
     */
    fun title(language: Language): String = when (key) {
        "telegram" -> "Telegram"
        "bale" -> if (language == Language.FA) "بله" else "Bale"
        "whatsapp" -> "WhatsApp"
        "instagram" -> "Instagram"
        "x", "twitter" -> "X"
        "messenger", "facebook" -> "Messenger"
        "sms" -> if (language == Language.FA) "پیامک" else "SMS"
        else -> key.replaceFirstChar { it.uppercase() }
    }
}

/**
 * One row of `GET /api/plugins/catalog`.
 *
 * Only the fields that decide whether a channel belongs in the switcher are
 * decoded; the catalog carries a great deal more that only the marketplace
 * needs.
 */
/**
 * NOTE THE ABSENCE of `@SerialName` on every field here.
 *
 * `/api/plugins/catalog` answers in camelCase — `supportsInbox`,
 * `planAllowed`, `installationStatus` — while most of this API is snake_case.
 * These were annotated as `supports_inbox` and `plan_allowed` to match the
 * rest, so both decoded to null on every item, `isUsableInbox` was false for
 * every channel, and the switcher was empty on a workspace with Telegram
 * installed and allowed. Nothing failed; the list was simply always empty.
 */
@Serializable
data class PluginCatalogItem(
    val slug: String? = null,
    val installed: Boolean? = null,
    val supportsInbox: Boolean? = null,
    val planAllowed: Boolean? = null,
    val installationStatus: String? = null,
) {
    /**
     * Installed, inbox-capable, and still inside the plan.
     *
     * `planAllowed` matters as much as `installed`: a workspace that
     * downgrades keeps its installation row, and an inbox it can no longer use
     * should not be offered.
     */
    val isUsableInbox: Boolean
        get() = installed == true && supportsInbox == true && planAllowed != false
}

@Serializable
data class PluginCatalogResponse(val items: List<PluginCatalogItem>? = null)

/**
 * Which channel a thread came in on.
 *
 * `metadata.channel`, then `metadata.source`, then the widget — the same order
 * and the same default as `resolveChannelKey` in the console, so a
 * conversation is never filed under a different channel on the two surfaces.
 */
val Conversation.channelKey: String
    get() = metadata.string("channel")?.takeIf { it.isNotEmpty() }
        ?: metadata.string("source")?.takeIf { it.isNotEmpty() }
        ?: "widget"
