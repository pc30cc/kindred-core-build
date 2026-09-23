using System.Net;
using Webyar.Core.Api;
using Xunit;

namespace Webyar.Core.Tests;

public class ApiTests
{
    [Fact]
    public async Task Login_asks_for_a_bearer_session_and_keeps_the_token()
    {
        var http = new FakeHttp((req, body) => req.RequestUri!.AbsolutePath switch
        {
            "/api/auth/login" => (HttpStatusCode.OK, """{"sessionToken":"tok-1","user":{"id":"u1","email":"a@b.c","fullName":"Mojtaba"}}"""),
            _ => (HttpStatusCode.OK, """{"workspaces":[{"id":"w1","name":"وب یار","slug":"webyar"}]}"""),
        });
        var session = new MemorySessionStore();
        using var client = new ApiClient(session, handler: http);

        var user = await client.LoginAsync("a@b.c", "pw");
        Assert.Equal("Mojtaba", user.FullName);
        Assert.Equal("tok-1", session.Read());
        Assert.Contains("\"client\":\"mobile\"", http.Requests[0].Body);
        Assert.Null(http.Requests[0].Request.Headers.Authorization);

        var workspaces = await new WebyarApi(client).WorkspacesAsync();
        Assert.Equal("وب یار", workspaces.Single().Name);
        Assert.Equal("Bearer tok-1", http.Requests[1].Request.Headers.Authorization!.ToString());
        // Never an Origin header: that is what makes the server hand out Bearer sessions.
        Assert.False(http.Requests[0].Request.Headers.Contains("Origin"));
    }

    [Fact]
    public async Task A_401_raises_unauthorized_and_a_403_does_not()
    {
        var status = HttpStatusCode.Unauthorized;
        var http = new FakeHttp((_, _) => (status, """{"error":"nope"}"""));
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        var raised = 0;
        client.Unauthorized += (_, _) => raised++;

        var e401 = await Assert.ThrowsAsync<ApiException>(() => new WebyarApi(client).WorkspacesAsync());
        Assert.Equal(ApiFailure.Unauthorized, e401.Failure);
        Assert.Equal(1, raised);

        status = HttpStatusCode.Forbidden;
        var e403 = await Assert.ThrowsAsync<ApiException>(() => new WebyarApi(client).WorkspacesAsync());
        Assert.Equal(ApiFailure.Server, e403.Failure);
        Assert.Equal("nope", e403.ServerMessage);
        Assert.Equal(1, raised);
    }

    [Fact]
    public async Task Conversations_decode_the_real_server_shape()
    {
        // Trimmed from a real /api/conversations answer.
        const string json = """
        {"conversations":[{"id":"8304da33","workspace_id":"6ee40d07","contact_id":"6d14","subject":"New conversation","status":"open",
          "assigned_to":"fc7c4681","priority":"urgent","tags":[],"created_at":"2026-09-18T19:52:28.439915+00:00",
          "updated_at":"2026-09-22T23:28:32.97+00:00","metadata":{"source":"ai_agent_intro"},"ai_state":"human_active",
          "contacts":{"id":"6d14","name":"تستم","email":"test@test.com","avatar_url":null,"visitor_code":"79NA"},
          "last_message":{"body":"","created_at":"2026-09-19T12:22:40.980235+00:00","sender_type":"agent","sender_name":"مجتبی داودی","attachment_kind":"image"},
          "unread_count":0}]}
        """;
        var http = new FakeHttp((_, _) => (HttpStatusCode.OK, json));
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        var list = await new WebyarApi(client).ConversationsAsync("6ee40d07", InboxFilter.Open);

        var c = Assert.Single(list);
        Assert.Equal("تستم", c.Contacts!.Name);
        Assert.Equal("urgent", c.Priority);
        Assert.Equal("image", c.LastMessage!.AttachmentKind);
        Assert.Equal(new DateTimeOffset(2026, 9, 19, 12, 22, 40, TimeSpan.Zero), c.LastActivity!.Value.AddTicks(-(c.LastActivity.Value.Ticks % TimeSpan.TicksPerSecond)));
        var url = http.Requests[0].Request.RequestUri!.Query;
        Assert.Contains("workspace_id=6ee40d07", url);
        Assert.Contains("queue=main", url);
        Assert.Contains("status=open", url);
    }

    [Fact]
    public async Task Send_message_omits_a_missing_attachment_and_keeps_the_idempotency_key()
    {
        var http = new FakeHttp((_, _) => (HttpStatusCode.OK, "{}"));
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        await new WebyarApi(client).SendMessageAsync("c1", "w1", "سلام", "key-1");
        var body = http.Requests[0].Body!;
        Assert.Contains("\"client_message_id\":\"key-1\"", body);
        Assert.Contains("\"conversation_id\":\"c1\"", body);
        Assert.DoesNotContain("attachment_id", body);
    }

    [Fact]
    public async Task Unassign_sends_an_explicit_null()
    {
        var http = new FakeHttp((_, _) => (HttpStatusCode.OK, ""));
        using var client = new ApiClient(new MemorySessionStore("t"), handler: http);
        await new WebyarApi(client).UpdateConversationAsync("c1", "w1", unassign: true);
        Assert.Equal(HttpMethod.Patch, http.Requests[0].Request.Method);
        Assert.Contains("\"assigned_to\":null", http.Requests[0].Body);
    }

    [Fact]
    public async Task Offline_is_a_transport_failure()
    {
        using var client = new ApiClient(new MemorySessionStore(), handler: new ThrowingHandler());
        var e = await Assert.ThrowsAsync<ApiException>(() => client.GetAsync<object>("/api/workspaces"));
        Assert.Equal(ApiFailure.Transport, e.Failure);
    }

    [Fact]
    public async Task Origin_discovery_moves_to_the_platform_answer()
    {
        var http = new FakeHttp((_, _) => (HttpStatusCode.OK, """{"apiBaseUrl":"https://api.example.com/some/path","supportUrl":"https://help.example.com"}"""));
        using var client = new ApiClient(new MemorySessionStore(), handler: http);
        var origins = await client.RefreshOriginAsync();
        Assert.Equal("https://help.example.com", origins!.SupportUrl);
        Assert.Equal(new Uri("https://api.example.com/"), client.Origin);
    }

    [Fact]
    public async Task Only_api_paths_are_allowed()
    {
        using var client = new ApiClient(new MemorySessionStore());
        await Assert.ThrowsAsync<ArgumentException>(() => client.GetAsync<object>("/admin"));
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new HttpRequestException("offline");
    }
}
