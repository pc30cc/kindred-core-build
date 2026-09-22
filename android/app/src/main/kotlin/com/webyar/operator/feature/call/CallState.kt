package com.webyar.operator.feature.call

import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str

/**
 * Where a call is in its life.
 *
 * One value rather than a set of booleans, for the same reason the load states
 * are: it makes "connecting and also ended" unrepresentable, and every one of
 * those combinations is a bug somebody would otherwise have to find.
 */
sealed interface CallPhase {
    /** The invitation is out; the visitor has not answered. */
    data object Waiting : CallPhase
    /** They answered; we are joining the room. */
    data object Connecting : CallPhase
    /** Both sides are in. */
    data object Connected : CallPhase
    /** Over, for the stated reason. */
    data class Ended(val outcome: CallOutcome) : CallPhase

    val isLive: Boolean get() = this !is Ended
}

/**
 * How a call finished.
 *
 * Each of these reads differently to an operator, and telling them apart is
 * most of what makes the screen feel honest: "they said no" and "nobody picked
 * up" are not the same evening.
 */
sealed interface CallOutcome {
    /** The operator hung up. */
    data object HungUp : CallOutcome
    /** The visitor hung up, or closed the page. */
    data object VisitorLeft : CallOutcome
    /** The visitor said no. */
    data object Declined : CallOutcome
    /** Nobody answered in time. */
    data object Expired : CallOutcome
    /** We never got into the room. */
    data class Failed(val reason: String) : CallOutcome

    fun title(language: Language): String = when (this) {
        // "You hung up" and "they hung up" both read as "call ended" to the
        // operator; the difference matters to the server, not to the screen.
        HungUp, VisitorLeft -> Str.callEnded(language)
        Declined -> Str.callDeclined(language)
        Expired -> Str.callNoAnswer(language)
        is Failed -> Str.callFailed(language)
    }
}

/**
 * A call that connected, but not with everything it was supposed to carry.
 *
 * Worth its own type rather than a boolean: an operator who cannot be heard
 * and an operator who cannot be seen have different problems, and telling them
 * "something went wrong" helps with neither.
 */
enum class CallDegradation {
    /** The microphone would not start — permission, or another app holding it. */
    NO_MICROPHONE,
    /** The camera would not start. The call carries on as audio. */
    NO_CAMERA;

    fun title(language: Language): String = when (this) {
        NO_MICROPHONE -> Str.callNoMicrophone(language)
        NO_CAMERA -> Str.callNoCamera(language)
    }
}
