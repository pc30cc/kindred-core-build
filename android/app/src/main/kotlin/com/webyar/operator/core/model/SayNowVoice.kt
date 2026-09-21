package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Whose voice the AI writes in when it delivers an operator's message.
 *
 * The distinction is the visitor's, not the operator's: the same sentence
 * reads differently coming from a person on the team than from the assistant,
 * and on a thread the AI is already answering, the operator is choosing which
 * of those the visitor should believe they are talking to.
 */
@Serializable
enum class SayNowVoice {
    /** Written as one of the humans on the team. */
    @SerialName("specialist") SPECIALIST,

    /** Written as the assistant, openly. */
    @SerialName("assistant") ASSISTANT;

    val wireValue: String
        get() = when (this) {
            SPECIALIST -> "specialist"
            ASSISTANT -> "assistant"
        }
}
