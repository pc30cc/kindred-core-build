using System.Net;
using System.Threading.Channels;
using Webyar.Core.Api;
using Webyar.Core.Realtime;
using Xunit;

namespace Webyar.Core.Tests;

public class RealtimeTests
{
    [Fact]
    public void Parses_pings_replies_and_publications_in_one_message()
    {
        var frames = CentrifugoProtocol.Parse("""
            {}
            {"id":1,"connect":{"client":"x"}}
            {"push":{"channel":"ws:w1:inbox","pub":{"data":{"type":"message","payload":{"id":"m1","conversation_id":"c1","sender_type":"contact","body":"سلام"}}}}}
            {"push":{"disconnect":{"code":3001}}}
            not json
            """).ToList();
        Assert.IsType<CentrifugoFrame.Ping>(frames[0]);
        Assert.Equal(1, Assert.IsType<CentrifugoFrame.Reply>(frames[1]).Id);
        var pub = Assert.IsType<CentrifugoFrame.Publication>(frames[2]);
        Assert.True(pub.Event.IsVisitorMessage);
        Assert.Equal("c1", pub.Event.ConversationId);
        Assert.IsType<CentrifugoFrame.Disconnect>(frames[3]);
        Assert.Equal(4, frames.Count);
    }

    [Fact]
    public void An_error_reply_carries_the_message()
    {
        var reply = Assert.IsType<CentrifugoFrame.Reply>(CentrifugoProtocol.Parse("""{"id":2,"error":{"code":103,"message":"permission denied"}}""").Single());
        Assert.Equal("permission denied", reply.Error);
    }

    [Fact]
    public async Task Connects_subscribes_answers_pings_and_delivers_events()
    {
        var http = new FakeHttp((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/realtime/operator-connect" => (HttpStatusCode.OK, """{"vendor":"centrifugo","ws_url":"wss://rt.example/connection/websocket","token":"ct","expires_at":4102444800000}"""),
            "/api/realtime/operator-presence-subscribe" => (HttpStatusCode.OK, """{"vendor":"centrifugo","channel":"ws:w1:operators","token":"pt","expires_at":4102444800000}"""),
            _ => (HttpStatusCode.OK, """{"vendor":"centrifugo","channel":"ws:w1:inbox","token":"st","expires_at":4102444800000}"""),
        });
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        var socket = new FakeSocket();
        await using var rt = new InboxRealtime(new WebyarApi(client), "w1", () => socket);
        var events = Channel.CreateUnbounded<InboxEvent>();
        var connected = new TaskCompletionSource();
        rt.EventReceived += e => events.Writer.TryWrite(e);
        var joined = new TaskCompletionSource();
        rt.ConnectionChanged += up => { if (up) connected.TrySetResult(); };
        rt.PresenceJoined += () => joined.TrySetResult();
        rt.Start();

        Assert.Contains("\"connect\"", await socket.Sent.Reader.ReadAsync());
        socket.Incoming.Writer.TryWrite("""{"id":1,"connect":{}}""");
        var subscribe = await socket.Sent.Reader.ReadAsync();
        Assert.Contains("ws:w1:inbox", subscribe);
        socket.Incoming.Writer.TryWrite("""{"id":2,"subscribe":{}}""");
        await connected.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(rt.IsConnected);

        // Then it joins the operators channel, which is what marks the operator connected for teammates.
        Assert.Contains("ws:w1:operators", await socket.Sent.Reader.ReadAsync());
        socket.Incoming.Writer.TryWrite("""{"id":3,"subscribe":{}}""");
        await joined.Task.WaitAsync(TimeSpan.FromSeconds(5));

        socket.Incoming.Writer.TryWrite("{}");
        Assert.Equal("{}", await socket.Sent.Reader.ReadAsync());

        const string pub = """{"push":{"channel":"ws:w1:inbox","pub":{"data":{"type":"message","payload":{"id":"m9","conversation_id":"c3","sender_type":"contact"}}}}}""";
        socket.Incoming.Writer.TryWrite(pub);
        socket.Incoming.Writer.TryWrite(pub); // replayed after a resubscribe: delivered once
        socket.Incoming.Writer.TryWrite("""{"push":{"pub":{"data":{"type":"event","payload":{"kind":"conversation_updated","conversation_id":"c3"}}}}}""");
        var first = await events.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        var second = await events.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("m9", first.MessageId);
        Assert.Equal("conversation_updated", second.Kind);
    }

    [Fact]
    public async Task Without_realtime_it_never_opens_a_socket()
    {
        var http = new FakeHttp((_, _) => (HttpStatusCode.OK, """{"vendor":"polling_builtin"}"""));
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        var opened = false;
        await using var rt = new InboxRealtime(new WebyarApi(client), "w1", () => { opened = true; return new FakeSocket(); });
        rt.Start();
        await Task.Delay(300);
        Assert.False(opened);
        Assert.False(rt.IsConnected);
        Assert.Single(http.Requests);
    }

    private sealed class FakeSocket : IRealtimeSocket
    {
        public Channel<string> Sent { get; } = Channel.CreateUnbounded<string>();
        public Channel<string?> Incoming { get; } = Channel.CreateUnbounded<string?>();
        public Task ConnectAsync(Uri url, CancellationToken ct) => Task.CompletedTask;
        public Task SendAsync(string text, CancellationToken ct) { Sent.Writer.TryWrite(text); return Task.CompletedTask; }
        public async Task<string?> ReceiveAsync(CancellationToken ct) => await Incoming.Reader.ReadAsync(ct);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
