package com.webyar.ai.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.get
import com.webyar.ai.core.model.string
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Space
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Who is asking — the card at the top of a platform-support conversation in
 * the support team's inbox (docs/PLATFORM_SUPPORT.md, "Who is asking"). The
 * server writes it as an internal notice when the conversation starts
 * (server/services/platformSupport/requester.ts): the site user, and each of
 * their workspaces with its plan, operators and this month's usage.
 */
data class RequesterCard(
    val name: String?,
    val email: String?,
    val phone: String?,
    val company: String?,
    val memberSince: Instant?,
    val clientPlatform: String?,
    val sourceWorkspace: String?,
    val workspaceCount: Int,
    val workspaces: List<Workspace>,
    val capturedAt: Instant?,
) {
    /** A used amount against the plan's limit: null when it sets none, negative when unlimited. */
    data class Metered(val used: Long, val limit: Long?)

    data class Workspace(
        val name: String,
        val role: String?,
        /** The plan's name in each language Super Admin wrote one, else its name. */
        val planNames: Map<String, String>,
        val planName: String?,
        val planStatus: String?,
        val periodEnd: Instant?,
        val trialEnd: Instant?,
        val cancelAtPeriodEnd: Boolean,
        val operators: Metered,
        val contacts: Metered,
        val conversations: Metered,
        val visitors: Metered,
        val aiCredits: Metered,
        val messages: Long,
        val storageBytes: Long,
        val storageLimitGb: Long?,
    ) {
        val hasPlan: Boolean get() = planName != null
    }

    companion object {
        const val KIND = "platform_support_requester"

        /** The card a notice's metadata describes, or null when it is not one. */
        fun parse(meta: JsonElement?): RequesterCard? {
            if (meta.string("kind") != KIND) return null
            val user = meta["user"]
            val workspaces = (meta["workspaces"] as? JsonArray).orEmpty().map { ws ->
                val plan = ws["plan"]?.takeIf { it is JsonObject }
                val usage = ws["usage"]
                Workspace(
                    name = ws.text("name") ?: "",
                    role = ws.text("role"),
                    planNames = (plan?.get("names") as? JsonObject)
                        ?.mapNotNull { (lang, value) -> (value as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }?.let { lang to it } }
                        ?.toMap()
                        .orEmpty(),
                    planName = plan.text("name"),
                    planStatus = plan.text("status"),
                    periodEnd = instant(plan.text("period_end")),
                    trialEnd = instant(plan.text("trial_end")),
                    cancelAtPeriodEnd = (plan?.get("cancel_at_period_end") as? JsonPrimitive)?.booleanOrNull == true,
                    operators = metered(ws["operators"]),
                    contacts = metered(ws["contacts"]),
                    conversations = metered(usage["conversations"]),
                    visitors = metered(usage["visitors"]),
                    aiCredits = metered(usage["ai_credits"]),
                    messages = long(usage["messages"]) ?: 0,
                    storageBytes = long(usage["storage_bytes"]) ?: 0,
                    storageLimitGb = long(usage["storage_limit_gb"]),
                )
            }
            return RequesterCard(
                name = user.text("name"),
                email = user.text("email"),
                phone = user.text("phone"),
                company = user.text("company"),
                memberSince = instant(user.text("member_since")),
                clientPlatform = user.text("client_platform"),
                sourceWorkspace = user.text("source_workspace"),
                workspaceCount = long(meta["workspace_count"])?.toInt() ?: workspaces.size,
                workspaces = workspaces,
                capturedAt = instant(meta.string("captured_at")),
            )
        }

        private fun JsonElement?.text(key: String): String? = string(key)?.trim()?.takeIf { it.isNotEmpty() }

        private fun long(element: JsonElement?): Long? = (element as? JsonPrimitive)?.doubleOrNull?.toLong()

        private fun metered(element: JsonElement?) = Metered(long(element["used"]) ?: 0, long(element["limit"]))

        /** An ISO timestamp as the server writes it, with `Z` or an offset. */
        private fun instant(value: String?): Instant? = value?.let {
            runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() ?: runCatching { Instant.parse(it) }.getOrNull()
        }
    }
}

/** The app a site user wrote from, by its product name. */
private fun platformName(raw: String?): String? = when (raw?.lowercase()) {
    "android" -> "Android"
    "ios" -> "iOS"
    "macos" -> "macOS"
    "windows" -> "Windows"
    "web" -> "Web"
    else -> null
}

