using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Webyar.Core.Api;

namespace Webyar.Core.Local;

/// <summary>How much of the server the PC keeps. The server stays the source of truth; this only bounds a copy.</summary>
public sealed record RetentionPolicy(
    /// <summary>A thread nobody opened or synced for this long is dropped.</summary>
    TimeSpan ThreadMaxAge,
    /// <summary>At most this many threads per workspace, least recently opened first out.</summary>
    int MaxThreadsPerWorkspace,
    /// <summary>A thread longer than this is not stored at all (it is fetched as before).</summary>
    int MaxMessagesPerThread,
    /// <summary>Past this the oldest threads go until the file is back under three quarters of it.</summary>
    long MaxBytes)
{
    /// <summary>
    /// An operator handles tens of threads a day of a few dozen messages
    /// (~1 KB each as stored): 300 recent threads is a few MB. The caps are
    /// there for the unusual desk, not the normal one.
    /// </summary>
    public static readonly RetentionPolicy Default = new(TimeSpan.FromDays(30), 300, 5000, 256L * 1024 * 1024);
}

/// <summary>A thread as the PC last saw it, and when it was last read in full (the authoritative check for deletes).</summary>
public sealed record CachedThread(IReadOnlyList<Message> Messages, string? Cursor, int? Total, string? ETag, DateTimeOffset? ReconciledAt = null);

/// <summary>A queue as the PC last saw it, and the tag of the answer it came from.</summary>
public sealed record CachedList(IReadOnlyList<Conversation> Conversations, string? ETag, DateTimeOffset SavedAt);

/// <summary>
/// The PC's copy of one operator's conversations and messages, in its own
/// SQLite file (one file per account, named by a hash of the user id), so
/// the inbox and threads show at once on launch and stay readable offline.
///
/// It is a cache and nothing more: no token, no password, no setting lives
/// here, and every failure — a corrupt file, a full disk, a newer schema
/// than this build knows — ends with an empty store that the next sync
/// refills from the server, never with a crash. All work runs off the UI
/// thread, one statement batch at a time.
/// </summary>
public sealed class LocalStore : IAsyncDisposable
{
    public const int SchemaVersion = 1;
    private const string FilePrefix = "account-";
    private const string FileSuffix = ".db";

    /// <summary>Schema steps: element i takes a store from version i to i + 1.</summary>
    internal static readonly IReadOnlyList<string> Migrations =
    [
        """
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
            workspace_id TEXT NOT NULL,
            id TEXT NOT NULL,
            json TEXT NOT NULL,
            saved_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, id));
        CREATE TABLE IF NOT EXISTS lists (
            workspace_id TEXT NOT NULL,
            list_key TEXT NOT NULL,
            ids TEXT NOT NULL,
            etag TEXT,
            saved_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, list_key));
        CREATE TABLE IF NOT EXISTS threads (
            workspace_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            cursor TEXT,
            total INTEGER,
            etag TEXT,
            synced_at INTEGER NOT NULL,
            reconciled_at INTEGER,
            accessed_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, conversation_id));
        CREATE TABLE IF NOT EXISTS messages (
            workspace_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            id TEXT NOT NULL,
            client_message_id TEXT,
            sender_type TEXT NOT NULL,
            sender_id TEXT,
            is_system INTEGER NOT NULL,
            created_at INTEGER,
            updated_at INTEGER,
            json TEXT NOT NULL,
            PRIMARY KEY (workspace_id, conversation_id, id));
        CREATE INDEX IF NOT EXISTS messages_by_time ON messages (workspace_id, conversation_id, created_at, id);
        """,
    ];

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly IReadOnlyList<string> _migrations;
    private readonly Action<string>? _log;
    private SqliteConnection? _db;
    private bool _closed;

    private LocalStore(string path, string owner, IReadOnlyList<string> migrations, Action<string>? log)
    {
        FilePath = path;
        Owner = owner;
        _migrations = migrations;
        _log = log;
    }

