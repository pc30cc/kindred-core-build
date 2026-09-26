package com.webyar.operator.core.cache

import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Message
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The same cache, held in maps.
 *
 * For the JVM tests — which is most of the sync layer's tests, because they
 * run in milliseconds and on a virtual clock — and for the sample backend,
 * whose data is in memory anyway. It answers every primitive exactly as the
 * Room store does, including the orders; the Room store's own tests pin the
 * SQL to the same answers.
 *
 * One lock for everything, and a transaction is a snapshot put back on
 * failure. Neither would do for a real app with ten thousand messages; both
 * are exactly right for a test.
 */
class MemoryCacheStore : CacheStore {

    private data class ConvKey(val a: String, val w: String, val id: String)
    private data class EntryKey(val a: String, val w: String, val list: String, val id: String)
    private data class MsgKey(val a: String, val localId: String)
    private data class StateKey(val a: String, val w: String, val key: String)

    private val lock = Mutex()
    private val conversations = HashMap<ConvKey, ConversationEntity>()
    private val entries = LinkedHashSet<EntryKey>()
    private val messages = HashMap<MsgKey, MessageEntity>()
    private val states = HashMap<StateKey, SyncStateEntity>()
    private val version = MutableStateFlow(0L)

    private fun changed() {
        version.value = version.value + 1
    }

    private fun <T> observe(read: () -> T): Flow<T> =
        version.map { lock.withLock { read() } }.distinctUntilChanged()

    // MARK: - Conversations

    override fun observeList(scope: CacheScope, listKey: String): Flow<List<Conversation>> = observe {
        entries.asSequence()
            .filter { it.a == scope.accountId && it.w == scope.workspaceId && it.list == listKey }
            .mapNotNull { conversations[ConvKey(it.a, it.w, it.id)] }
            .sortedWith(
                compareByDescending<ConversationEntity> { it.updatedAt ?: Long.MIN_VALUE }
                    .thenBy { it.conversationId },
            )
            .map(CacheMapping::toConversation)
            .toList()
    }

    override fun observeConversation(scope: CacheScope, conversationId: String): Flow<Conversation?> = observe {
        conversations[ConvKey(scope.accountId, scope.workspaceId, conversationId)]?.let(CacheMapping::toConversation)
    }

    override suspend fun conversation(scope: CacheScope, conversationId: String): Conversation? = lock.withLock {
        conversations[ConvKey(scope.accountId, scope.workspaceId, conversationId)]?.let(CacheMapping::toConversation)
    }

    override suspend fun writeConversations(
        scope: CacheScope,
        rows: List<Conversation>,
        listKey: String?,
        replaceList: Boolean,
        absent: Collection<String>,
        now: Long,
    ) {
        lock.withLock {
            val a = scope.accountId
            val w = scope.workspaceId
            for (row in rows) {
                val key = ConvKey(a, w, row.id)
                val old = conversations[key]
                if (ConversationRevision.isStale(row, old)) continue
                conversations[key] = CacheMapping.toEntity(scope, row, now, old?.openedAt)
            }
            if (listKey != null) {
                val incoming = rows.map { it.id }.toSet()
                if (replaceList) {
                    entries.removeAll { it.a == a && it.w == w && it.list == listKey && it.id !in incoming }
                }
                incoming.forEach { entries += EntryKey(a, w, listKey, it) }
                absent.filter { it !in incoming }.forEach { entries -= EntryKey(a, w, listKey, it) }
            }
            changed()
        }
    }

    override suspend fun removeConversation(scope: CacheScope, conversationId: String) {
        lock.withLock {
            val a = scope.accountId
            val w = scope.workspaceId
            entries.removeAll { it.a == a && it.w == w && it.id == conversationId }
            conversations.remove(ConvKey(a, w, conversationId))
            messages.values.removeAll { it.accountId == a && it.workspaceId == w && it.conversationId == conversationId }
            states.remove(StateKey(a, w, SyncKeys.thread(conversationId)))
            changed()
        }
    }