private fun metered(value: RequesterCard.Metered, language: Language): String {
    val used = Format.number(value.used, language)
    val limit = value.limit ?: return used
    return if (limit < 0) "$used / ∞" else "$used / ${Format.number(limit, language)}"
}

@Composable
internal fun RequesterCardView(card: RequesterCard, language: Language, modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(Radius.lg),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = Space.sm)
            .testTag(A11y.SUPPORT_REQUESTER_CARD),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Space.md, vertical = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                Icon(Icons.Outlined.Person, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(StrAndroid.requesterTitle(language), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    StrAndroid.requesterTeamOnly(language),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f).padding(start = Space.xs),
                    maxLines = 1,
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            Column(Modifier.padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                card.name?.let { Text(it, style = MaterialTheme.typography.titleSmall.bidiContent()) }
                val contacts = listOfNotNull(card.email, card.phone)
                if (contacts.isNotEmpty()) {
                    // Addresses and numbers read left to right in every language.
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Text(contacts.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall)
                    }
                }
                card.company?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall.bidiContent(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val facts = listOfNotNull(
                    card.memberSince?.let { StrAndroid.requesterMemberSince(language, Format.fullDate(it, language)) },
                    platformName(card.clientPlatform)?.let { StrAndroid.requesterVia(language, it) },
                    card.sourceWorkspace?.let { StrAndroid.requesterFrom(language, it) },
                )
                if (facts.isNotEmpty()) {
                    Text(
                        facts.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall.bidiContent(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (card.workspaces.isNotEmpty()) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text(
                        StrAndroid.requesterWorkspaces(language, card.workspaceCount),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    card.workspaces.forEach { WorkspaceBlock(it, language) }
                    val more = card.workspaceCount - card.workspaces.size
                    if (more > 0) {
                        Text(
                            StrAndroid.requesterMore(language, more),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            card.capturedAt?.let {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Text(
                    StrAndroid.requesterAsOf(language, Format.fullDate(it, language)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Space.md, vertical = Space.xs),
                )
            }
        }
    }
}

@Composable
private fun WorkspaceBlock(ws: RequesterCard.Workspace, language: Language) {
    Surface(
        shape = RoundedCornerShape(Radius.md),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    ws.name,
                    style = MaterialTheme.typography.labelLarge.bidiContent(),
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                ws.role?.let {
                    Text(
                        StrAndroid.requesterRole(language, it),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            val plan = if (ws.hasPlan) {
                val name = ws.planNames[language.code] ?: ws.planName.orEmpty()
                listOfNotNull(name, ws.planStatus?.let { StrAndroid.requesterPlanStatus(language, it) }).joinToString(" · ")
            } else {
                StrAndroid.requesterNoPlan(language)
            }
            Text(
                plan,
                style = MaterialTheme.typography.bodySmall.bidiContent(),
                color = if (ws.hasPlan) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.Medium,
            )
            val renewal = when {
                ws.planStatus == "trialing" && ws.trialEnd != null ->
                    StrAndroid.requesterTrialEnds(language, Format.fullDate(ws.trialEnd, language))
                ws.periodEnd != null && ws.cancelAtPeriodEnd ->
                    StrAndroid.requesterEnds(language, Format.fullDate(ws.periodEnd, language))
                ws.periodEnd != null -> StrAndroid.requesterRenews(language, Format.fullDate(ws.periodEnd, language))
                else -> null
            }
            renewal?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val storage = Format.fileSize(ws.storageBytes, language) +
                (ws.storageLimitGb?.let { if (it < 0) " / ∞" else " / ${Format.number(it, language)} GB" } ?: "")
            listOf(
                StrAndroid.requesterOperators(language) to metered(ws.operators, language),
                StrAndroid.requesterConversations(language) to metered(ws.conversations, language),
                StrAndroid.requesterVisitors(language) to metered(ws.visitors, language),
                StrAndroid.requesterContacts(language) to metered(ws.contacts, language),
                StrAndroid.requesterAiCredits(language) to metered(ws.aiCredits, language),
                StrAndroid.requesterMessages(language) to Format.number(ws.messages, language),
                StrAndroid.requesterStorage(language) to storage,
            ).forEach { (label, value) ->
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        label,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}
