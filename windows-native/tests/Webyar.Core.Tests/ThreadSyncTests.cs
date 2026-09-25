using Webyar.Core.Api;
using Webyar.Core.Local;
using Webyar.Core.Sync;
using Xunit;

namespace Webyar.Core.Tests;

public class ThreadSyncTests
{
    private static async Task<(FakeSyncServer Server, LocalStore Store, ThreadSync Sync, TempDir Dir)> Setup(int messages = 3)
    {
        var server = new FakeSyncServer();
        for (var i = 1; i <= messages; i++) server.Add("c1", $"m{i}", $"message {i}");
        var dir = new TempDir();
        var store = await LocalStore.OpenAsync(dir.Path, "u1");
        return (server, store, new ThreadSync(server.Api(), store), dir);
    }

    [Fact]
    public async Task First_open_fetches_in_full_and_keeps_the_thread_on_the_pc()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        Assert.Null(await sync.LoadLocalAsync("w1", "c1"));
        var snap = await sync.SyncAsync("w1", "c1");
        Assert.Equal(ThreadSource.Full, snap.Source);
        Assert.Equal(["m1", "m2", "m3"], snap.Messages.Select(m => m.Id));

        // A fresh launch: the thread is on screen before any request.
        var relaunched = new ThreadSync(server.Api(), store);
        var requests = server.Requests;
        var local = await relaunched.LoadLocalAsync("w1", "c1");
        Assert.Equal(ThreadSource.Local, local!.Source);
        Assert.Equal(3, local.Messages.Count);
        Assert.Equal(requests, server.Requests);
    }

    [Fact]
    public async Task One_new_message_downloads_only_that_message()
    {
        var (server, store, sync, dir) = await Setup(messages: 200);
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        var before = server.BytesSent;
        server.Add("c1", "m201", "new one");
        var snap = await sync.SyncAsync("w1", "c1");
        Assert.Equal(ThreadSource.Delta, snap.Source);
        Assert.Equal(201, snap.Messages.Count);
        Assert.Equal("m201", snap.Messages[^1].Id);
        var deltaBytes = server.BytesSent - before;
        Assert.True(deltaBytes < 1000, $"a one-message delta cost {deltaBytes} bytes");
        Assert.Equal(1, sync.Stats.DeltaMessages);
    }

    [Fact]
    public async Task Nothing_new_is_an_empty_delta()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        var snap = await sync.SyncAsync("w1", "c1");
        Assert.Equal(ThreadSource.Delta, snap.Source);
        Assert.Equal(0, sync.Stats.DeltaMessages);
    }

    [Fact]
    public void The_same_message_twice_is_still_one_message()
    {
        var local = new[] { new Message("m1", "c1", SenderTypes.Contact, "a", CreatedAt: DateTimeOffset.UnixEpoch) };
        var merged = MessageMerge.Apply(local, [local[0], local[0] with { }]);
        Assert.Single(merged);
    }

    [Fact]
    public async Task Realtime_then_delta_for_the_same_message_shows_it_once()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        server.Add("c1", "m4", "live");
        // The realtime event kicks a sync; the poller's safety sync lands right after.
        var a = sync.SyncAsync("w1", "c1");
        var b = sync.SyncAsync("w1", "c1");
        await Task.WhenAll(a, b);
        Assert.Single((await b).Messages, m => m.Id == "m4");
        Assert.Equal(4, (await sync.LoadLocalAsync("w1", "c1"))!.Messages.Count);
    }

    [Fact]
    public async Task An_edited_message_is_updated_in_place()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        server.Edit("c1", "m2", "[redacted]");
        var snap = await sync.SyncAsync("w1", "c1");
        Assert.Equal(ThreadSource.Delta, snap.Source);
        Assert.Equal("[redacted]", snap.Messages.Single(m => m.Id == "m2").Body);
        Assert.Equal(3, snap.Messages.Count);
    }

    [Fact]
    public async Task A_deleted_message_is_found_by_the_total_and_removed_by_a_full_reconciliation()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        server.Delete("c1", "m2");
        var snap = await sync.SyncAsync("w1", "c1");
        Assert.Equal(ThreadSource.Full, snap.Source);
        Assert.Equal(["m1", "m3"], snap.Messages.Select(m => m.Id));
        Assert.Equal(1, sync.Stats.Mismatches);
        Assert.DoesNotContain((await store.LoadThreadAsync("w1", "c1"))!.Messages, m => m.Id == "m2");
    }

    [Fact]
    public async Task Events_missed_while_disconnected_arrive_with_the_reconnect_sync()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        // The socket is down; three messages come and go unannounced.
        server.Add("c1", "m4");
        server.Add("c1", "m5");
        server.Edit("c1", "m1", "edited while away");
        server.Add("c1", "m6");
        var snap = await sync.SyncAsync("w1", "c1"); // what the reconnect kicks
        Assert.Equal(ThreadSource.Delta, snap.Source);
        Assert.Equal(["m1", "m2", "m3", "m4", "m5", "m6"], snap.Messages.Select(m => m.Id));
        Assert.Equal("edited while away", snap.Messages[0].Body);
    }

    [Fact]
    public async Task A_slow_answer_is_never_applied_after_a_newer_one()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        var release = new TaskCompletionSource();
        var first = true;
        server.BeforeRespond = async _ =>
        {
            if (first)
            {
                first = false;
                await release.Task; // the first request hangs
            }
        };
        var slow = sync.SyncAsync("w1", "c1");
        server.Add("c1", "m4");
        var fast = sync.SyncAsync("w1", "c1"); // queued behind the slow one, never overtakes it
        await Task.Delay(100);
        Assert.False(fast.IsCompleted);
        release.SetResult();
        await Task.WhenAll(slow, fast);
        Assert.Equal(4, (await fast).Messages.Count);
        Assert.Equal(4, (await store.LoadThreadAsync("w1", "c1"))!.Messages.Count);
    }

    [Fact]
    public async Task Switching_conversation_mid_request_keeps_each_answer_in_its_own_thread()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        server.Add("c2", "x1", "other thread");
        var hold = new TaskCompletionSource();
        server.BeforeRespond = async req =>
        {
            if (req.RequestUri!.AbsolutePath.Contains("/c1/")) await hold.Task;
        };
        var c1 = sync.SyncAsync("w1", "c1"); // the operator clicks c1 …
        var c2 = await sync.SyncAsync("w1", "c2"); // … then c2, which answers first
        hold.SetResult();
        var late = await c1;
        Assert.Equal("c1", late.ConversationId); // the caller sees whose answer it is and drops it
        Assert.All(c2.Messages, m => Assert.Equal("c2", m.ConversationId));
        Assert.All((await store.LoadThreadAsync("w1", "c1"))!.Messages, m => Assert.Equal("c1", m.ConversationId));
        Assert.All((await store.LoadThreadAsync("w1", "c2"))!.Messages, m => Assert.Equal("c2", m.ConversationId));
    }

    [Fact]
    public async Task Offline_the_pc_copy_stays_and_the_failure_surfaces()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        server.Offline = true;
        var relaunched = new ThreadSync(server.Api(), store);
        Assert.Equal(3, (await relaunched.LoadLocalAsync("w1", "c1"))!.Messages.Count);
        var e = await Assert.ThrowsAsync<ApiException>(() => relaunched.SyncAsync("w1", "c1"));
        Assert.Equal(ApiFailure.Transport, e.Failure);
        Assert.Equal(3, (await relaunched.LoadLocalAsync("w1", "c1"))!.Messages.Count);
    }

    [Fact]
    public async Task A_thread_the_operator_lost_access_to_is_wiped_from_the_pc()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        server.Forbidden.Add("c1");
        await Assert.ThrowsAsync<ApiException>(() => sync.SyncAsync("w1", "c1"));
        Assert.Null(await store.LoadThreadAsync("w1", "c1"));
        Assert.Null(await sync.LoadLocalAsync("w1", "c1"));
    }

    [Fact]
    public async Task An_older_server_is_revalidated_with_etags_instead_of_downloaded_again()
    {
        var (server, store, sync, dir) = await Setup(messages: 50);
        using var _ = dir;
        await using var __ = store;
        server.SupportsDelta = false;
        Assert.Equal(ThreadSource.Full, (await sync.SyncAsync("w1", "c1")).Source);
        var before = server.BytesSent;
        Assert.Equal(ThreadSource.NotModified, (await sync.SyncAsync("w1", "c1")).Source);
        Assert.Equal(before, server.BytesSent);
        server.Add("c1", "m51");
        Assert.Equal(51, (await sync.SyncAsync("w1", "c1")).Messages.Count);
    }

    [Fact]
    public async Task Optimistic_send_is_replaced_by_its_confirmed_copy_exactly_once()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        await sync.SyncAsync("w1", "c1");
        var outbox = new List<(string ClientId, string Body)> { ("client-1", "hello"), ("client-2", "still sending") };

        // The send succeeded; realtime brings the stored copy.
        server.Add("c1", "srv-1", "hello", SenderTypes.Agent, clientMessageId: "client-1");
        var afterEcho = await sync.SyncAsync("w1", "c1");
        var pending = Outbox.StillPending(outbox, o => o.ClientId, afterEcho.Messages);
        Assert.Equal(["client-2"], pending.Select(p => p.ClientId));
        Assert.Single(afterEcho.Messages, m => m.ClientMessageId == "client-1");

        // The safety poll's delta brings nothing new: still one copy, no bubble.
        var afterPoll = await sync.SyncAsync("w1", "c1");
        Assert.Single(afterPoll.Messages, m => m.ClientMessageId == "client-1");
        Assert.Equal(["client-2"], Outbox.StillPending(pending, o => o.ClientId, afterPoll.Messages).Select(p => p.ClientId));
    }

    [Fact]
    public void Optimistic_bubble_stays_until_its_copy_is_really_there()
    {
        var outbox = new[] { "client-9" };
        var thread = new[] { new Message("m1", "c1", SenderTypes.Contact, "hi") };
        // The send returned, but the answer that raced it predates the insert: keep the bubble.
        Assert.Equal(["client-9"], Outbox.StillPending(outbox, o => o, thread));
    }

    [Fact]
    public async Task A_closed_sync_writes_nothing_more()
    {
        var (server, store, sync, dir) = await Setup();
        using var _ = dir;
        await using var __ = store;
        var hold = new TaskCompletionSource();
        server.BeforeRespond = async _ => await hold.Task;
        var inflight = sync.SyncAsync("w1", "c1");
        sync.Close(); // signed out while the request was out
        hold.SetResult();
        await inflight;
        Assert.Null(await store.LoadThreadAsync("w1", "c1"));
    }

    [Theory]
    [InlineData("image", true)]
    [InlineData("audio", false)]
    [InlineData("video", false)]
    [InlineData("file", false)]
    public void Only_photos_are_fetched_while_a_thread_renders(string kind, bool fetched) =>
        Assert.Equal(fetched, AttachmentPolicy.FetchOnRender(kind));
}
