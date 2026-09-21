package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A saved reply the operator can drop into the composer.
 *
 * The console calls these canned responses and the mobile web calls them
 * shortcuts; they are the same rows, in `canned_responses`, shared by everyone
 * in the workspace rather than owned per operator. Anyone can use any of them;
 * only the author and the workspace's owners and admins can change one, which
 * is why this app offers no editor — a phone is where you reach for a reply,
 * not where you curate the list.
 */
@Serializable
data class CannedResponse(
    val id: String,
    val shortcut: String,
    val title: String,
    /**
     * Stored raw, with its `{{placeholders}}` unexpanded. [CannedText]
     * resolves them at the moment of insertion, against this conversation.
     */
    val body: String,
    val locale: String,
    @SerialName("usage_count") val usageCount: Int? = null,
)

@Serializable
data class CannedResponsesResponse(val items: List<CannedResponse> = emptyList())

/**
 * Fills in a canned response's placeholders.
 *
 * The six names and the rule for a name that cannot be filled are the web's,
 * from `src/components/canned-responses/interpolation.ts`: an unknown
 * placeholder, or one whose value is empty, is **left exactly as written**.
 *
 * That is deliberate and worth keeping. A greeting that silently becomes
 * "Hello ," is worse than one that visibly still says "Hello
 * {{contact.name}}", because only the second is something the operator will
 * notice before they send it.
 */
object CannedText {

    data class Context(
        val contactName: String? = null,
        val contactEmail: String? = null,
        val workspaceName: String? = null,
        val agentName: String? = null,
        val agentEmail: String? = null,
    ) {
        /** The first word of the agent's name, the same way the web splits it. */
        val agentFirstName: String?
            get() = agentName?.trim()?.split(' ')?.firstOrNull()?.takeIf { it.isNotEmpty() }

        fun value(name: String): String? {
            val resolved = when (name) {
                "contact.name" -> contactName
                "contact.email" -> contactEmail
                "workspace.name" -> workspaceName
                "agent.name" -> agentName
                "agent.first_name" -> agentFirstName
                "agent.email" -> agentEmail
                else -> return null
            }
            return resolved?.takeIf { it.isNotBlank() }
        }
    }

    /**
     * The same pattern the web uses: a dotted lower-case name, with optional
     * spaces inside the braces.
     */
    private val PATTERN = Regex("""\{\{\s*([a-z_]+\.[a-z_]+)\s*}}""")

    fun interpolate(body: String, context: Context): String =
        PATTERN.replace(body) { match ->
            // A name with no value keeps its braces, so the operator sees it.
            context.value(match.groupValues[1]) ?: match.value
        }
}
