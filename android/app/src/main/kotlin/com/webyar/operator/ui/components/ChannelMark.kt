package com.webyar.operator.ui.components

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.string
import com.webyar.operator.i18n.Language

/**
 * Where a visitor is writing from — the website's chat, Telegram, WhatsApp…
 *
 * The inbound pipeline stamps the provider on the conversation
 * (`metadata.channel`, `server/services/channels/inboundProcessing.ts`) and
 * on the contact; a thread from the site's own widget carries none. So the
 * answer is the conversation's, then the contact's, then "the website" —
 * the order `resolveChannelKey` in `ChannelBadge.tsx` reads them in.
 */
object ConversationChannel {
    const val WEB = "widget"

    fun of(conversation: Conversation?): String {
        conversation ?: return WEB
        val raw = conversation.metadata.string("channel")
            ?: conversation.metadata.string("source")
            ?: conversation.contact?.metadata.string("channel")
            ?: conversation.contact?.metadata.string("source")
        return normalize(raw)
    }

    /** Lower-cased and trimmed; anything empty, or the widget's own names, is the website. */
    fun normalize(raw: String?): String {
        val key = raw?.trim()?.lowercase().orEmpty()
        return when (key) {
            "", "widget", "web", "website", "chat", "livechat" -> WEB
            "twitter" -> "x"
            else -> key
        }
    }

    /**
     * The channel's name as it writes itself. Product names are not
     * translated; the website is, because "the website" is not a product.
     */
    fun title(key: String, language: Language): String = when (key) {
        WEB -> when (language) {
            Language.EN -> "Website"
            Language.FA -> "وب‌سایت"
            Language.TR -> "Web sitesi"
        }
        "email" -> when (language) {
            Language.EN -> "Email"
            Language.FA -> "ایمیل"
            Language.TR -> "E-posta"
        }
        "phone" -> when (language) {
            Language.EN -> "Phone"
            Language.FA -> "تلفن"
            Language.TR -> "Telefon"
        }
        else -> ChannelInbox(key).title(language)
    }
}

/** A channel's mark and its colour, light and dark. */
private class ChannelLook(val icon: ImageVector, val light: Color, val dark: Color)

private fun lookOf(key: String, primary: Color, neutral: Color): ChannelLook = when (key) {
    ConversationChannel.WEB -> ChannelLook(ChannelGlyph.Globe, primary, primary)
    "telegram" -> ChannelLook(Icons.AutoMirrored.Filled.Send, Color(0xFF1C8AD1), Color(0xFF6CC3F5))
    "bale" -> ChannelLook(Icons.AutoMirrored.Filled.Send, Color(0xFF12806A), Color(0xFF5ED3B6))
    "whatsapp" -> ChannelLook(ChannelGlyph.Bubble, Color(0xFF128C4A), Color(0xFF5FD98E))
    "instagram" -> ChannelLook(ChannelGlyph.Instagram, Color(0xFFC72A6E), Color(0xFFF57EAE))
    "x" -> ChannelLook(ChannelGlyph.X, neutral, neutral)
    "email" -> ChannelLook(Icons.Filled.Email, neutral, neutral)
    "phone" -> ChannelLook(Icons.Filled.Phone, neutral, neutral)
    else -> ChannelLook(ChannelGlyph.Bubble, neutral, neutral)
}

/**
 * The channel as a small tonal label — its mark and its name, in its own
 * colour, the way the console's `ChannelBadge` shows it beside a name.
 *
 * Every thread wears one, the website's included: an operator answering
 * three channels at once should not have to infer "the site" from the
 * absence of a label.
 */
@Composable
fun ChannelLabel(
    key: String,
    language: Language,
    modifier: Modifier = Modifier,
    /** A shorter pill for a dense row; the bar gets the fuller one. */
    compact: Boolean = false,
) {
    val dark = isSystemInDarkTheme()
    val primary = MaterialTheme.colorScheme.primary
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    val look = remember(key, primary, neutral) { lookOf(key, primary, neutral) }
    val tint = if (dark) look.dark else look.light
    val title = ConversationChannel.title(key, language)

    Surface(
        color = tint.copy(alpha = 0.12f),
        contentColor = tint,
        shape = RoundedCornerShape(50),
        modifier = modifier
            .testTag("channel.$key")
            .semantics { contentDescription = title },
    ) {
        Row(
            Modifier.padding(
                horizontal = if (compact) 6.dp else 8.dp,
                vertical = if (compact) 1.dp else 2.dp,
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 4.dp),
        ) {
            Icon(look.icon, contentDescription = null, modifier = Modifier.size(if (compact) 11.dp else 13.dp))
            Text(
                title,
                style = if (compact) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
                maxLines = 1,
            )
        }
    }
}