    override suspend fun conversationIdsForContact(scope: CacheScope, contactId: String): List<String> =
        lock.withLock {
            conversations.values
                .filter { it.accountId == scope.accountId && it.workspaceId == scope.workspaceId && it.contactId == contactId }
                .map { it.conversationId }
        }

    override suspend fun markOpened(scope: CacheScope, conversationId: String, now: Long) {
        update(scope, conversationId) { it.copy(openedAt = now) }
    }

    override suspend fun clearUnread(scope: CacheScope, conversationId: String) {
        update(scope, conversationId) { it.copy(unreadCount = 0) }
    }

    private suspend fun update(scope: CacheScope, id: String, change: (ConversationEntity) -> ConversationEntity) {
        lock.withLock {
            val key = ConvKey(scope.accountId, scope.workspaceId, id)
            conversations[key]?.let { conversations[key] = change(it) }
            changed()
        }
    }

    // MARK: - Sync state

    override suspend fun syncState(scope: CacheScope, key: String): SyncStateEntity? =
        lock.withLock { states[StateKey(scope.accountId, scope.workspaceId, key)] }

    override suspend fun putSyncState(scope: CacheScope, state: SyncStateEntity) {
        require(state.accountId == scope.accountId && state.workspaceId == scope.workspaceId)
        lock.withLock {
            states[StateKey(state.accountId, state.workspaceId, state.key)] = state
            changed()
        }
    }

    // MARK: - Messages

    override fun observeThread(scope: CacheScope, conversationId: String): Flow<List<Message>> = observe {
        messages.values.asSequence()
            .filter {
                it.accountId == scope.accountId && it.workspaceId == scope.workspaceId &&
                    it.conversationId == conversationId
            }
            .sortedWith(
                compareBy<MessageEntity> { it.sortAt }
                    // SQLite sorts NULL first in ascending order.
                    .thenBy(nullsFirst<String>()) { it.serverId }
                    .thenBy { it.localId },
            )
            .map(CacheMapping::toMessage)
            .toList()
    }

    override suspend fun <T> thread(
        scope: CacheScope,
        conversationId: String,
        block: suspend ThreadWriter.() -> T,
    ): T = lock.withLock {
        val savedMessages = HashMap(messages)
        val savedStates = HashMap(states)
        try {
            MemoryThreadWriter(scope, conversationId).block().also { changed() }
        } catch (e: Throwable) {
            messages.clear()
            messages.putAll(savedMessages)
            states.clear()
            states.putAll(savedStates)
            throw e
        }
    }

    override suspend fun message(scope: CacheScope, localId: String): MessageEntity? = lock.withLock {
        messages[MsgKey(scope.accountId, localId)]?.takeIf { it.workspaceId == scope.workspaceId }
    }

    override suspend fun outbox(scope: CacheScope): List<MessageEntity> = lock.withLock {
        messages.values
            .filter {
                it.accountId == scope.accountId && it.workspaceId == scope.workspaceId &&
                    it.sendState != SendState.SENT.code
            }
            .sortedBy { it.sortAt }
    }

    private inner class MemoryThreadWriter(
        override val scope: CacheScope,
        override val conversationId: String,
    ) : ThreadWriter {
        private fun inThread(m: MessageEntity) =
            m.accountId == scope.accountId && m.workspaceId == scope.workspaceId && m.conversationId == conversationId

        override suspend fun byServerIds(ids: Collection<String>): List<MessageEntity> {
            val wanted = ids.toSet()
            return messages.values.filter { inThread(it) && it.serverId != null && it.serverId in wanted }
        }

        override suspend fun byClientIds(ids: Collection<String>): List<MessageEntity> {
            val wanted = ids.toSet()
            return messages.values.filter { inThread(it) && it.clientMessageId != null && it.clientMessageId in wanted }
        }

        override suspend fun keys(): List<MessageKeyRow> =
            messages.values.filter(::inThread).map { MessageKeyRow(it.localId, it.serverId, it.sendState, it.cachedAt) }

        override suspend fun upsert(rows: List<MessageEntity>) {
            for (row in rows) {
                require(inThread(row))
                // The unique indexes, as SQLite would enforce them.
                val clash = messages.values.firstOrNull { other ->
                    inThread(other) && other.localId != row.localId && (
                        (row.serverId != null && other.serverId == row.serverId) ||
                            (row.clientMessageId != null && other.clientMessageId == row.clientMessageId)
                        )
                }
                check(clash == null) { "UNIQUE constraint failed: messages" }
                messages[MsgKey(row.accountId, row.localId)] = row
            }
        }

        override suspend fun delete(localIds: Collection<String>) {
            localIds.forEach { messages.remove(MsgKey(scope.accountId, it)) }
        }

        override suspend fun state(): SyncStateEntity? =
            states[StateKey(scope.accountId, scope.workspaceId, SyncKeys.thread(conversationId))]

        override suspend fun putState(state: SyncStateEntity) {
            require(state.key == SyncKeys.thread(conversationId))
            states[StateKey(scope.accountId, scope.workspaceId, state.key)] = state
        }

        override suspend fun clearState() {
            states.remove(StateKey(scope.accountId, scope.workspaceId, SyncKeys.thread(conversationId)))
        }
    }

