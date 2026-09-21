package com.webyar.operator.core.net

/**
 * Every way a request can fail, in the terms the UI needs to react.
 *
 * The distinction that matters most is [Unauthorized] versus [Transport]: the
 * first means the session is genuinely gone and the operator must sign in
 * again; the second means we simply could not ask. Treating a dropped
 * connection as a logout would throw away a perfectly good session every time
 * someone walks into a lift.
 */
sealed class ApiError(message: String? = null, cause: Throwable? = null) : Exception(message, cause) {
    /** The server rejected our credentials, or the session was revoked. */
    data object Unauthorized : ApiError("unauthorized") {
        private fun readResolve(): Any = Unauthorized
    }

    /** We never got an answer — offline, DNS, timeout, TLS. */
    data class Transport(val reason: Throwable? = null) : ApiError("transport", reason)

    /** The server answered with a failure and, where it gave one, a message. */
    data class Server(val status: Int, val serverMessage: String?) : ApiError("server $status")

    /** The answer did not match what this version of the app understands. */
    data class Decoding(val reason: Throwable? = null) : ApiError("decoding", reason)

    val isAuthFailure: Boolean get() = this is Unauthorized

    /**
     * The server understood the request perfectly and has nothing to answer it
     * with, because this deployment does not carry the feature.
     *
     * 501 rather than 500, and worth telling apart, because the two need
     * opposite things from whoever sees them: a failure invites "try again",
     * and a retry here can never succeed. The one case in practice is a
     * database built from the self-host migration chain before
     * `198_canned_responses_selfhost.sql` added the saved-replies table.
     */
    val isFeatureMissing: Boolean get() = this is Server && status == 501
}
