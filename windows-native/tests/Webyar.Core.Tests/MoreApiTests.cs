using System.Net;
using Webyar.Core.Api;
using Xunit;

namespace Webyar.Core.Tests;

public class MoreApiTests
{
    private static (WebyarApi Api, FakeHttp Http) Make(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route)
    {
        var http = new FakeHttp(route);
        return (new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: http)), http);
    }

    [Fact]
    public async Task Attachments_are_reserved_then_uploaded_as_base64()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/conversation-attachments/init" => (HttpStatusCode.OK, """{"attachment_id":"att-9"}"""),
            _ => (HttpStatusCode.OK, "{}"),
        });
        var id = await api.UploadAttachmentAsync("w1", "c1", "a.png", "image/png", [1, 2, 3]);
        Assert.Equal("att-9", id);
        Assert.Contains("\"size_bytes\":3", http.Requests[0].Body);
        Assert.Equal("/api/conversation-attachments/att-9/upload", http.Requests[1].Request.RequestUri!.AbsolutePath);
        Assert.Contains("\"data\":\"AQID\"", http.Requests[1].Body);
    }

    [Fact]
    public async Task Email_threads_decode_the_camel_case_mailbox_answer()
    {
        var (api, _) = Make((_, _) => (HttpStatusCode.OK,
            """{"threads":[{"id":"t1","subject":"سلام","participants":[{"email":"a@b.c"}],"lastMessageAt":"2026-09-20T10:00:00Z","isRead":false,"lastMessageSnippet":"hi"}]}"""));
        var t = (await api.EmailThreadsAsync("w1")).Single();
        Assert.Equal("سلام", t.Subject);
        Assert.False(t.IsRead);
        Assert.Equal("a@b.c", t.Participants!.Single().Email);
        Assert.Equal("hi", t.LastMessageSnippet);
    }

    [Fact]
    public async Task Members_notes_and_colleagues_decode()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/workspace-members" => (HttpStatusCode.OK, """{"members":[{"id":"m1","user_id":"u1","role":"owner","profile":{"full_name":"Sara"}}]}"""),
            "/api/conversations/c1/notes" => (HttpStatusCode.OK, """{"notes":[{"id":"n1","body":"call back","author":{"full_name":"Ali"}}]}"""),
            _ => (HttpStatusCode.OK, """{"colleagues":[{"user_id":"u2","full_name":"Reza","unread":2,"last_message":{"body":"yo","outgoing":true}}],"total_unread":2,"me":"u1"}"""),
        });
        Assert.Equal("Sara", (await api.MembersAsync("w1")).Single().DisplayName);
        Assert.Contains("workspaceId=w1", http.Requests[0].Request.RequestUri!.Query);
        Assert.Equal("Ali", (await api.NotesAsync("c1", "w1")).Single().Author!.FullName);
        var col = await api.ColleaguesAsync("w1");
        Assert.Equal(2, col.TotalUnread);
        Assert.True(col.Colleagues!.Single().LastMessage!.Outgoing);
    }

    [Fact]
    public async Task Tags_patch_sends_the_whole_list_and_call_token_omits_an_empty_name()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath.EndsWith("/token", StringComparison.Ordinal)
            ? (HttpStatusCode.OK, """{"token":"jwt","ws_url":"wss://lk","turn":{"urls":["turn:x"]}}""")
            : (HttpStatusCode.OK, "{}"));
        await api.SetTagsAsync("c1", "w1", ["vip", "بازگشتی"]);
        Assert.Equal(HttpMethod.Patch, http.Requests[0].Request.Method);
        Assert.Contains("\"tags\":[\"vip\"", http.Requests[0].Body);
        var token = await api.CallTokenAsync("s1", "  ");
        Assert.Equal("wss://lk", token.WsUrl);
        Assert.Equal("turn:x", token.Turn!.Urls!.Single());
        Assert.DoesNotContain("display_name", http.Requests[1].Body);
    }

    [Fact]
    public async Task Take_over_falls_back_to_the_ai_agent_route_on_404()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath.StartsWith("/api/conversations/", StringComparison.Ordinal)
            ? (HttpStatusCode.NotFound, """{"error":"nope"}""")
            : (HttpStatusCode.OK, "{}"));
        await api.TakeOverAsync("c1", "w1");
        Assert.Equal("/api/ai-agent/conversations/c1/take-over", http.Requests[1].Request.RequestUri!.AbsolutePath);
    }
}
