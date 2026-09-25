using System.Globalization;
using System.Net;
using System.Text.Json;
using Webyar.Core.Api;
using Webyar.Core.Calls;
using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

public class CallCenterTests
{
    private static (WebyarApi Api, FakeHttp Http) Make(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route)
    {
        var http = new FakeHttp(route);
        return (new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: http)), http);
    }

    // ── API ──

    [Fact]
    public async Task Active_calls_ask_for_the_live_ones_and_decode_the_transfer()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK,
            """{"calls":[{"id":"c1","state":"active","call_type":"video","assigned_agent_id":"me","transfer_from_agent_id":"u2","transfer_reason":"billing"}]}"""));
        var c = (await api.ActiveCallsAsync("w1")).Single();
        var q = http.Requests[0].Request.RequestUri!.Query;
        Assert.Equal("/api/call-center/calls", http.Requests[0].Request.RequestUri!.AbsolutePath);
        Assert.Contains("workspaceId=w1", q);
        Assert.Contains("status=active", q);
        Assert.Contains("limit=20", q);
        Assert.Equal("u2", c.TransferFromAgentId);
        Assert.Equal("billing", c.TransferReason);
        Assert.True(c.IsVideo);
    }

    [Theory]
    [InlineData(true, "/api/call-center/calls/c%201/spam")]
    [InlineData(false, "/api/call-center/calls/c%201/not-spam")]
    public async Task Spam_toggle_posts_without_a_body(bool spam, string path)
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK, "{}"));
        await api.MarkCallSpamAsync("w1", "c 1", spam);
        var (req, body) = http.Requests.Single();
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal(path, req.RequestUri!.AbsolutePath);
        Assert.Contains("workspaceId=w1", req.RequestUri.Query);
        Assert.Null(body);
    }

    [Fact]
    public async Task Transfer_sends_the_target_and_only_a_real_reason()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK, "{}"));
        await api.TransferCallAsync("w1", "c1", "u2", null, "  ");
        await api.TransferCallAsync("w1", "c1", null, "d1", "needs billing");
        Assert.Equal("/api/call-center/calls/c1/transfer", http.Requests[0].Request.RequestUri!.AbsolutePath);
        Assert.Contains("workspaceId=w1", http.Requests[0].Request.RequestUri!.Query);
        using var first = JsonDocument.Parse(http.Requests[0].Body!);
        Assert.Equal("w1", first.RootElement.GetProperty("workspaceId").GetString());
        Assert.Equal("u2", first.RootElement.GetProperty("to_agent_id").GetString());
        Assert.False(first.RootElement.TryGetProperty("reason", out _));
        Assert.False(first.RootElement.TryGetProperty("to_department_id", out _));
        using var second = JsonDocument.Parse(http.Requests[1].Body!);
        Assert.Equal("d1", second.RootElement.GetProperty("to_department_id").GetString());
        Assert.Equal("needs billing", second.RootElement.GetProperty("reason").GetString());
        Assert.False(second.RootElement.TryGetProperty("to_agent_id", out _));
    }

    [Fact]
    public async Task Presence_and_departments_decode()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/call-center/agents/presence" => (HttpStatusCode.OK, """{"presence":[{"user_id":"u2","status":"busy","active_call_count":"2","full_name":"Reza","email":"r@x.io"}]}"""),
            "/api/call-center/departments" => (HttpStatusCode.OK, """{"departments":[{"id":"d1","name":"Sales","enabled":true,"cc_voice_enabled":true,"cc_video_enabled":false}]}"""),
            _ => (HttpStatusCode.NotFound, "{}"),
        });
        var p = (await api.CallAgentPresenceAsync("w1")).Single();
        Assert.Equal(("u2", "busy", 2, "Reza"), (p.UserId, p.Status, p.ActiveCallCount, p.FullName));
        Assert.Contains("workspaceId=w1", http.Requests[0].Request.RequestUri!.Query);
        var d = (await api.CallDepartmentsAsync("w1")).Single();
        Assert.Equal("Sales", d.Name);
        Assert.True(d.CcVoiceEnabled);
        Assert.False(d.CcVideoEnabled);
    }

    [Fact]
    public async Task Session_profiles_send_only_uuids_and_keep_the_keys_as_they_are()
    {
        const string id = "8F14E45F-CEEA-467A-9575-6B9E1A1B2C3D";
        var (api, http) = Make((_, _) => (HttpStatusCode.OK,
            """{"by_session":{"ID":{"geo":{"country_code":"IR","country":"Iran","city":"Tehran"},"device":{"os":"Windows 11","browser":"Edge"}}}}""".Replace("ID", id)));
        var got = await api.SessionProfilesAsync("w1", [id, "not-a-uuid", "8f14e45fceea467a95756b9e1a1b2c3d", id]);
        using var body = JsonDocument.Parse(http.Requests.Single().Body!);
        Assert.Equal("w1", body.RootElement.GetProperty("workspace_id").GetString());
        Assert.Equal(new[] { id }, body.RootElement.GetProperty("session_ids").EnumerateArray().Select(e => e.GetString() ?? string.Empty));
        var p = got[id];
        Assert.Equal("IR", p.Geo!.CountryCode);
        Assert.Equal("Windows 11", p.Device!.Os);
    }

    [Fact]
    public async Task Session_profiles_ask_nothing_without_a_uuid_and_shrug_off_a_failure()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.InternalServerError, "{}"));
        Assert.Empty(await api.SessionProfilesAsync("w1", ["abc"]));
        Assert.Empty(http.Requests);
        Assert.Empty(await api.SessionProfilesAsync("w1", [Guid.NewGuid().ToString()]));
    }

    // ── Spam ──

    [Fact]
    public void Spam_is_a_non_null_metadata_entry()
    {
        static CallSession With(string meta) => new("c1", Metadata: JsonDocument.Parse(meta).RootElement.Clone());
        Assert.False(new CallSession("c1").IsSpam);
        Assert.False(With("""{"spam":null}""").IsSpam);
        Assert.False(With("""{"other":1}""").IsSpam);
        Assert.True(With("""{"spam":{"marked_by":"u1"}}""").IsSpam);
        Assert.True(With("""{"spam":true}""").IsSpam);
    }

    [Fact]
    public void Spam_toggle_keeps_the_rest_of_the_metadata()
    {
        var c = new CallSession("c1", Metadata: JsonDocument.Parse("""{"source":"widget"}""").RootElement.Clone());
        var marked = c.WithSpam(true, "u1");
        Assert.True(marked.IsSpam);
        Assert.Equal("u1", marked.Metadata!.Value.GetProperty("spam").GetProperty("marked_by").GetString());
        Assert.Equal("widget", marked.Metadata.Value.GetProperty("source").GetString());
        var cleared = marked.WithSpam(false, null);
        Assert.False(cleared.IsSpam);
        Assert.Equal("widget", cleared.Metadata!.Value.GetProperty("source").GetString());
        Assert.True(new CallSession("c2").WithSpam(true, null).IsSpam);
    }

    // ── Hand-over ──

    private static CallSession Handed(string id, string to = "me", string? from = "u2") =>
        new(id, State: "active", AssignedAgentId: to, TransferFromAgentId: from);

    [Fact]
    public void Handed_calls_are_mine_from_someone_else_and_not_the_one_i_am_on()
    {
        var calls = new[]
        {
            Handed("a"),
            Handed("b", to: "u3"),
            Handed("c", from: null),
            Handed("d", from: "me"),
            Handed("e"),
        };
        Assert.Equal(["a", "e"], HandedCalls.Mine(calls, "me", null).Select(c => c.Id));
        Assert.Equal(["e"], HandedCalls.Mine(calls, "me", "a").Select(c => c.Id));
    }

    [Fact]
    public void A_handed_call_is_offered_once_and_goes_when_it_leaves()
    {
        var h = new HandedCalls();
        Assert.Equal("a", h.Notice([Handed("a"), Handed("b")], "me", null)?.Id);
        Assert.Equal("a", h.Current?.Id);
        // Still up: nothing new, the banner keeps the first.
        Assert.Null(h.Notice([Handed("a"), Handed("b")], "me", null));
        Assert.Equal("a", h.Current?.Id);
        // Joined elsewhere (or over): the banner moves to the next one not offered yet.
        Assert.Equal("b", h.Notice([Handed("b")], "me", null)?.Id);
        h.Dismiss();
        Assert.Null(h.Notice([Handed("b")], "me", null));
        Assert.Null(h.Current);
        // The call I am on is never offered.
        Assert.Null(h.Notice([Handed("c")], "me", "c"));
        Assert.Null(h.Notice([Handed("x")], null, null));
        h.Reset();
        Assert.Equal("b", h.Notice([Handed("b")], "me", null)?.Id);
    }

    [Fact]
    public void Handover_waits_for_the_colleague_or_any_other_operator_for_a_department()
    {
        string?[] room = ["visitor:abc", "operator:me"];
        Assert.False(Handover.Joined(room, "operator:me", "u2"));
        Assert.False(Handover.Joined(room, "operator:me", null));
        string?[] joined = ["visitor:abc", "operator:me", "operator:u2"];
        Assert.True(Handover.Joined(joined, "operator:me", "u2"));
        Assert.False(Handover.Joined(joined, "operator:me", "u3"));
        Assert.True(Handover.Joined(joined, "operator:me", null));
        Assert.True(Handover.IsOperator("operator:x"));
        Assert.False(Handover.IsOperator("visitor:operator:x"));
    }

    // ── Transfer targets ──

    [Fact]
    public void Transfer_operators_are_assignable_colleagues_by_state_then_name()
    {
        WorkspaceMember M(string user, string? role, string name, bool suspended = false) =>
            new("m-" + user, user, role, suspended ? DateTimeOffset.UnixEpoch : null, new MemberProfile(FullName: name));
        var members = new[]
        {
            M("me", "owner", "Me"),
            M("u1", "agent", "Zahra"),
            M("u2", "admin", "Ali"),
            M("u3", "viewer", "Viewer"),
            M("u4", "support_agent", "Bahar", suspended: true),
            M("u5", "team_lead", "Omid"),
            M("u6", null, "Nima"),
            M("u7", "agent", "Kian"),
        };
        var presence = new[]
        {
            new CallAgentPresence("u1", "available"),
            new CallAgentPresence("u2", "busy", 2),
            new CallAgentPresence("u5", "available"),
            new CallAgentPresence("u6", "away"),
        };
        var list = TransferTargets.Operators(members, presence, "me", CultureInfo.InvariantCulture);
        Assert.Equal(["Omid", "Zahra", "Ali", "Nima", "Kian"], list.Select(o => o.Name));
        Assert.Equal(2, list.Single(o => o.UserId == "u2").ActiveCalls);
        Assert.Equal("offline", list.Single(o => o.UserId == "u7").Status);
        Assert.Equal("callAgentBusy", TransferTargets.StatusKey("busy"));
        Assert.Equal("callAgentOffline", TransferTargets.StatusKey("weird"));
    }

    [Fact]
    public void Transfer_departments_take_the_kind_of_call()
    {
        var all = new[]
        {
            new CallDepartment("d1", "Voice only", true, true, false),
            new CallDepartment("d2", "Off", false, true, true),
            new CallDepartment("d3", "Unset"),
            new CallDepartment("d4", "Video only", true, false, true),
        };
        Assert.Equal(["d1", "d3"], TransferTargets.Departments(all, video: false).Select(d => d.Id));
        Assert.Equal(["d3", "d4"], TransferTargets.Departments(all, video: true).Select(d => d.Id));
    }

    // ── Clock and failures ──

    [Fact]
    public void Call_clock_counts_minutes_then_hours_in_the_language_digits()
    {
        Assert.Equal("00:00", CallRules.Clock(TimeSpan.FromSeconds(-3), Language.En));
        Assert.Equal("01:05", CallRules.Clock(TimeSpan.FromSeconds(65), Language.En));
        Assert.Equal("01:00:07", CallRules.Clock(TimeSpan.FromSeconds(3607), Language.En));
        Assert.Equal("۰۱:۰۵", CallRules.Clock(TimeSpan.FromSeconds(65), Language.Fa));
    }

    [Fact]
    public void Only_transport_and_server_errors_are_worth_another_poll()
    {
        Assert.True(CallRules.IsTransient(new ApiException(ApiFailure.Transport)));
        Assert.True(CallRules.IsTransient(new ApiException(ApiFailure.Server, 502)));
        Assert.False(CallRules.IsTransient(new ApiException(ApiFailure.Server, 404)));
        Assert.False(CallRules.IsTransient(new ApiException(ApiFailure.Unauthorized, 401)));
        Assert.False(CallRules.IsTransient(new InvalidOperationException()));
    }

    // ── Notes beside a call ──

    [Fact]
    public void Notes_show_at_once_and_a_failed_one_can_go_again_or_be_dropped()
    {
        var book = new CallNoteBook();
        Assert.Null(book.Shown);
        Assert.Null(book.Add("   ", "Me", DateTimeOffset.UnixEpoch));
        var a = book.Add(" first ", "Me", DateTimeOffset.UnixEpoch)!;
        Assert.Equal("first", a.Text);
        Assert.Equal(NoteSending.Going, Assert.Single(book.Shown!).Sending);

        book.SetSaved([new CallNoteItem("n2", "later", "Ali", DateTimeOffset.UnixEpoch.AddMinutes(2)), new CallNoteItem("n1", "earlier", "Ali", DateTimeOffset.UnixEpoch.AddMinutes(1))]);
        Assert.Equal(["earlier", "later", "first"], book.Shown!.Select(n => n.Text));

        book.Failed(a.Id);
        Assert.True(book.HasFailed);
        Assert.Equal(NoteSending.Going, book.Retry(a.Id)!.Sending);
        Assert.Null(book.Retry(a.Id));
        book.Failed(a.Id);
        Assert.True(book.Discard(a.Id));
        Assert.False(book.HasFailed);
        Assert.Equal(2, book.Shown!.Count);

        var b = book.Add(new string('x', 2500), null, DateTimeOffset.UnixEpoch)!;
        Assert.Equal(CallNoteBook.MaxLength, b.Text.Length);
        Assert.False(book.Discard(b.Id)); // only a failed note can be dropped
        book.Delivered(b.Id);
        Assert.Empty(book.Outbox);
    }

    [Fact]
    public void Notes_that_cannot_be_read_show_as_none()
    {
        var book = new CallNoteBook();
        book.SavedUnavailable();
        Assert.Empty(book.Shown!);
    }
}