/** Just the mark, for a place with no room for a word. */
@Composable
fun ChannelIcon(key: String, size: Dp, modifier: Modifier = Modifier) {
    val dark = isSystemInDarkTheme()
    val primary = MaterialTheme.colorScheme.primary
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    val look = remember(key, primary, neutral) { lookOf(key, primary, neutral) }
    Icon(look.icon, contentDescription = null, tint = if (dark) look.dark else look.light, modifier = modifier.size(size))
}

/**
 * The marks `material-icons-core` does not carry, on the 24-unit grid.
 *
 * Even-odd filled, so a ring is a ring whichever way its sub-paths wind.
 */
private object ChannelGlyph {

    /** The website: a globe. */
    val Globe: ImageVector by lazy {
        glyph(
            "Globe",
            "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2c.9 1.2 1.6 2.55 2.05 4h-4.1C10.4 6.55 11.1 5.2 12 4Zm-2.6.43" +
                "A15.6 15.6 0 0 0 7.9 8H5.08A8.04 8.04 0 0 1 9.4 4.43Zm5.2 0A8.04 8.04 0 0 1 18.92 8H16.1a15.6 15.6 0 0 0-1.5-3.57Z" +
                "M4.26 10h3.3a16.4 16.4 0 0 0 0 4h-3.3a8.1 8.1 0 0 1 0-4Zm5.32 0h4.84a14.3 14.3 0 0 1 0 4H9.58a14.3 14.3 0 0 1 0-4Z" +
                "m6.86 0h3.3a8.1 8.1 0 0 1 0 4h-3.3a16.4 16.4 0 0 0 0-4ZM5.08 16H7.9a15.6 15.6 0 0 0 1.5 3.57A8.04 8.04 0 0 1 5.08 16Z" +
                "m4.87 0h4.1c-.45 1.45-1.15 2.8-2.05 4-.9-1.2-1.6-2.55-2.05-4Zm6.15 0h2.82a8.04 8.04 0 0 1-4.32 3.57A15.6 15.6 0 0 0 16.1 16Z",
        )
    }

    /** A chat bubble — WhatsApp and any channel without a mark of its own. */
    val Bubble: ImageVector by lazy {
        glyph(
            "Bubble",
            "M12 2.5c5.25 0 9.5 3.9 9.5 8.75S17.25 20 12 20c-1.2 0-2.35-.2-3.4-.57L3.5 21.5l1.55-4.34" +
                "A8.3 8.3 0 0 1 2.5 11.25C2.5 6.4 6.75 2.5 12 2.5Z",
        )
    }

    /** A camera in a rounded square. */
    val Instagram: ImageVector by lazy {
        glyph(
            "Instagram",
            "M7.5 2h9A5.5 5.5 0 0 1 22 7.5v9a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 16.5v-9A5.5 5.5 0 0 1 7.5 2Z" +
                "m0 2A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5v-9A3.5 3.5 0 0 0 16.5 4h-9Z" +
                "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" +
                "M17.25 5.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z",
        )
    }

    /** The X mark. */
    val X: ImageVector by lazy {
        glyph(
            "X",
            "M18.9 1.15h3.68l-8.04 9.2L24 22.85h-7.4l-5.8-7.59-6.64 7.59H.47l8.6-9.83L0 1.15h7.6l5.24 6.93Z" +
                "M17.61 20.64h2.04L6.49 3.24H4.3Z",
        )
    }

    private fun glyph(name: String, path: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = PathParser().parsePathString(path).toNodes(),
            pathFillType = PathFillType.EvenOdd,
            fill = SolidColor(Color.Black),
        ).build()
}
