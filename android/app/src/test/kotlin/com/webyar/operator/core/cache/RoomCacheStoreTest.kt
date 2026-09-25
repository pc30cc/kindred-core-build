package com.webyar.operator.core.cache

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.webyar.operator.core.Diag
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The same contract, on Room: the SQL answers what the in-memory store
 * answers — orders, isolation, transactions and all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomCacheStoreTest : CacheStoreContract() {
    private val context: Context = ApplicationProvider.getApplicationContext()

    override fun store(): CacheStore =
        RoomCacheStore(context, CacheDatabaseHolder(context, name = null, log = Diag.Silent), Diag.Silent)
}

/**
 * A cache that cannot be opened is rebuilt, never a crash at launch — and
 * only the cache: nothing here touches DataStore or the session.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CacheDatabaseRecoveryTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val name = "recovery-test.db"
    private val scope = CacheScope("user-a", "ws-1")

    @After
    fun tearDown() {
        context.deleteDatabase(name)
    }

    private fun holder() = CacheDatabaseHolder(context, name, Diag.Silent)

    private suspend fun write(holder: CacheDatabaseHolder) {
        RoomCacheStore(context, holder, Diag.Silent).writeConversations(
            scope,
            listOf(com.webyar.operator.core.model.Conversation(id = "c-1", workspaceId = "ws-1")),
            now = 1,
        )
    }

    private suspend fun read(holder: CacheDatabaseHolder) =
        RoomCacheStore(context, holder, Diag.Silent).conversation(scope, "c-1")

    @Test
    fun `an ordinary reopen keeps the rows`() = runBlocking {
        val first = holder()
        write(first)
        first.get().close()

        assertEquals("c-1", read(holder())?.id)
    }

    @Test
    fun `a file that is not a database is replaced by an empty one`() = runBlocking {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        path.writeText("this is not SQLite at all, and never was")

        val holder = holder()
        assertNull(read(holder))
        write(holder)
        assertEquals("c-1", read(holder)?.id)
        assertFalse(holder.isVolatile)
    }

    @Test
    fun `a schema that drifted at the same version is rebuilt`() = runBlocking {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL("CREATE TABLE conversations (something_else TEXT)")
            db.execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)")
            db.execSQL("INSERT INTO room_master_table (id, identity_hash) VALUES (42, 'not-this-schema')")
            db.version = CacheDatabase.VERSION
        }

        val holder = holder()
        write(holder)
        assertEquals("c-1", read(holder)?.id)
    }

    @Test
    fun `a database from a newer build is rebuilt, not refused`() = runBlocking {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL("CREATE TABLE future (x TEXT)")
            db.version = CacheDatabase.VERSION + 7
        }

        val holder = holder()
        write(holder)
        assertEquals("c-1", read(holder)?.id)
    }

    @Test
    fun `a reset mid-session hands every reader a fresh database`() = runBlocking {
        val holder = holder()
        val store = RoomCacheStore(context, holder, Diag.Silent)
        write(holder)
        val before = holder.generation.value

        holder.reset("test")

        assertTrue(holder.generation.value > before)
        assertNull(store.conversation(scope, "c-1"))
        assertTrue(store.observeList(scope, "open").first().isEmpty())
    }

    @Test
    fun `every migration there is, is registered`() {
        // Version 1 is the first schema; there is nothing to migrate from
        // yet. When VERSION moves, a migration (or a deliberate rebuild) is
        // owed, and this is where the test for it goes.
        assertEquals(1, CacheDatabase.VERSION)
        assertTrue(CacheDatabase.MIGRATIONS.all { it.endVersion <= CacheDatabase.VERSION })
    }
}
