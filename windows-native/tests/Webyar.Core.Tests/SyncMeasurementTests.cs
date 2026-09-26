using System.Diagnostics;
using System.Net;
using Webyar.Core.Api;
using Webyar.Core.Caching;
using Webyar.Core.Local;
using Webyar.Core.Sync;
using Xunit;
using Xunit.Abstractions;

namespace Webyar.Core.Tests;

/// <summary>
/// Before/after numbers for the same workload against the same server: the
/// old client (full thread and full queue on every tick and event) and the
/// local-first one (PC copy, deltas, 304s). Printed with
/// <c>dotnet test --logger "console;verbosity=detailed"</c> and asserted, so
/// a regression that brings the full downloads back fails the build.
/// </summary>
public class SyncMeasurementTests(ITestOutputHelper output)
{
    private const int History = 300;
    private const int QueueSize = 40;

    private static FakeSyncServer Server()
    {
        var server = new FakeSyncServer();
        for (var i = 0; i < History; i++)
        {
            server.Add("c1", $"m{i:0000}", $"Customer message number {i}: a typical line of support chat, about this long.",
                i % 2 == 0 ? SenderTypes.Contact : SenderTypes.Agent);
        }
        server.Queues[InboxFilter.Open] = Enumerable.Range(0, QueueSize)
            .Select(i => new Conversation($"c{i}", "w1", ConversationStatuses.Open, Subject: "New conversation",
                Contacts: new ConversationContact($"Visitor {i}", $"visitor{i}@example.com"),
                LastMessage: new MessagePreview("Last message preview text", DateTimeOffset.UnixEpoch.AddMinutes(i), SenderTypes.Contact), UnreadCount: i % 3))
            .ToList();
        return server;
    }

    /// <summary>
    /// One open thread for ten minutes: realtime down (5 s poll → 120 ticks) with
    /// 6 new messages, then realtime up (120 s safety poll → 5 ticks) with 10
    /// messages each announced by an event.
    /// </summary>
    private static async Task Workload(FakeSyncServer server, Func<Task> tick)
    {
        await tick(); // open
        for (var t = 1; t <= 120; t++)
        {
            if (t % 20 == 0) server.Add("c1", $"n{t}", "new while polling");
            await tick();
        }
        for (var e = 0; e < 10; e++)
        {
            server.Add("c1", $"rt{e}", "new, announced by realtime");
            await tick(); // the event's kick
        }
        for (var t = 0; t < 5; t++) await tick(); // safety polls
    }

    [Fact]
    public async Task A_thread_costs_a_fraction_of_the_requests_bytes()
    {
        var before = Server();
        var oldApi = before.Api();
        await Workload(before, () => oldApi.MessagesAsync("c1"));

        var after = Server();
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var sync = new ThreadSync(after.Api(), store);
        await Workload(after, () => sync.SyncAsync("w1", "c1"));

        var final = (await sync.LoadLocalAsync("w1", "c1"))!.Messages;
        Assert.Equal(History + 16, final.Count);

        output.WriteLine($"thread, 10 min, {History}-message history:");
        output.WriteLine($"  before: {before.Requests} requests, {before.BytesSent / 1024} KB");
        output.WriteLine($"  after:  {after.Requests} requests, {after.BytesSent / 1024} KB  ({sync.Stats})");
        Assert.True(after.BytesSent * 20 < before.BytesSent, "at least 95% fewer bytes");
    }