    // MARK: - Housekeeping

    override suspend fun threadWeights(): List<ThreadWeight> = lock.withLock {
        messages.values
            .filter { it.sendState == SendState.SENT.code }
            .groupBy { Triple(it.accountId, it.workspaceId, it.conversationId) }
            .map { (key, rows) ->
                ThreadWeight(
                    accountId = key.first,
                    workspaceId = key.second,
                    conversationId = key.third,
                    messageCount = rows.size,
                    openedAt = conversations[ConvKey(key.first, key.second, key.third)]?.openedAt,
                )
            }
            .sortedWith(compareBy(nullsFirst<Long>()) { it.openedAt })
    }

    override suspend fun evictThread(accountId: String, workspaceId: String, conversationId: String) {
        lock.withLock {
            messages.values.removeAll {
                it.accountId == accountId && it.workspaceId == workspaceId &&
                    it.conversationId == conversationId && it.sendState == SendState.SENT.code
            }
            states.remove(StateKey(accountId, workspaceId, SyncKeys.thread(conversationId)))
            changed()
        }
    }

    override suspend fun listRefs(): List<ListRef> = lock.withLock {
        states.values.filter { it.key.startsWith("list:") }
            .map { ListRef(it.accountId, it.workspaceId, it.key, it.updatedAt) }
    }

    override suspend fun dropList(accountId: String, workspaceId: String, listKey: String) {
        lock.withLock {
            entries.removeAll { it.a == accountId && it.w == workspaceId && it.list == listKey }
            states.remove(StateKey(accountId, workspaceId, SyncKeys.list(listKey)))
            changed()
        }
    }

    override suspend fun dropOrphanConversations(before: Long): Int = lock.withLock {
        val doomed = conversations.values.filter { c ->
            (c.openedAt == null || c.openedAt < before) && c.cachedAt < before &&
                entries.none { it.a == c.accountId && it.w == c.workspaceId && it.id == c.conversationId } &&
                messages.values.none {
                    it.accountId == c.accountId && it.workspaceId == c.workspaceId && it.conversationId == c.conversationId
                }
        }
        doomed.forEach { conversations.remove(ConvKey(it.accountId, it.workspaceId, it.conversationId)) }
        changed()
        doomed.size
    }

    override suspend fun purgeAccount(accountId: String) {
        lock.withLock {
            messages.values.removeAll { it.accountId == accountId }
            entries.removeAll { it.a == accountId }
            conversations.values.removeAll { it.accountId == accountId }
            states.values.removeAll { it.accountId == accountId }
            changed()
        }
    }

    override suspend fun clear() {
        lock.withLock {
            messages.values.removeAll { it.sendState == SendState.SENT.code }
            entries.clear()
            conversations.values.removeAll { c ->
                messages.values.none {
                    it.accountId == c.accountId && it.workspaceId == c.workspaceId && it.conversationId == c.conversationId
                }
            }
            states.clear()
            changed()
        }
    }

    override suspend fun stats(): CacheStats = lock.withLock {
        CacheStats(conversations = conversations.size, messages = messages.size, bytes = 0L)
    }
}
