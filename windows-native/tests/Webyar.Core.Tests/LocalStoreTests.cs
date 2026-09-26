using Microsoft.Data.Sqlite;
using Webyar.Core.Api;
using Webyar.Core.Local;
using Xunit;

namespace Webyar.Core.Tests;

internal sealed class TempDir : IDisposable
{
    public TempDir() => Directory.CreateDirectory(Path);
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "webyar-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(Path, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public class LocalStoreTests
{
    private static Conversation Conv(string id, string ws = "w1", int unread = 0) =>
        new(id, ws, ConversationStatuses.Open, UnreadCount: unread, Contacts: new ConversationContact(Name: "Visitor " + id));

    private static Message Msg(string conv, string id, int minute, string body = "hi", DateTimeOffset? updated = null)
    {
        var at = new DateTimeOffset(2026, 9, 1, 10, minute, 0, TimeSpan.Zero);
        return new Message(id, conv, SenderTypes.Contact, body, CreatedAt: at, UpdatedAt: updated ?? at);
    }

    [Fact]
    public async Task Startup_with_an_empty_cache_has_nothing_and_does_not_fail()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        Assert.Null(await store.LoadListAsync("w1", "Open"));
        Assert.Null(await store.LoadThreadAsync("w1", "c1"));
        var (user, workspaces) = await store.LoadSessionAsync();
        Assert.Null(user);
        Assert.Empty(workspaces);
    }

    [Fact]
    public async Task Startup_with_a_populated_cache_brings_back_session_queue_and_thread()
    {
        using var dir = new TempDir();
        await using (var store = await LocalStore.OpenAsync(dir.Path, "u1"))
        {
            await store.SaveSessionAsync(new User("u1", "a@b.c", "Ali"), [new Workspace("w1", "Shop")]);
            await store.SaveListAsync("w1", "Open", [Conv("c2", unread: 3), Conv("c1")], "W/\"v1\"");
            await store.SaveThreadAsync("w1", "c1", replace: true, [Msg("c1", "m2", 2), Msg("c1", "m1", 1)], "v1.5", 2, null);
        }
        await using var reopened = await LocalStore.OpenAsync(dir.Path, "u1");
        var (user, workspaces) = await reopened.LoadSessionAsync();
        Assert.Equal("Ali", user!.FullName);
        Assert.Equal("Shop", workspaces.Single().Name);
        var list = await reopened.LoadListAsync("w1", "Open");
        Assert.Equal(["c2", "c1"], list!.Conversations.Select(c => c.Id)); // the server's order
        Assert.Equal(3, list.Conversations[0].UnreadCount);
        Assert.Equal("W/\"v1\"", list.ETag);
        var thread = await reopened.LoadThreadAsync("w1", "c1");
        Assert.Equal(["m1", "m2"], thread!.Messages.Select(m => m.Id));
        Assert.Equal("v1.5", thread.Cursor);
        Assert.Equal(2, thread.Total);
        Assert.Equal("c1", (await reopened.LoadConversationAsync("w1", "c1"))!.Id);
    }

    [Fact]
    public async Task Each_account_has_its_own_file_and_never_reads_another()
    {
        using var dir = new TempDir();
        await using (var a = await LocalStore.OpenAsync(dir.Path, "user-a"))
        {
            await a.SaveListAsync("w1", "Open", [Conv("secret")], null);
            await a.SaveSessionAsync(new User("user-a"), []);
        }
        await using var b = await LocalStore.OpenAsync(dir.Path, "user-b");
        Assert.NotEqual(LocalStore.PathFor(dir.Path, "user-a"), b.FilePath);
        Assert.Null(await b.LoadListAsync("w1", "Open"));
        Assert.Null((await b.LoadSessionAsync()).User);
        // The file names do not say who used the PC.
        Assert.DoesNotContain("user-a", string.Join(",", Directory.GetFiles(dir.Path)));
    }

