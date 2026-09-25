package com.webyar.operator.core.cache

/**
 * Whose data, and which workspace of theirs.
 *
 * Every row in the cache carries both, and every read names both — there is
 * no query in this package that can return a row without being told whose it
 * is. That is the whole of the isolation guarantee, so it is structural
 * rather than a convention: a conversation id is globally unique today, but
 * a security property should not rest on another system's id scheme.
 *
 * [accountId] is the signed-in user's id, never an email (which can change
 * hands) and never the session token (which is a credential and is never
 * written outside the Keystore-encrypted store).
 */
data class CacheScope(val accountId: String, val workspaceId: String) {
    init {
        require(accountId.isNotBlank()) { "a cache scope needs an account" }
        require(workspaceId.isNotBlank()) { "a cache scope needs a workspace" }
    }

    /** For logs: enough to tell two scopes apart, nothing that names anyone. */
    val tag: String get() = "${accountId.take(6)}…/${workspaceId.take(6)}…"
}