    /// <summary>The user id this file belongs to; nothing else is ever read from it.</summary>
    public string Owner { get; }
    public string FilePath { get; }

    /// <summary>How many times this session the file had to be thrown away and rebuilt.</summary>
    public int Resets { get; private set; }

    /// <summary>Where one account's file lives. The name is a hash, so the folder does not list who used the PC.</summary>
    public static string PathFor(string directory, string userId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes("webyar-local-v1:" + userId.Trim().ToLowerInvariant()));
        return Path.Combine(directory, FilePrefix + Convert.ToHexString(hash, 0, 16).ToLowerInvariant() + FileSuffix);
    }

    public static Task<LocalStore> OpenAsync(string directory, string userId, Action<string>? log = null, CancellationToken ct = default) =>
        OpenAsync(directory, userId, Migrations, log, ct);

    internal static async Task<LocalStore> OpenAsync(string directory, string userId, IReadOnlyList<string> migrations, Action<string>? log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userId)) throw new ArgumentException("A store belongs to one user.", nameof(userId));
        var store = new LocalStore(PathFor(directory, userId), userId, migrations, log);
        await Task.Run(() =>
        {
            Directory.CreateDirectory(directory);
            store.OpenOrRebuild();
        }, ct).ConfigureAwait(false);
        return store;
    }

    // ── Opening, versioning and recovery ──

    private void OpenOrRebuild()
    {
        try
        {
            Open();
            return;
        }
        catch (Exception e) when (e is SqliteException or InvalidDataException or IOException or JsonException)
        {
            _log?.Invoke($"[store] unusable ({Describe(e)}): rebuilding");
        }
        Quarantine();
        try
        {
            Open();
        }
        catch (Exception e) when (e is SqliteException or InvalidDataException or IOException)
        {
            // Even a fresh file failed (disk full, no permission): run without a store.
            _log?.Invoke($"[store] disabled: {Describe(e)}");
            _db?.Dispose();
            _db = null;
            _closed = true;
        }
    }

    private void Open()
    {
        _db?.Dispose();
        var db = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = FilePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            // One connection per store, closed for real: a clear or a sign-out can delete the file.
            Pooling = false,
        }.ToString());
        db.Open();
        _db = db;
        Exec("PRAGMA busy_timeout = 5000;");
        var fresh = Scalar<long>("PRAGMA page_count;") == 0;
        if (fresh) Exec("PRAGMA auto_vacuum = INCREMENTAL;");
        Exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        if (!fresh && Scalar<string>("PRAGMA quick_check;") != "ok") throw new InvalidDataException("quick_check failed");

        var version = (int)Scalar<long>("PRAGMA user_version;");
        if (version > _migrations.Count) throw new InvalidDataException($"schema {version} is newer than {_migrations.Count}");
        for (var v = version; v < _migrations.Count; v++)
        {
            using var tx = db.BeginTransaction();
            Exec(_migrations[v], tx);
            Exec($"PRAGMA user_version = {v + 1};", tx);
            tx.Commit();
            if (v > 0) _log?.Invoke($"[store] migrated schema {v} → {v + 1}");
        }

        var owner = GetMeta("owner");
        if (owner is null) SetMeta("owner", Owner);
        else if (owner != Owner) throw new InvalidDataException("store belongs to another account");
    }

    /// <summary>Moves a broken file aside (one copy kept, for support) and starts over.</summary>
    private void Quarantine()
    {
        _db?.Dispose();
        _db = null;
        Resets++;
        try
        {
            if (File.Exists(FilePath)) File.Move(FilePath, FilePath + ".corrupt", overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            TryDelete(FilePath);
        }
        TryDelete(FilePath + "-wal");
        TryDelete(FilePath + "-shm");
    }

    private static string Describe(Exception e) => e is SqliteException s ? $"sqlite {s.SqliteErrorCode}" : e.GetType().Name;

    private static bool IsCorruption(SqliteException e) => e.SqliteErrorCode is 11 /* CORRUPT */ or 26 /* NOTADB */;

    /// <summary>
    /// Runs one unit of work on a worker thread, alone. Corruption found on
    /// the way rebuilds the file; any other failure is logged and returns
    /// <paramref name="fallback"/>. Nothing but cancellation escapes.
    /// </summary>
    private async Task<T> RunAsync<T>(string what, Func<SqliteConnection, T> work, T fallback, CancellationToken ct = default)
    {
        if (_closed) return fallback;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_closed || _db is null) return fallback;
            return await Task.Run(() =>
            {
                try
                {
                    return work(_db);
                }
                catch (SqliteException e) when (IsCorruption(e))
                {
                    _log?.Invoke($"[store] corruption during {what}: rebuilding");
                    Quarantine();
                    OpenOrRebuild();
                    return fallback;
                }
                catch (Exception e) when (e is SqliteException or IOException or JsonException or InvalidOperationException)
                {
                    _log?.Invoke($"[store] {what} failed: {Describe(e)}");
                    return fallback;
                }
            }, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private Task RunAsync(string what, Action<SqliteConnection> work, CancellationToken ct = default) =>
        RunAsync(what, db =>
        {
            work(db);
            return true;
        }, false, ct);

    // ── Session: who was signed in and their workspaces, for an offline launch ──

    public Task SaveSessionAsync(User user, IReadOnlyList<Workspace> workspaces, CancellationToken ct = default) =>
        RunAsync("save session", _ =>
        {
            if (user.Id != Owner) return;
            SetMeta("user", JsonSerializer.Serialize(user, Json.Options));
            if (workspaces.Count > 0) SetMeta("workspaces", JsonSerializer.Serialize(workspaces, Json.Options));
        }, ct);

    public Task<(User? User, IReadOnlyList<Workspace> Workspaces)> LoadSessionAsync(CancellationToken ct = default) =>
        RunAsync<(User?, IReadOnlyList<Workspace>)>("load session", _ =>
        {
            var user = GetMeta("user") is { } u ? JsonSerializer.Deserialize<User>(u, Json.Options) : null;
            if (user?.Id != Owner) user = null;
            var workspaces = GetMeta("workspaces") is { } w ? JsonSerializer.Deserialize<List<Workspace>>(w, Json.Options) ?? [] : [];
            return (user, workspaces);
        }, (null, []), ct);

    // ── Conversation lists ──

    public Task<CachedList?> LoadListAsync(string workspaceId, string listKey, CancellationToken ct = default) =>
        RunAsync<CachedList?>("load list", db =>
        {
            string idsJson;
            string? etag;
            long savedAt;
            using (var cmd = Command("SELECT ids, etag, saved_at FROM lists WHERE workspace_id = $ws AND list_key = $key;", ("$ws", workspaceId), ("$key", listKey)))
            using (var r = cmd.ExecuteReader())
            {
                if (!r.Read()) return null;
                idsJson = r.GetString(0);
                etag = r.IsDBNull(1) ? null : r.GetString(1);
                savedAt = r.GetInt64(2);
            }
            var ids = JsonSerializer.Deserialize<List<string>>(idsJson) ?? [];
            var byId = new Dictionary<string, Conversation>();
            using (var cmd = Command("SELECT id, json FROM conversations WHERE workspace_id = $ws AND id IN (SELECT value FROM json_each($ids));", ("$ws", workspaceId), ("$ids", idsJson)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                {
                    if (JsonSerializer.Deserialize<Conversation>(r.GetString(1), Json.Options) is { } c && c.WorkspaceId == workspaceId) byId[r.GetString(0)] = c;
                }
            }
            // A row missing means the snapshot is not whole: its tag cannot be trusted.
            var list = ids.Where(byId.ContainsKey).Select(id => byId[id]).ToList();
            return new CachedList(list, list.Count == ids.Count ? etag : null, DateTimeOffset.FromUnixTimeMilliseconds(savedAt));
        }, null, ct);

    /// <summary>
    /// Replaces a queue with the server's answer, and its tag with it, in one
    /// transaction: the stored tag always describes exactly the stored rows.
    /// </summary>
    public Task SaveListAsync(string workspaceId, string listKey, IReadOnlyList<Conversation> list, string? etag, CancellationToken ct = default) =>
        RunAsync("save list", db =>
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using var tx = db.BeginTransaction();
            foreach (var c in list)
            {
                if (c.WorkspaceId != workspaceId) continue;
                UpsertConversation(c, now, tx);
            }
            var ids = JsonSerializer.Serialize(list.Where(c => c.WorkspaceId == workspaceId).Select(c => c.Id).ToList());
            using (var cmd = Command("""
                INSERT INTO lists (workspace_id, list_key, ids, etag, saved_at) VALUES ($ws, $key, $ids, $etag, $now)
                ON CONFLICT (workspace_id, list_key) DO UPDATE SET ids = excluded.ids, etag = excluded.etag, saved_at = excluded.saved_at;
                """, tx, ("$ws", workspaceId), ("$key", listKey), ("$ids", ids), ("$etag", etag), ("$now", now)))
            {
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }, ct);

    /// <summary>One conversation's header, e.g. for a thread opened from a toast outside the list on show.</summary>
    public Task<Conversation?> LoadConversationAsync(string workspaceId, string conversationId, CancellationToken ct = default) =>
        RunAsync<Conversation?>("load conversation", _ =>
        {
            using var cmd = Command("SELECT json FROM conversations WHERE workspace_id = $ws AND id = $id;", ("$ws", workspaceId), ("$id", conversationId));
            return cmd.ExecuteScalar() is string json && JsonSerializer.Deserialize<Conversation>(json, Json.Options) is { } c && c.WorkspaceId == workspaceId ? c : null;
        }, null, ct);

    public Task SaveConversationAsync(Conversation c, CancellationToken ct = default) =>
        RunAsync("save conversation", _ => UpsertConversation(c, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null), ct);

    private void UpsertConversation(Conversation c, long now, SqliteTransaction? tx)
    {
        using var cmd = Command("""
            INSERT INTO conversations (workspace_id, id, json, saved_at) VALUES ($ws, $id, $json, $now)
            ON CONFLICT (workspace_id, id) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at;
            """, tx, ("$ws", c.WorkspaceId), ("$id", c.Id), ("$json", JsonSerializer.Serialize(c, Json.Options)), ("$now", now));
        cmd.ExecuteNonQuery();
    }

    // ── Threads ──

    public Task<CachedThread?> LoadThreadAsync(string workspaceId, string conversationId, CancellationToken ct = default) =>
        RunAsync<CachedThread?>("load thread", _ =>
        {
            string? cursor;
            int? total;
            string? etag;
            DateTimeOffset? reconciled;
            using (var cmd = Command("SELECT cursor, total, etag, reconciled_at FROM threads WHERE workspace_id = $ws AND conversation_id = $c;", ("$ws", workspaceId), ("$c", conversationId)))
            using (var r = cmd.ExecuteReader())
            {
                if (!r.Read()) return null;
                cursor = r.IsDBNull(0) ? null : r.GetString(0);
                total = r.IsDBNull(1) ? null : r.GetInt32(1);
                etag = r.IsDBNull(2) ? null : r.GetString(2);
                reconciled = r.IsDBNull(3) ? null : DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(3));
            }
            var messages = new List<Message>();
            using (var cmd = Command("SELECT json FROM messages WHERE workspace_id = $ws AND conversation_id = $c ORDER BY created_at, id;", ("$ws", workspaceId), ("$c", conversationId)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                {
                    if (JsonSerializer.Deserialize<Message>(r.GetString(0), Json.Options) is { } m && m.ConversationId == conversationId) messages.Add(m);
                }
            }
            using (var touch = Command("UPDATE threads SET accessed_at = $now WHERE workspace_id = $ws AND conversation_id = $c;",
                ("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()), ("$ws", workspaceId), ("$c", conversationId)))
            {
                touch.ExecuteNonQuery();
            }
            return new CachedThread(messages, cursor, total, etag, reconciled);
        }, null, ct);

    /// <summary>
    /// Writes a sync result. <paramref name="replace"/>: the messages are the
    /// whole thread (anything else stored for it goes) and it counts as a
    /// reconciliation. Otherwise they are upserted by id, and a row never goes
    /// back to an older version of itself (updated_at decides).
    /// </summary>
    public Task SaveThreadAsync(string workspaceId, string conversationId, bool replace, IReadOnlyList<Message> messages, string? cursor, int? total, string? etag, CancellationToken ct = default) =>
        RunAsync("save thread", db =>
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using var tx = db.BeginTransaction();
            if (replace)
            {
                using var del = Command("DELETE FROM messages WHERE workspace_id = $ws AND conversation_id = $c;", tx, ("$ws", workspaceId), ("$c", conversationId));
                del.ExecuteNonQuery();
            }
            foreach (var m in messages)
            {
                if (m.ConversationId != conversationId) continue;
                using var cmd = Command("""
                    INSERT INTO messages (workspace_id, conversation_id, id, client_message_id, sender_type, sender_id, is_system, created_at, updated_at, json)
                    VALUES ($ws, $c, $id, $client, $type, $sender, $system, $created, $updated, $json)
                    ON CONFLICT (workspace_id, conversation_id, id) DO UPDATE SET
                        client_message_id = excluded.client_message_id, sender_type = excluded.sender_type, sender_id = excluded.sender_id,
                        is_system = excluded.is_system, created_at = excluded.created_at, updated_at = excluded.updated_at, json = excluded.json
                    WHERE excluded.updated_at IS NULL OR messages.updated_at IS NULL OR excluded.updated_at >= messages.updated_at;
                    """, tx,
                    ("$ws", workspaceId), ("$c", conversationId), ("$id", m.Id), ("$client", m.ClientMessageId), ("$type", m.SenderType),
                    ("$sender", m.SenderId), ("$system", m.IsSystem ? 1 : 0), ("$created", m.CreatedAt?.UtcTicks), ("$updated", m.UpdatedAt?.UtcTicks),
                    ("$json", JsonSerializer.Serialize(m, Json.Options)));
                cmd.ExecuteNonQuery();
            }
            using (var state = Command("""
                INSERT INTO threads (workspace_id, conversation_id, cursor, total, etag, synced_at, reconciled_at, accessed_at) VALUES ($ws, $c, $cursor, $total, $etag, $now, $reconciled, $now)
                ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET cursor = excluded.cursor, total = excluded.total, etag = excluded.etag, synced_at = excluded.synced_at,
                    reconciled_at = COALESCE(excluded.reconciled_at, threads.reconciled_at);
                """, tx, ("$ws", workspaceId), ("$c", conversationId), ("$cursor", cursor), ("$total", total), ("$etag", etag), ("$now", now), ("$reconciled", replace ? now : null)))
            {
                state.ExecuteNonQuery();
            }
            tx.Commit();
        }, ct);

    /// <summary>The thread is gone or no longer this operator's: forget every copy of it.</summary>
    public Task DeleteThreadAsync(string workspaceId, string conversationId, CancellationToken ct = default) =>
        RunAsync("delete thread", db =>
        {
            using var tx = db.BeginTransaction();
            foreach (var sql in new[]
            {
                "DELETE FROM messages WHERE workspace_id = $ws AND conversation_id = $c;",
                "DELETE FROM threads WHERE workspace_id = $ws AND conversation_id = $c;",
                "DELETE FROM conversations WHERE workspace_id = $ws AND id = $c;",
            })
            {
                using var cmd = Command(sql, tx, ("$ws", workspaceId), ("$c", conversationId));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }, ct);

    /// <summary>The operator is no longer a member of this workspace: none of it stays on the PC.</summary>
    public Task DeleteWorkspaceAsync(string workspaceId, CancellationToken ct = default) =>
        RunAsync("delete workspace", db =>
        {
            using var tx = db.BeginTransaction();
            foreach (var table in new[] { "messages", "threads", "lists", "conversations" })
            {
                using var cmd = Command($"DELETE FROM {table} WHERE workspace_id = $ws;", tx, ("$ws", workspaceId));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }, ct);

    // ── Housekeeping ──

    /// <summary>Bytes on disk (the database and its write-ahead log).</summary>
    public long SizeOnDisk()
    {
        long total = 0;
        foreach (var f in new[] { FilePath, FilePath + "-wal" })
        {
            try
            {
                if (File.Exists(f)) total += new FileInfo(f).Length;
            }
            catch (IOException)
            {
            }
        }
        return total;
    }

    /// <summary>Drops old and excess threads, lists and orphaned conversations; see <see cref="RetentionPolicy"/>.</summary>
    public Task<int> EnforceRetentionAsync(RetentionPolicy policy, DateTimeOffset now, CancellationToken ct = default) =>
        RunAsync("retention", db =>
        {
            var cutoff = (now - policy.ThreadMaxAge).ToUnixTimeMilliseconds();
            var dropped = new List<(string Ws, string Id)>();
            using (var cmd = Command("SELECT workspace_id, conversation_id FROM threads WHERE accessed_at < $cut AND synced_at < $cut;", ("$cut", cutoff)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) dropped.Add((r.GetString(0), r.GetString(1)));
            }
            using (var cmd = Command("""
                SELECT workspace_id, conversation_id FROM (
                    SELECT workspace_id, conversation_id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY accessed_at DESC) AS rank FROM threads)
                WHERE rank > $max;
                """, ("$max", policy.MaxThreadsPerWorkspace)))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) dropped.Add((r.GetString(0), r.GetString(1)));
            }
            var removed = DropThreads(db, dropped.Distinct().ToList());

            using (var tx = db.BeginTransaction())
            {
                using (var lists = Command("DELETE FROM lists WHERE saved_at < $cut;", tx, ("$cut", cutoff))) lists.ExecuteNonQuery();
                using (var orphans = Command("""
                    DELETE FROM conversations
                    WHERE saved_at < $cut
                      AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.workspace_id = conversations.workspace_id AND t.conversation_id = conversations.id)
                      AND NOT EXISTS (SELECT 1 FROM lists l, json_each(l.ids) j WHERE l.workspace_id = conversations.workspace_id AND j.value = conversations.id);
                    """, tx, ("$cut", cutoff))) orphans.ExecuteNonQuery();
                tx.Commit();
            }

            // Size last: the oldest threads go until the file is back under 3/4 of the cap.
            if (SizeOnDisk() > policy.MaxBytes)
            {
                var oldest = new List<(string, string)>();
                using (var cmd = Command("SELECT workspace_id, conversation_id FROM threads ORDER BY accessed_at;"))
                using (var r = cmd.ExecuteReader())
                {
                    while (r.Read()) oldest.Add((r.GetString(0), r.GetString(1)));
                }
                var batch = Math.Max(1, oldest.Count / 4);
                for (var i = 0; i < oldest.Count && SizeOnDisk() > policy.MaxBytes * 3 / 4; i += batch)
                {
                    removed += DropThreads(db, oldest.Skip(i).Take(batch).ToList());
                    Exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;");
                }
            }
            if (removed > 0)
            {
                Exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;");
                _log?.Invoke($"[store] retention dropped {removed} threads");
            }
            return removed;
        }, 0, ct);

    private int DropThreads(SqliteConnection db, IReadOnlyList<(string Ws, string Id)> threads)
    {
        if (threads.Count == 0) return 0;
        using var tx = db.BeginTransaction();
        foreach (var (ws, id) in threads)
        {
            foreach (var sql in new[]
            {
                "DELETE FROM messages WHERE workspace_id = $ws AND conversation_id = $c;",
                "DELETE FROM threads WHERE workspace_id = $ws AND conversation_id = $c;",
            })
            {
                using var cmd = Command(sql, tx, ("$ws", ws), ("$c", id));
                cmd.ExecuteNonQuery();
            }
        }
        tx.Commit();
        return threads.Count;
    }

    /// <summary>Empties the store (Clear cache). The file stays open and usable; the server refills it.</summary>
    public Task ClearAsync(CancellationToken ct = default) =>
        RunAsync("clear", db =>
        {
            using (var tx = db.BeginTransaction())
            {
                foreach (var table in new[] { "messages", "threads", "lists", "conversations" })
                {
                    using var cmd = Command($"DELETE FROM {table};", tx);
                    cmd.ExecuteNonQuery();
                }
                using (var meta = Command("DELETE FROM meta WHERE key <> 'owner';", tx)) meta.ExecuteNonQuery();
                tx.Commit();
            }
            Exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
            _log?.Invoke("[store] cleared");
        }, ct);

    /// <summary>
    /// Closes the file. Anything still running against this store afterwards
    /// — a late answer from before a sign-out or a switch — is dropped, so it
    /// can never land in the next account's data.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_closed && _db is null) return;
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            _closed = true;
            _db?.Dispose();
            _db = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Deletes one account's files (explicit sign-out). The store must be disposed first.</summary>
    public static void DeleteFiles(string directory, string userId)
    {
        var path = PathFor(directory, userId);
        foreach (var f in new[] { path, path + "-wal", path + "-shm", path + ".corrupt" }) TryDelete(f);
    }

    /// <summary>Deletes every account's files except <paramref name="keepPath"/> (Clear cache).</summary>
    public static void DeleteAllFiles(string directory, string? keepPath = null)
    {
        try
        {
            if (!Directory.Exists(directory)) return;
            foreach (var f in Directory.EnumerateFiles(directory, FilePrefix + "*"))
            {
                if (keepPath is not null && f.StartsWith(keepPath, StringComparison.OrdinalIgnoreCase) && !f.EndsWith(".corrupt", StringComparison.Ordinal)) continue;
                TryDelete(f);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Bytes used by every account's file in <paramref name="directory"/>.</summary>
    public static long MeasureFiles(string directory)
    {
        try
        {
            return Directory.Exists(directory)
                ? new DirectoryInfo(directory).EnumerateFiles(FilePrefix + "*").Sum(f => f.Length)
                : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    // ── Plumbing ──

    private string? GetMeta(string key)
    {
        using var cmd = Command("SELECT value FROM meta WHERE key = $k;", ("$k", key));
        return cmd.ExecuteScalar() as string;
    }

    private void SetMeta(string key, string value)
    {
        using var cmd = Command("INSERT INTO meta (key, value) VALUES ($k, $v) ON CONFLICT (key) DO UPDATE SET value = excluded.value;", ("$k", key), ("$v", value));
        cmd.ExecuteNonQuery();
    }

    private SqliteCommand Command(string sql, params (string Name, object? Value)[] args) => Command(sql, null, args);

    private SqliteCommand Command(string sql, SqliteTransaction? tx, params (string Name, object? Value)[] args)
    {
        var cmd = _db!.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    private void Exec(string sql, SqliteTransaction? tx = null)
    {
        using var cmd = Command(sql, tx);
        cmd.ExecuteNonQuery();
    }

    private T Scalar<T>(string sql)
    {
        using var cmd = Command(sql);
        var value = cmd.ExecuteScalar();
        return value is null or DBNull ? default! : (T)Convert.ChangeType(value, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
