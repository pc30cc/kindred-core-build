package com.webyar.operator.i18n

import com.webyar.operator.core.net.ApiError

/**
 * What to put in front of the operator when a request fails.
 *
 * The API answers in English to every client. `server/routes/auth.ts` returns
 * `Invalid email or password` whoever is asking, and the server deliberately
 * never consults `Accept-Language` — that is a documented decision there, not
 * an oversight. So the raw message on [ApiError.Server] is an English
 * sentence, and putting it on screen is exactly how a Persian operator ends up
 * reading English under a Persian heading.
 *
 * The app therefore says it in the operator's language, chosen by status code,
 * and shows the server's own wording only when the interface is already
 * English — where it is strictly more specific than anything here. Nothing is
 * lost: the server's sentence is still in the response for anyone reading a
 * log.
 *
 * [unauthorized] means different things in different places — on the login
 * screen it is a wrong password, everywhere else it is a session that has gone
 * — so the caller names it.
 */
fun ApiError.text(language: Language, unauthorized: String? = null): String = when (this) {
    is ApiError.Transport -> Str.offlineBody(language)
    is ApiError.Unauthorized -> unauthorized ?: Str.sessionExpired(language)
    is ApiError.Decoding -> Str.errorUnreadableAnswer(language)
    is ApiError.Server -> {
        if (language == Language.EN && !serverMessage.isNullOrEmpty()) {
            serverMessage
        } else when (status) {
            // 403 is not 401. `ApiClient.orThrow` is careful about that —
            // signing an operator out of the whole app because one endpoint
            // refused them is a fault it records in as many words — and this
            // is the other half of the same care: the session is fine, this
            // one thing is not allowed, and that is what to say.
            403 -> Str.errorNotAllowed(language)
            404 -> Str.errorNotFound(language)
            409 -> Str.errorConflict(language)
            429 -> Str.errorTooManyRequests(language)
            in 500..599 -> Str.errorServerProblem(language)
            // 400 and 422, and the long tail of 4xx nobody has met yet.
            // NOT the offline text, which is what stood here: the server
            // ANSWERED, so the connection is the one thing that demonstrably
            // works, and sending somebody to check it over a 403 is how ten
            // minutes go into toggling aeroplane mode.
            else -> Str.errorInvalidInput(language)
        }
    }
}

/** Anything that is not an [ApiError] still has to say something. */
fun Throwable.displayText(language: Language, unauthorized: String? = null): String =
    (this as? ApiError)?.text(language, unauthorized) ?: Str.offlineBody(language)
