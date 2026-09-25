package com.webyar.operator.core.cache

import android.content.Context
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteException
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import com.webyar.operator.core.Diag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The local replica of the inbox and its transcripts.
 *
 * **Versioned, with a cache's migration policy.** Every schema change bumps
 * [VERSION] and exports its JSON (`app/schemas`, via the Room Gradle plugin),
 * and a migration is written when keeping the rows is worth the code — a
 * large outbox, say. Where no migration exists the database is rebuilt from
 * nothing: every row here is a copy of something the server still has, so
 * the cost of a rebuild is one slower first sync, never lost data. The
 * outbox is the single exception to "the server still has it", which is why
 * [MIGRATIONS] must carry a real migration for any change that would drop a
 * pending message.
 *
 * Nothing here is a credential. The session token stays in the Keystore-
 * encrypted DataStore (`SecureStore`), and this database is excluded from
 * backup and device transfer like everything else in the sandbox
 * (`data_extraction_rules.xml`, `allowBackup="false"`).
 *
 * Not encrypted at rest beyond the platform's own file-based encryption, and
 * that is a decision rather than an omission: the app sandbox already keeps
 * the file from every other app, and since Android 10 every device ships
 * file-based encryption keyed to the user's lock screen. SQLCipher would add
 * ~7 MB of native code per ABI and a key whose only possible home is the
 * same Keystore that already protects the device — against an attacker who
 * has root on an unlocked phone, which is the one case it would matter in,
 * and in which the session token is the bigger prize anyway.
 */
@Database(
    entities = [
        ConversationEntity::class,
        InboxEntryEntity::class,
        MessageEntity::class,
        SyncStateEntity::class,
    ],
    version = CacheDatabase.VERSION,
    exportSchema = true,
)
abstract class CacheDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun messages(): MessageDao
    abstract fun syncState(): SyncStateDao
    abstract fun maintenance(): MaintenanceDao

    companion object {
        const val VERSION = 1
        const val NAME = "webyar-cache.db"

        /** Real migrations, oldest first. See the class note for when one is owed. */
        val MIGRATIONS: Array<Migration> = emptyArray()

        /** [name] null builds an in-memory database: tests, and the last resort. */
        fun build(context: Context, name: String?): CacheDatabase {
            val builder = if (name == null) {
                Room.inMemoryDatabaseBuilder(context.applicationContext, CacheDatabase::class.java)
            } else {
                Room.databaseBuilder(context.applicationContext, CacheDatabase::class.java, name)
            }
            return builder
                .addMigrations(*MIGRATIONS)
                // A cache with no migration path is rebuilt, never a crash at
                // launch. Downgrades too: an operator who sideloads an older
                // build gets an empty cache, not an app that will not open.
                // This one call covers both directions. Adding
                // fallbackToDestructiveMigrationOnDowngrade after it would set
                // requireMigration back to true and undo it for upgrades.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
        }
    }
}

/**
 * Owns the one [CacheDatabase], and replaces it when it cannot be used.
 *
 * A damaged cache must never cost the operator the app. Opening is therefore
 * checked — the first real read happens here, off the main thread, where a
 * failure can be answered — and the answers are, in order: rebuild the file
 * from nothing (the server resyncs it), and if even a fresh file cannot be
 * opened (a full disk, a broken filesystem) run this launch on an in-memory
 * database. The app then works exactly as before, it just forgets on exit.
 *
 * [generation] moves on every replacement, so a flow reading the old
 * instance knows to re-subscribe to the new one.
 */
class CacheDatabaseHolder(
    private val context: Context,
    private val name: String? = CacheDatabase.NAME,
    private val log: Diag = Diag.Android,
) {
    private val lock = Mutex()
    @Volatile private var database: CacheDatabase? = null
    private val _generation = MutableStateFlow(0)
    val generation: StateFlow<Int> = _generation.asStateFlow()

    /** The file on disk, or null in memory. */
    val fileName: String? get() = name

    /** True when this launch fell back to memory. Shown nowhere; logged. */
    @Volatile var isVolatile: Boolean = name == null
        private set

    suspend fun get(): CacheDatabase {
        database?.let { return it }
        return lock.withLock {
            database ?: withContext(Dispatchers.IO) { open() }.also { database = it }
        }
    }

    /**
     * Throws the current database away and starts again. For corruption
     * detected mid-session, and for tests. Returns once the new one is open.
     */
    suspend fun reset(reason: String) {
        lock.withLock {
            log.warn(AREA, "cache database reset: $reason")
            withContext(Dispatchers.IO) {
                runCatching { database?.close() }
                database = null
                if (name != null) runCatching { context.deleteDatabase(name) }
                database = open()
            }
        }
        _generation.value = _generation.value + 1
    }

    private fun open(): CacheDatabase {
        if (name == null) return CacheDatabase.build(context, null)
        attempt()?.let { return it }
        // The file would not open or would not verify — a schema that drifted
        // at the same version, a torn write, corruption. It is a cache: delete
        // it, and the next sync rebuilds it.
        log.warn(AREA, "cache database unreadable; rebuilding")
        runCatching { context.deleteDatabase(name) }
        attempt()?.let { return it }
        log.warn(AREA, "cache database cannot be created; running this launch from memory")
        isVolatile = true
        return CacheDatabase.build(context, null)
    }

    private fun attempt(): CacheDatabase? {
        val db = CacheDatabase.build(context, name)
        return try {
            // Forces the open, the migration and Room's identity check now,
            // here, rather than on the first query from some screen.
            db.openHelper.writableDatabase
            db
        } catch (e: SQLiteDatabaseLockedException) {
            // Busy is not damaged: another connection holds it for a moment.
            // Deleting it now would throw away a perfectly good cache.
            log.warn(AREA, "cache database busy at open: ${e.javaClass.simpleName}")
            db
        } catch (e: SQLiteException) {
            log.warn(AREA, "cache database open failed: ${e.javaClass.simpleName}")
            runCatching { db.close() }
            null
        } catch (e: IllegalStateException) {
            // "Room cannot verify the data integrity": same version number,
            // different schema. Only possible from a development build, and a
            // rebuild is exactly right for it.
            log.warn(AREA, "cache database failed verification: ${e.javaClass.simpleName}")
            runCatching { db.close() }
            null
        }
    }
}

/** Whether a failure means the file itself is damaged, as against busy or full. */
internal fun Throwable.isCacheCorruption(): Boolean =
    this is SQLiteDatabaseCorruptException ||
        (this is SQLiteException && message?.contains("malformed", ignoreCase = true) == true)

internal const val AREA = "Cache"