    [Fact]
    public async Task A_file_that_claims_another_owner_is_rebuilt_empty()
    {
        using var dir = new TempDir();
        await using (var a = await LocalStore.OpenAsync(dir.Path, "user-a"))
        {
            await a.SaveListAsync("w1", "Open", [Conv("secret")], null);
        }
        // Someone copies A's file over B's name.
        File.Copy(LocalStore.PathFor(dir.Path, "user-a"), LocalStore.PathFor(dir.Path, "user-b"));
        await using var b = await LocalStore.OpenAsync(dir.Path, "user-b");
        Assert.Equal(1, b.Resets);
        Assert.Null(await b.LoadListAsync("w1", "Open"));
    }

    [Fact]
    public async Task Workspaces_never_see_each_others_rows()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        await store.SaveListAsync("wA", "Open", [Conv("a1", "wA")], null);
        await store.SaveThreadAsync("wA", "a1", true, [Msg("a1", "m1", 1)], null, 1, null);
        // A row of workspace A handed in with B's list is not stored under B.
        await store.SaveListAsync("wB", "Open", [Conv("b1", "wB"), Conv("a1", "wA")], null);
        Assert.Equal(["b1"], (await store.LoadListAsync("wB", "Open"))!.Conversations.Select(c => c.Id));
        Assert.Null(await store.LoadThreadAsync("wB", "a1"));
        Assert.Null(await store.LoadConversationAsync("wB", "a1"));
    }

    [Fact]
    public async Task A_corrupt_file_is_quarantined_and_rebuilt_instead_of_failing_the_launch()
    {
        using var dir = new TempDir();
        var path = LocalStore.PathFor(dir.Path, "u1");
        await File.WriteAllTextAsync(path, "this is not a database, it is a torn write");
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        Assert.Equal(1, store.Resets);
        Assert.True(File.Exists(path + ".corrupt"));
        await store.SaveListAsync("w1", "Open", [Conv("c1")], null);
        Assert.Single((await store.LoadListAsync("w1", "Open"))!.Conversations);
    }

    [Fact]
    public async Task A_newer_schema_than_this_build_knows_is_rebuilt()
    {
        using var dir = new TempDir();
        await using (var store = await LocalStore.OpenAsync(dir.Path, "u1"))
        {
            await store.SaveListAsync("w1", "Open", [Conv("c1")], null);
        }
        using (var raw = new SqliteConnection($"Data Source={LocalStore.PathFor(dir.Path, "u1")};Pooling=False"))
        {
            raw.Open();
            using var cmd = raw.CreateCommand();
            cmd.CommandText = "PRAGMA user_version = 99;";
            cmd.ExecuteNonQuery();
        }
        await using var reopened = await LocalStore.OpenAsync(dir.Path, "u1");
        Assert.Equal(1, reopened.Resets);
        Assert.Null(await reopened.LoadListAsync("w1", "Open"));
    }

    [Fact]
    public async Task Schema_migrations_run_in_order_and_keep_the_data()
    {
        using var dir = new TempDir();
        await using (var v1 = await LocalStore.OpenAsync(dir.Path, "u1", LocalStore.Migrations, null, default))
        {
            await v1.SaveListAsync("w1", "Open", [Conv("c1")], "W/\"t\"");
        }
        var v2 = LocalStore.Migrations.Append("ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;").ToList();
        await using (var store = await LocalStore.OpenAsync(dir.Path, "u1", v2, null, default))
        {
            Assert.Equal(0, store.Resets);
            Assert.Equal("W/\"t\"", (await store.LoadListAsync("w1", "Open"))!.ETag);
        }
        using var raw = new SqliteConnection($"Data Source={LocalStore.PathFor(dir.Path, "u1")};Pooling=False");
        raw.Open();
        using var cmd = raw.CreateCommand();
        cmd.CommandText = "PRAGMA user_version;";
        Assert.Equal(2L, (long)cmd.ExecuteScalar()!);
    }

    [Fact]
    public async Task A_migration_that_fails_starts_the_cache_over()
    {
        using var dir = new TempDir();
        await using (var v1 = await LocalStore.OpenAsync(dir.Path, "u1"))
        {
            await v1.SaveListAsync("w1", "Open", [Conv("c1")], null);
        }
        var broken = LocalStore.Migrations.Append("THIS IS NOT SQL;").ToList();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1", broken, null, default);
        // The rebuild runs the same (broken) steps; the store gives up quietly rather than crash.
        Assert.Equal(1, store.Resets);
        Assert.Null(await store.LoadListAsync("w1", "Open"));
    }

    [Fact]
    public async Task Upserts_never_replace_a_newer_version_with_an_older_one()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var t0 = new DateTimeOffset(2026, 9, 1, 10, 0, 0, TimeSpan.Zero);
        await store.SaveThreadAsync("w1", "c1", true, [Msg("c1", "m1", 1, "delivered", t0.AddMinutes(5))], null, 1, null);
        await store.SaveThreadAsync("w1", "c1", false, [Msg("c1", "m1", 1, "sending", t0.AddMinutes(1))], null, 1, null);
        Assert.Equal("delivered", (await store.LoadThreadAsync("w1", "c1"))!.Messages.Single().Body);
    }

    [Fact]
    public async Task Clear_empties_everything_but_leaves_the_store_usable()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        await store.SaveSessionAsync(new User("u1"), [new Workspace("w1", "Shop")]);
        await store.SaveListAsync("w1", "Open", [Conv("c1")], null);
        await store.SaveThreadAsync("w1", "c1", true, [Msg("c1", "m1", 1)], null, 1, null);
        await store.ClearAsync();
        Assert.Null(await store.LoadListAsync("w1", "Open"));
        Assert.Null(await store.LoadThreadAsync("w1", "c1"));
        Assert.Null((await store.LoadSessionAsync()).User);
        await store.SaveListAsync("w1", "Open", [Conv("c2")], null);
        Assert.Single((await store.LoadListAsync("w1", "Open"))!.Conversations);
    }

    [Fact]
    public async Task Retention_drops_old_and_excess_threads()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        for (var i = 0; i < 5; i++)
        {
            await store.SaveThreadAsync("w1", $"c{i}", true, [Msg($"c{i}", "m", 1)], null, 1, null);
            await Task.Delay(5);
            await store.LoadThreadAsync("w1", $"c{i}"); // opened, in this order
        }
        var removed = await store.EnforceRetentionAsync(RetentionPolicy.Default with { MaxThreadsPerWorkspace = 3 }, DateTimeOffset.UtcNow);
        Assert.Equal(2, removed);
        Assert.Null(await store.LoadThreadAsync("w1", "c0"));
        Assert.NotNull(await store.LoadThreadAsync("w1", "c4"));

        var later = DateTimeOffset.UtcNow.AddDays(31);
        Assert.Equal(3, await store.EnforceRetentionAsync(RetentionPolicy.Default, later));
    }

    [Fact]
    public async Task After_dispose_a_late_write_is_dropped_and_the_file_can_be_deleted()
    {
        using var dir = new TempDir();
        var store = await LocalStore.OpenAsync(dir.Path, "u1");
        await store.DisposeAsync();
        await store.SaveListAsync("w1", "Open", [Conv("late")], null); // an answer from before sign-out
        LocalStore.DeleteFiles(dir.Path, "u1");
        Assert.False(File.Exists(store.FilePath));
    }

    [Fact]
    public async Task Clear_cache_removes_other_accounts_files_and_keeps_the_open_one()
    {
        using var dir = new TempDir();
        await using (var other = await LocalStore.OpenAsync(dir.Path, "someone-else")) { }
        await using var mine = await LocalStore.OpenAsync(dir.Path, "me");
        LocalStore.DeleteAllFiles(dir.Path, keepPath: mine.FilePath);
        Assert.False(File.Exists(LocalStore.PathFor(dir.Path, "someone-else")));
        Assert.True(File.Exists(mine.FilePath));
        Assert.True(LocalStore.MeasureFiles(dir.Path) > 0);
    }
}
