using Webyar.Core.Api;
using Webyar.Core.Local;
using Webyar.Core.Sync;
using Xunit;

namespace Webyar.Core.Tests;

public class ListSyncTests
{
    private static Conversation Conv(string id, string ws = "w1", int unread = 0) =>
        new(id, ws, ConversationStatuses.Open, UnreadCount: unread);

    [Fact]
    public async Task The_queue_is_on_the_pc_and_an_unchanged_queue_costs_a_304()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("c1", unread: 2), Conv("c2")];
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var sync = new ConversationListSync(server.Api(), store);

        var first = await sync.FetchAsync("w1", InboxFilter.Open);
        Assert.False(first.NotModified);
        Assert.Equal(2, first.Conversations.Count);

        // Next launch: drawn from the PC, then revalidated.
        var relaunched = new ConversationListSync(server.Api(), store);
        Assert.Equal(["c1", "c2"], (await relaunched.LoadLocalAsync("w1", InboxFilter.Open))!.Select(c => c.Id));
        var bytes = server.BytesSent;
        var again = await relaunched.FetchAsync("w1", InboxFilter.Open);
        Assert.True(again.NotModified);
        Assert.Equal(2, again.Conversations.Count);
        Assert.Equal(bytes, server.BytesSent);

        // Something changed (unread): a fresh answer replaces the copy.
        server.Queues[InboxFilter.Open] = [Conv("c1", unread: 3)];
        var changed = await relaunched.FetchAsync("w1", InboxFilter.Open);
        Assert.False(changed.NotModified);
        Assert.Equal(3, changed.Conversations.Single().UnreadCount);
        Assert.Equal(["c1"], (await store.LoadListAsync("w1", "Open"))!.Conversations.Select(c => c.Id));
    }

    [Fact]
    public async Task Two_watchers_of_the_same_queue_share_one_request()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("c1")];
        var gate = new TaskCompletionSource();
        server.BeforeRespond = async _ => await gate.Task;
        var sync = new ConversationListSync(server.Api(), null);
        var inbox = sync.FetchAsync("w1", InboxFilter.Open);
        var notifier = sync.FetchAsync("w1", InboxFilter.Open);
        gate.SetResult();
        await Task.WhenAll(inbox, notifier);
        Assert.Equal(1, server.Requests);
        Assert.Equal(1, sync.Coalesced);
    }

    [Fact]
    public async Task Offline_launch_still_shows_the_queue()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("c1")];
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        await new ConversationListSync(server.Api(), store).FetchAsync("w1", InboxFilter.Open);
        server.Offline = true;
        var offline = new ConversationListSync(server.Api(), store);
        Assert.Single((await offline.LoadLocalAsync("w1", InboxFilter.Open))!);
        await Assert.ThrowsAsync<ApiException>(() => offline.FetchAsync("w1", InboxFilter.Open));
        // The failed refresh did not wipe what the operator sees.
        Assert.Single((await offline.LoadLocalAsync("w1", InboxFilter.Open))!);
    }

    [Fact]
    public async Task A_late_answer_for_the_old_workspace_never_lands_in_the_new_one()
    {
        var server = new FakeSyncServer { WorkspaceId = "wA" };
        server.Queues[InboxFilter.Open] = [Conv("a1", "wA")];
        var hold = new TaskCompletionSource();
        server.BeforeRespond = async _ => await hold.Task;
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var sync = new ConversationListSync(server.Api(), store);

        var forA = sync.FetchAsync("wA", InboxFilter.Open); // workspace A's request is out …
        // … the operator switches to B, which has its own copy.
        await store.SaveListAsync("wB", "Open", [Conv("b1", "wB")], null);
        hold.SetResult();
        var late = await forA;
        Assert.Equal("wA", late.WorkspaceId); // tagged with its workspace: the page drops it
        Assert.Equal(["b1"], (await sync.LoadLocalAsync("wB", InboxFilter.Open))!.Select(c => c.Id));
        Assert.Equal(["a1"], (await sync.LoadLocalAsync("wA", InboxFilter.Open))!.Select(c => c.Id));
    }

    [Fact]
    public async Task A_row_of_another_workspace_in_an_answer_is_dropped()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("c1"), Conv("stray", "w2")];
        var sync = new ConversationListSync(server.Api(), null);
        Assert.Equal(["c1"], (await sync.FetchAsync("w1", InboxFilter.Open)).Conversations.Select(c => c.Id));
    }

    [Fact]
    public async Task The_shown_copy_is_saved_only_while_it_is_the_latest_answer()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("c1")];
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var sync = new ConversationListSync(server.Api(), store);
        var first = await sync.FetchAsync("w1", InboxFilter.Open);
        server.Queues[InboxFilter.Open] = [Conv("c1"), Conv("c2")];
        await sync.FetchAsync("w1", InboxFilter.Open); // newer answer lands first
        await sync.SaveShownAsync("w1", InboxFilter.Open, [first.Conversations[0] with { VisitorOs = "Windows" }], first.ETag);
        Assert.Equal(2, (await store.LoadListAsync("w1", "Open"))!.Conversations.Count);
    }

    [Fact]
    public async Task Queues_are_kept_apart()
    {
        var server = new FakeSyncServer();
        server.Queues[InboxFilter.Open] = [Conv("open1")];
        server.Queues[InboxFilter.Resolved] = [Conv("done1")];
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var sync = new ConversationListSync(server.Api(), store);
        await sync.FetchAsync("w1", InboxFilter.Open);
        await sync.FetchAsync("w1", InboxFilter.Resolved);
        Assert.Equal(["open1"], (await sync.LoadLocalAsync("w1", InboxFilter.Open))!.Select(c => c.Id));
        Assert.Equal(["done1"], (await sync.LoadLocalAsync("w1", InboxFilter.Resolved))!.Select(c => c.Id));
        Assert.Equal("done1", (await sync.FindLocalAsync("w1", "done1"))!.Id);
    }
}