    [Fact]
    public async Task An_unchanged_queue_costs_nothing_but_the_request()
    {
        var before = Server();
        var oldApi = before.Api();
        for (var t = 0; t < 40; t++) await oldApi.ConversationsAsync("w1", InboxFilter.Open);

        var after = Server();
        var lists = new ConversationListSync(after.Api(), null);
        for (var t = 0; t < 40; t++)
        {
            if (t == 20) after.Queues[InboxFilter.Open][0] = after.Queues[InboxFilter.Open][0] with { UnreadCount = 9 };
            await lists.FetchAsync("w1", InboxFilter.Open);
        }
        output.WriteLine($"inbox queue ({QueueSize} conversations), 40 polls, one change:");
        output.WriteLine($"  before: {before.Requests} requests, {before.BytesSent / 1024} KB");
        output.WriteLine($"  after:  {after.Requests} requests, {after.BytesSent / 1024} KB, {after.NotModifiedCount} answered 304");
        Assert.Equal(38, after.NotModifiedCount);
        Assert.True(after.BytesSent * 10 < before.BytesSent);

        // The inbox and the background notifier asking together: one request, not two.
        var shared = Server();
        shared.BeforeRespond = _ => Task.Delay(50); // a real network answers later than the second caller asks
        var sharedLists = new ConversationListSync(shared.Api(), null);
        await Task.WhenAll(sharedLists.FetchAsync("w1", InboxFilter.Open), sharedLists.FetchAsync("w1", InboxFilter.Open));
        Assert.Equal(1, shared.Requests);
    }

    [Fact]
    public async Task The_inbox_and_thread_show_before_the_server_answers()
    {
        var server = Server();
        server.BeforeRespond = _ => Task.Delay(400); // a slow, far-away server
        using var dir = new TempDir();
        await using (var warm = await LocalStore.OpenAsync(dir.Path, "u1"))
        {
            var fast = Server();
            await new ThreadSync(fast.Api(), warm).SyncAsync("w1", "c1");
            await new ConversationListSync(fast.Api(), warm).FetchAsync("w1", InboxFilter.Open);
        }

        // Before: nothing on screen until the network answers.
        var clock = Stopwatch.StartNew();
        await server.Api().ConversationsAsync("w1", InboxFilter.Open);
        var inboxBefore = clock.Elapsed;
        clock.Restart();
        await server.Api().MessagesAsync("c1");
        var threadBefore = clock.Elapsed;

        // After: a fresh launch reads the PC's copy first.
        clock.Restart();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var inbox = await new ConversationListSync(server.Api(), store).LoadLocalAsync("w1", InboxFilter.Open);
        var inboxAfter = clock.Elapsed;
        clock.Restart();
        var thread = await new ThreadSync(server.Api(), store).LoadLocalAsync("w1", "c1");
        var threadAfter = clock.Elapsed;

        Assert.Equal(QueueSize, inbox!.Count);
        Assert.Equal(History, thread!.Messages.Count);
        output.WriteLine("time to first visible data (400 ms server):");
        output.WriteLine($"  inbox:  before {inboxBefore.TotalMilliseconds:0} ms, after {inboxAfter.TotalMilliseconds:0} ms (open + read)");
        output.WriteLine($"  thread: before {threadBefore.TotalMilliseconds:0} ms, after {threadAfter.TotalMilliseconds:0} ms ({History} messages)");
        Assert.True(inboxAfter < inboxBefore);
        Assert.True(threadAfter < threadBefore);
    }

    [Fact]
    public async Task A_file_several_views_want_is_downloaded_once()
    {
        var downloads = 0;
        var http = new FakeHttp(async _ =>
        {
            Interlocked.Increment(ref downloads);
            await Task.Delay(50);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[200_000]) };
        });
        var api = new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: http));

        // Before: each view downloaded on its own when they asked together.
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => api.AttachmentDataAsync("a1")));
        var before = downloads;

        // After: one shared download, then memory.
        downloads = 0;
        var coalescer = new Coalescer<string, byte[]>();
        var memory = new LruCache<string, byte[]>(32 * 1024 * 1024, 8 * 1024 * 1024);
        async Task<byte[]> Get()
        {
            if (memory.TryGet("a1", out var hit)) return hit;
            var data = await coalescer.RunAsync("a1", () => api.AttachmentDataAsync("a1"));
            memory.Set("a1", data, data.Length);
            return data;
        }
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Get()));
        await Get(); // opened again later
        output.WriteLine($"one photo, five views at once, then reopened: before {before} downloads, after {downloads}");
        Assert.Equal(5, before);
        Assert.Equal(1, downloads);
    }
}
