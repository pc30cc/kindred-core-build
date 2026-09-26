package com.webyar.operator.core.cache

import com.webyar.operator.core.Diag

/**
 * How long the cache keeps what it keeps.
 *
 * The rules, in order of how much they give back:
 *
 *  1. A queue not read in [staleListMs] — a workspace the operator has not
 *     opened in a month — loses its membership. Its rows go with rule 4.
 *  2. A transcript not opened in [staleThreadMs] is dropped whole, with its
 *     cursor, so the next open is a full read. Whole, never trimmed from the
 *     top: a transcript with a hole in it is worse than one that loads.
 *  3. Past [maxMessages] in total, transcripts go least-recently-opened
 *     first until the count is under [targetMessages] — so an operator who
 *     reads a hundred threads a day keeps the ones they came back to.
 *  4. A conversation in no queue, with no transcript, not opened lately, is
 *     dropped.
 *
 * The outbox is never touched: a message the operator wrote and the server
 * has not confirmed is not cache.
 */
data class RetentionPolicy(
    val staleListMs: Long = 30L * DAY,
    val staleThreadMs: Long = 30L * DAY,
    val maxMessages: Int = 40_000,
    val targetMessages: Int = 30_000,
    val orphanMs: Long = 14L * DAY,
) {
    private companion object {
        const val DAY = 24 * 60 * 60 * 1000L
    }
}

data class RetentionReport(val listsDropped: Int, val threadsEvicted: Int, val messagesEvicted: Int, val conversationsDropped: Int)

class CacheRetention(
    private val store: CacheStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val diag: Diag = Diag.Android,
    private val policy: RetentionPolicy = RetentionPolicy(),
) {
    suspend fun run(): RetentionReport {
        val now = clock()

        val staleLists = store.listRefs().filter { now - it.updatedAt > policy.staleListMs }
        staleLists.forEach { ref ->
            SyncKeys.listKeyOf(ref.key)?.let { store.dropList(ref.accountId, ref.workspaceId, it) }
        }

        var threads = 0
        var messages = 0
        val weights = store.threadWeights()
        val kept = ArrayList<ThreadWeight>()
        for (w in weights) {
            val opened = w.openedAt
            if (opened == null || now - opened > policy.staleThreadMs) {
                store.evictThread(w.accountId, w.workspaceId, w.conversationId)
                threads++
                messages += w.messageCount
            } else {
                kept += w
            }
        }

        var total = kept.sumOf { it.messageCount }
        if (total > policy.maxMessages) {
            // `threadWeights` is least-recently-opened first.
            for (w in kept) {
                if (total <= policy.targetMessages) break
                store.evictThread(w.accountId, w.workspaceId, w.conversationId)
                total -= w.messageCount
                threads++
                messages += w.messageCount
            }
        }

        val conversations = store.dropOrphanConversations(now - policy.orphanMs)
        val report = RetentionReport(staleLists.size, threads, messages, conversations)
        diag.info(
            "Cache",
            "retention: ${report.listsDropped} lists, ${report.threadsEvicted} threads " +
                "(${report.messagesEvicted} messages), ${report.conversationsDropped} conversations",
        )
        return report
    }
}
