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
        val code = serverMessage
        val known = knownCodeText(code, language)
        if (known != null) {
            known
        } else if (language == Language.EN && !code.isNullOrEmpty() && !MACHINE_CODE.matches(code)) {
            code
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
            // Before the 500s, which it is numerically inside: 501 means
            // the deployment does not carry the feature, so "try again
            // shortly" is an instruction that can only ever waste somebody's
            // time. `ApiError.isFeatureMissing` is the same distinction for
            // callers that want to draw their own empty state.
            501 -> StrManual.errorFeatureMissing(language)
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

/**
 * A code rather than a sentence: `invalid_payload`, `email_thread_not_found`,
 * `email_provider_error`, `forbidden`. Several routes answer with one of
 * these instead of words, and "the server's own wording is more specific"
 * stops being true when the wording is an identifier — an English operator
 * was reading `email_provider_error` under the heading. Lower case with no
 * spaces is never a sentence, so it gets the same text as the other
 * languages: by the one code worth naming, or by the status.
 */
private val MACHINE_CODE = Regex("^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$")

/**
 * The codes that say more than their status does, in every language.
 * Anything not here falls back to the status — `email_thread_not_found` is
 * a 404 and reads as one, `email_provider_error` a 500.
 */
private fun knownCodeText(code: String?, language: Language): String? = when (code) {
    "email_missing_recipient" -> StrEmail.needsRecipient(language)
    "email_attachment_upload_failed" -> StrEmail.uploadFailed(language)
    else -> null
}

/** Anything that is not an [ApiError] still has to say something. */
fun Throwable.displayText(language: Language, unauthorized: String? = null): String =
    (this as? ApiError)?.text(language, unauthorized) ?: Str.offlineBody(language)
