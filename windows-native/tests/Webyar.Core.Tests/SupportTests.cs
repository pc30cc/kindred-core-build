using System.Net;
using Webyar.Core.Api;
using Webyar.Core.Localization;
using Webyar.Core.Support;
using Xunit;

namespace Webyar.Core.Tests;

public class SupportApiTests
{
    private static (WebyarApi Api, FakeHttp Http) Make(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route)
    {
        var http = new FakeHttp(route);
        return (new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: http)), http);
    }

    [Fact]
    public async Task Status_reads_the_camel_case_answer_with_hours()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK,
            """{"enabled":true,"available":true,"online":false,"teamName":"Webyar","teamAvatar":"https://x/a.png","unread":3,"hours":{"timezone":"Asia/Tehran","weekly":{"sat":[{"from":"09:00","to":"17:00"}]}},"nextOpenAt":"2026-10-03T05:30:00Z"}"""));
        var s = await api.SupportStatusAsync();
        Assert.True(s.Shown);
        Assert.False(s.Online);
        Assert.Equal("Webyar", s.TeamName);
        Assert.Equal(3, s.Unread);
        Assert.Equal("Asia/Tehran", s.Hours!.Timezone);
        Assert.Equal("09:00", s.Hours.Weekly!["sat"][0].From);
        Assert.Equal(new DateTimeOffset(2026, 10, 3, 5, 30, 0, TimeSpan.Zero), s.NextOpenAt);
        Assert.Equal("/api/platform-support/status", http.Requests[0].Request.RequestUri!.AbsolutePath);
        Assert.Equal("windows", http.Requests[0].Request.Headers.GetValues("X-Client-Platform").Single());
    }

    [Fact]
    public async Task History_reads_conversations_items_and_attachments()
    {
        var (api, _) = Make((_, _) => (HttpStatusCode.OK, """
            {"conversations":[{"id":"c1","status":"resolved","createdAt":"2026-09-30T08:00:00Z","endedAt":"2026-09-30T09:00:00Z","canRate":true,"rating":null}],
             "items":[{"id":"i1","conversationId":"c1","kind":"message","author":"team","body":"hi","senderName":"Sara","clientMessageId":null,
                       "attachments":[{"id":"f1","fileName":"a.png","mimeType":"image/png","sizeBytes":12,"kind":"image"}]}],
             "activeConversationId":null}
            """));
        var h = await api.SupportHistoryAsync();
        var c = Assert.Single(h.Conversations!);
        Assert.True(c.Ended);
        Assert.True(c.CanRate);
        var item = Assert.Single(h.Items!);
        Assert.True(item.FromTeam);
        Assert.Equal("support:f1", item.Files.Single().StoreId);
        Assert.Null(h.ActiveConversationId);
    }

    [Fact]
    public async Task A_message_goes_as_camel_case_and_leaves_out_a_missing_conversation()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK,
            """{"conversation":{"id":"c9","status":"open"},"item":{"id":"i9","conversationId":"c9","author":"me","body":"سلام","clientMessageId":"m1"}}"""));
        var r = await api.SendSupportMessageAsync("سلام", "m1", null, "w1");
        Assert.Equal("c9", r.Conversation.Id);
        var body = http.Requests[0].Body!;
        Assert.Contains("\"clientMessageId\":\"m1\"", body);
        Assert.Contains("\"workspaceId\":\"w1\"", body);
        Assert.DoesNotContain("conversationId", body);
        Assert.Equal("/api/platform-support/messages", http.Requests[0].Request.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task A_file_goes_as_base64_to_its_conversation()
    {
        var (api, http) = Make((_, _) => (HttpStatusCode.OK,
            """{"conversation":{"id":"c1","status":"open"},"item":{"id":"i2","conversationId":"c1","author":"me"}}"""));
        await api.SendSupportAttachmentAsync("a.png", "image/png", [1, 2, 3], "m2", "c1", null);
        var body = http.Requests[0].Body!;
        Assert.Contains("\"data\":\"AQID\"", body);
        Assert.Contains("\"conversationId\":\"c1\"", body);
        Assert.Contains("\"mimeType\":\"image/png\"", body);
        Assert.DoesNotContain("workspaceId", body);
    }

    [Fact]
    public async Task Rating_read_and_files_use_their_paths()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/platform-support/conversations/c%201/rating" => (HttpStatusCode.OK, """{"conversation":{"id":"c 1","status":"resolved","rating":{"score":4,"comment":"ok"}}}"""),
            _ => (HttpStatusCode.OK, """{"ok":true}"""),
        });
        var rated = await api.RateSupportConversationAsync("c 1", 4, "ok");
        Assert.Equal(4, rated.Rating!.Score);
        Assert.Contains("\"score\":4", http.Requests[0].Body);
        await api.MarkSupportReadAsync();
        Assert.Equal("/api/platform-support/read", http.Requests[1].Request.RequestUri!.AbsolutePath);
        Assert.Equal(HttpMethod.Post, http.Requests[1].Request.Method);
    }

    [Fact]
    public async Task Server_codes_become_the_operators_words()
    {
        var (api, _) = Make((_, _) => (HttpStatusCode.Conflict, """{"error":"conversation_ended"}"""));
        var e = await Assert.ThrowsAsync<ApiException>(() => api.SendSupportMessageAsync("x", "m", "c1", null));
        var fa = new Strings(Language.Fa);
        Assert.True(SupportRules.IsConversationEnded(e));
        Assert.Equal(fa["supportConversationEnded"], SupportRules.ErrorText(e, fa));
        Assert.Equal(fa["supportFileTooLarge"], SupportRules.ErrorText(new ApiException(ApiFailure.Server, 413, "file_too_large"), fa));
        Assert.Equal(fa["supportUnavailable"], SupportRules.ErrorText(new ApiException(ApiFailure.Server, 403, "support_disabled"), fa));
        Assert.Equal(fa["supportRateLimited"], SupportRules.ErrorText(new ApiException(ApiFailure.Server, 429, "rate_limited"), fa));
        Assert.Equal(fa["offlineBody"], SupportRules.ErrorText(new ApiException(ApiFailure.Transport), fa));
        Assert.True(SupportRules.IsStaleRating(new ApiException(ApiFailure.Server, 409, "already_rated")));
    }
}

public class SupportRulesTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("photo.JPG", null, "image/jpeg")]
    [InlineData("doc.pdf", "application/octet-stream", "application/pdf")]
    [InlineData("notes.txt", null, "text/plain")]
    [InlineData("clip", "image/jpg", "image/jpeg")]
    [InlineData("voice.m4a", "audio/mp4", null)]
    [InlineData("sheet.xlsx", null, null)]
    public void Only_the_six_types_are_sendable(string name, string? contentType, string? expected) =>
        Assert.Equal(expected, SupportRules.CanonicalMime(name, contentType));

    [Fact]
    public void Files_are_refused_before_the_upload()
    {
        Assert.Equal(SupportRules.FileVerdict.Ok, SupportRules.CheckFile("image/png", SupportRules.MaxFileBytes));
        Assert.Equal(SupportRules.FileVerdict.TooLarge, SupportRules.CheckFile("image/png", SupportRules.MaxFileBytes + 1));
        Assert.Equal(SupportRules.FileVerdict.TypeNotAllowed, SupportRules.CheckFile("audio/mp4", 10));
        Assert.Equal(SupportRules.FileVerdict.TypeNotAllowed, SupportRules.CheckFile(null, 10));
        Assert.Equal(SupportRules.FileVerdict.Empty, SupportRules.CheckFile("text/plain", 0));
    }

    [Fact]
    public void Closed_conversations_are_the_ended_ones_newest_first()
    {
        var list = SupportRules.Closed([
            new SupportConversation("a", "resolved", EndedAt: Now.AddDays(-3)),
            new SupportConversation("b", "open"),
            new SupportConversation("c", "closed", EndedAt: Now.AddDays(-1)),
            new SupportConversation("d", "pending"),
        ]);
        Assert.Equal(["c", "a"], list.Select(c => c.Id));
    }

    [Fact]
    public void A_closed_conversation_is_known_by_the_operators_first_words()
    {
        SupportItem[] items =
        [
            new("j", "c1", SupportItem.KindJoined, SupportItem.AuthorTeam, SenderName: "Sara"),
            new("t", "c1", Author: SupportItem.AuthorTeam, Body: "Hello there"),
            new("m", "c1", Body: "  My invoice\nis wrong "),
            new("f", "c2", Attachments: [new SupportAttachment("f1", "receipt.pdf")]),
            new("t3", "c3", Author: SupportItem.AuthorTeam, Body: "We fixed it"),
        ];
        Assert.Equal("My invoice", SupportRules.Preview("c1", items));
        Assert.Equal("receipt.pdf", SupportRules.Preview("c2", items));
        Assert.Equal("We fixed it", SupportRules.Preview("c3", items));
        Assert.Null(SupportRules.Preview("c4", items));
        var en = new Strings(Language.En);
        Assert.Equal(en["supportConversationUntitled"], SupportRules.ClosedTitle(null, en));
    }

    [Fact]
    public void Closed_subtitle_says_how_and_when()
    {
        var en = new Strings(Language.En);
        var c = new SupportConversation("c", "closed", EndedAt: Now.AddHours(-1));
        Assert.Equal("Closed · Today", SupportRules.ClosedSubtitle(c, en, Now, TimeZoneInfo.Utc));
        var r = new SupportConversation("r", "resolved", EndedAt: Now.AddDays(-1));
        Assert.Equal("Resolved · Yesterday", SupportRules.ClosedSubtitle(r, en, Now, TimeZoneInfo.Utc));
    }

    [Fact]
    public void Next_opening_names_the_day_only_when_it_is_not_today()
    {
        var en = new Strings(Language.En);
        Assert.Equal("We'll be back at 14:30", SupportRules.NextOpen(Now.AddHours(2.5), en, Now, TimeZoneInfo.Utc));
        Assert.Equal("We'll be back tomorrow at 09:00", SupportRules.NextOpen(new DateTimeOffset(2026, 10, 2, 9, 0, 0, TimeSpan.Zero), en, Now, TimeZoneInfo.Utc));
        Assert.Equal("We'll be back Saturday at 09:00", SupportRules.NextOpen(new DateTimeOffset(2026, 10, 3, 9, 0, 0, TimeSpan.Zero), en, Now, TimeZoneInfo.Utc));
        var fa = new Strings(Language.Fa);
        Assert.Equal("از فردا ساعت ۰۹:۰۰ پاسخگو هستیم", SupportRules.NextOpen(new DateTimeOffset(2026, 10, 2, 9, 0, 0, TimeSpan.Zero), fa, Now, TimeZoneInfo.Utc));
        var tr = new Strings(Language.Tr);
        Assert.StartsWith("Yarın saat", SupportRules.NextOpen(new DateTimeOffset(2026, 10, 2, 9, 0, 0, TimeSpan.Zero), tr, Now, TimeZoneInfo.Utc));
    }

    [Fact]
    public void Joins_and_stars_read_naturally()
    {
        var en = new Strings(Language.En);
        Assert.Equal("Support team joined the conversation", SupportRules.Joined(null, en));
        Assert.Contains("Sara", SupportRules.Joined("Sara", en));
        Assert.Equal("1 star", SupportRules.Stars(1, en));
        Assert.Equal("4 stars", SupportRules.Stars(4, en));
        Assert.Equal("۴ ستاره", SupportRules.Stars(4, new Strings(Language.Fa)));
    }

    [Fact]
    public void Every_support_string_is_in_all_three_languages()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Webyar.Core", "Localization", "strings.json");
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
        var keys = doc.RootElement.GetProperty("en").EnumerateObject().Select(p => p.Name).Where(k => k.StartsWith("support", StringComparison.Ordinal)).ToList();
        Assert.True(keys.Count > 40);
        foreach (var lang in new[] { "fa", "tr" })
        {
            var table = doc.RootElement.GetProperty(lang);
            foreach (var key in keys)
                Assert.True(table.TryGetProperty(key, out var v) && v.GetString() is { Length: > 0 }, $"{lang}.{key}");
        }
    }
}

public class SupportHoursTests
{
    private static SupportHours Week(params (string Day, string From, string To)[] open)
    {
        var weekly = new Dictionary<string, IReadOnlyList<SupportInterval>>();
        foreach (var (day, from, to) in open)
        {
            var list = weekly.TryGetValue(day, out var l) ? l.ToList() : [];
            list.Add(new SupportInterval(from, to));
            weekly[day] = list;
        }
        return new SupportHours("Asia/Tehran", weekly);
    }

    [Fact]
    public void Days_in_a_row_with_the_same_hours_are_one_line()
    {
        var hours = Week(("sat", "09:00", "17:00"), ("sun", "09:00", "17:00"), ("mon", "09:00", "17:00"), ("tue", "09:00", "17:00"),
            ("wed", "09:00", "17:00"), ("thu", "09:00", "13:00"));
        var fa = new Strings(Language.Fa);
        Assert.Equal(["شنبه تا چهارشنبه ۹:۰۰ تا ۱۷:۰۰", "پنجشنبه ۹:۰۰ تا ۱۳:۰۰", "جمعه تعطیل"], SupportHoursText.Lines(hours, fa));
        var en = new Strings(Language.En);
        Assert.Equal(["Saturday–Wednesday: 9:00–17:00", "Thursday: 9:00–13:00", "Friday: closed"], SupportHoursText.Lines(hours, en));
    }

    [Fact]
    public void Split_days_list_each_opening_in_order()
    {
        var hours = Week(("sat", "14:00", "18:00"), ("sat", "08:30", "12:00"));
        var lines = SupportHoursText.Lines(hours, new Strings(Language.En));
        Assert.Equal("Saturday: 8:30–12:00, 14:00–18:00", lines[0]);
        Assert.Equal("Sunday–Friday: closed", lines[1]);
    }

    [Fact]
    public void A_week_with_no_opening_says_nothing()
    {
        Assert.Empty(SupportHoursText.Lines(new SupportHours("Asia/Tehran", null), new Strings(Language.En)));
        Assert.Empty(SupportHoursText.Groups(Week(("sat", "", "17:00"))));
    }

    [Fact]
    public void The_teams_clock_is_named_only_when_it_differs()
    {
        Assert.False(SupportHoursText.ZoneDiffers(null));
        Assert.False(SupportHoursText.ZoneDiffers("UTC", TimeZoneInfo.Utc));
        Assert.True(SupportHoursText.ZoneDiffers("Asia/Tehran", TimeZoneInfo.Utc));
        Assert.True(SupportHoursText.ZoneDiffers("Mars/Olympus", TimeZoneInfo.Utc));
        Assert.Equal("Mars/Olympus", SupportHoursText.ZoneName("Mars/Olympus"));
    }
}

public class SupportTimelineTests
{
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;
    private static readonly DateTimeOffset Day1 = new(2026, 9, 29, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Runs_day_headers_joins_and_the_end_with_its_rating()
    {
        var c = new SupportConversation("c1", "resolved", Day1, Day1.AddDays(1), CanRate: true);
        SupportItem[] items =
        [
            new("1", "c1", Body: "hi", CreatedAt: Day1),
            new("2", "c1", Body: "anyone?", CreatedAt: Day1.AddMinutes(1)),
            new("3", "c1", SupportItem.KindJoined, SupportItem.AuthorTeam, SenderName: "Sara", CreatedAt: Day1.AddMinutes(2)),
            new("4", "c1", Author: SupportItem.AuthorTeam, Body: "Hello", SenderName: "Sara", CreatedAt: Day1.AddMinutes(3)),
            new("5", "c1", Author: SupportItem.AuthorTeam, Body: "Fixed", SenderName: "Sara", CreatedAt: Day1.AddDays(1)),
            new("6", "c1", Body: "", CreatedAt: Day1.AddDays(1)),
            new("x", "other", Body: "not here", CreatedAt: Day1),
        ];
        var rows = SupportTimeline.Build([c], items, [], Utc);
        Assert.Equal([SupportRowKind.Bubble, SupportRowKind.Bubble, SupportRowKind.Joined, SupportRowKind.Bubble, SupportRowKind.Bubble, SupportRowKind.Ended, SupportRowKind.Rating], rows.Select(r => r.Kind));
        Assert.NotNull(rows[0].DayHeader);
        Assert.Null(rows[1].DayHeader);
        Assert.True(rows[0].StartsRun);
        Assert.False(rows[0].EndsRun);
        Assert.True(rows[1].EndsRun);
        Assert.True(rows[3].StartsRun);
        Assert.True(rows[3].EndsRun); // the next day breaks the run
        Assert.NotNull(rows[4].DayHeader);
    }

    [Fact]
    public void Pending_messages_wait_under_their_conversation_or_a_new_one()
    {
        var ended = new SupportConversation("c1", "closed", Day1, Day1.AddHours(1));
        PendingSupportItem[] pending =
        [
            new("m1", "to new", Day1.AddDays(2)),
            new("m2", "delivered", Day1.AddDays(2)),
        ];
        SupportItem[] items = [new("i", "c1", Body: "old", CreatedAt: Day1), new("d", "c9", Body: "delivered", ClientMessageId: "m2")];
        var rows = SupportTimeline.Build([ended], items, pending, Utc);
        Assert.Equal(SupportRowKind.Ended, rows[1].Kind);
        Assert.Equal(SupportRowKind.NewConversation, rows[2].Kind);
        Assert.Equal("new-next", rows[2].Key);
        var waiting = Assert.Single(rows, r => r.Pending is not null);
        Assert.Equal("c-m1", waiting.Key);
        Assert.Null(waiting.DayHeader); // the "new conversation" line carries the date
    }

    [Fact]
    public void Server_copy_keeps_the_pending_key_and_repeated_keys_are_made_unique()
    {
        var c = new SupportConversation("c1", "open", Day1);
        SupportItem[] items = [new("i1", "c1", Body: "a", CreatedAt: Day1, ClientMessageId: "m1"), new("i1", "c1", Body: "a", CreatedAt: Day1)];
        SupportItem[] dupe = [items[0], items[0]];
        Assert.Equal("c-m1", SupportTimeline.Build([c], items, [], Utc)[0].Key);
        var rows = SupportTimeline.Build([c], dupe, [], Utc);
        Assert.Equal(2, rows.Select(r => r.Key).Distinct().Count());
    }

    [Fact]
    public void Each_later_conversation_opens_with_its_line()
    {
        SupportConversation[] cs = [new("a", "resolved", Day1, Day1), new("b", "open", Day1.AddDays(1))];
        SupportItem[] items = [new("1", "a", Body: "x", CreatedAt: Day1), new("2", "b", Body: "y", CreatedAt: Day1.AddDays(1))];
        var rows = SupportTimeline.Build(cs, items, [], Utc);
        var line = rows.Single(r => r.Kind == SupportRowKind.NewConversation);
        Assert.Equal("new-b", line.Key);
        Assert.Null(rows.Last().DayHeader);
    }
}

public class SupportChatTests
{
    private sealed class FakeSupport : ISupportApi
    {
        public SupportStatus Status = new(true, true, true, "Team", Unread: 0);
        public SupportHistory History = new([], [], null);
        public Func<string, string?, SupportPostResult>? OnSend;
        public Exception? SendError;
        public Exception? HistoryError;
        public Exception? RateError;
        public readonly List<(string Body, string ClientId, string? ConversationId)> Sent = [];
        public int Reads;
        public int Rates;
        public TaskCompletionSource? RateGate;

        public Task<SupportStatus> StatusAsync(CancellationToken ct = default) => Task.FromResult(Status);

        public Task<SupportHistory> HistoryAsync(CancellationToken ct = default) =>
            HistoryError is { } e ? Task.FromException<SupportHistory>(e) : Task.FromResult(History);

        public Task<SupportPostResult> SendMessageAsync(string body, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default)
        {
            Sent.Add((body, clientMessageId, conversationId));
            if (SendError is { } e) return Task.FromException<SupportPostResult>(e);
            return Task.FromResult(OnSend!(clientMessageId, conversationId));
        }

        public Task<SupportPostResult> SendAttachmentAsync(string fileName, string mimeType, byte[] data, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default)
        {
            Sent.Add((fileName, clientMessageId, conversationId));
            return Task.FromResult(OnSend!(clientMessageId, conversationId));
        }

        public async Task<SupportConversation> RateAsync(string conversationId, int score, string? comment, CancellationToken ct = default)
        {
            Rates++;
            if (RateGate is { } gate) await gate.Task;
            if (RateError is { } e) throw e;
            return new SupportConversation(conversationId, "resolved", Rating: new SupportRating(score, comment));
        }

        public Task MarkReadAsync(CancellationToken ct = default)
        {
            Reads++;
            return Task.CompletedTask;
        }
    }

    private static int _ids;

    private static SupportChat Make(FakeSupport api) =>
        new(api, () => new Strings(Language.En), () => new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero), () => "m" + Interlocked.Increment(ref _ids));

    private static SupportPostResult Landed(string clientId, string? conversationId, string body = "x") =>
        new(new SupportConversation(conversationId ?? "new", "open"), new SupportItem("i-" + clientId, conversationId ?? "new", Body: body, ClientMessageId: clientId));

    [Fact]
    public async Task Arriving_with_nothing_open_is_a_fresh_page_and_the_first_message_opens_a_conversation()
    {
        var api = new FakeSupport
        {
            History = new([new SupportConversation("old", "resolved", EndedAt: DateTimeOffset.Now)], [new SupportItem("1", "old", Body: "past")], null),
        };
        api.OnSend = (cid, conv) => Landed(cid, conv);
        var chat = Make(api);
        await chat.RefreshAsync();
        Assert.Equal(SupportPhase.Loaded, chat.Phase);
        Assert.Equal(SupportComposer.Fresh, chat.Composer);
        Assert.True(chat.IsEmpty);
        Assert.Single(chat.Closed);

        chat.SetDraft("  hello  ");
        Assert.True(await chat.SendAsync());
        Assert.Equal(("hello", null), (api.Sent[0].Body, api.Sent[0].ConversationId));
        Assert.Equal(string.Empty, chat.Draft);
    }

    [Fact]
    public async Task A_message_shows_at_once_then_becomes_the_servers()
    {
        var api = new FakeSupport { History = new([new SupportConversation("c1", "open")], [], "c1") };
        var chat = Make(api);
        await chat.RefreshAsync();
        api.OnSend = (cid, conv) => Landed(cid, conv, "hi");
        chat.SetDraft("hi");
        var sending = chat.SendAsync();
        await sending;
        Assert.Equal("c1", api.Sent[0].ConversationId);
        Assert.Empty(chat.Pending);
        Assert.Equal(SupportComposer.Active, chat.Composer);
    }

    [Fact]
    public async Task A_failed_send_stays_marked_and_a_retry_carries_the_same_id()
    {
        var api = new FakeSupport { History = new([new SupportConversation("c1", "open")], [], "c1"), SendError = new ApiException(ApiFailure.Transport) };
        var chat = Make(api);
        await chat.RefreshAsync();
        await chat.SendAsync("hello");
        var failed = Assert.Single(chat.Pending);
        Assert.True(failed.Failed);
        Assert.NotNull(chat.Notice);

        api.SendError = null;
        api.OnSend = (cid, conv) => Landed(cid, conv);
        await chat.RetryAsync(failed.ClientMessageId);
        Assert.Equal(api.Sent[0].ClientId, api.Sent[1].ClientId);
        Assert.Empty(chat.Pending);
    }

    [Fact]
    public async Task A_close_that_overtook_a_message_hands_it_back_and_shows_the_end()
    {
        var api = new FakeSupport { History = new([new SupportConversation("c1", "open")], [], "c1") };
        var chat = Make(api);
        await chat.RefreshAsync();
        api.SendError = new ApiException(ApiFailure.Server, 409, "conversation_ended");
        api.History = new([new SupportConversation("c1", "resolved", CanRate: true)], [], null);
        chat.SetDraft("one more thing");
        await chat.SendAsync();
        await chat.LoadHistoryAsync();
        Assert.Equal("one more thing", chat.Draft);
        Assert.Empty(chat.Pending);
        Assert.Equal(SupportComposer.Ended, chat.Composer);
        Assert.Equal("c1", chat.Shown!.Id);
        Assert.Equal(new Strings(Language.En)["supportConversationEnded"], chat.Notice);

        // Nothing is written to an ended conversation…
        Assert.False(await chat.SendAsync("again"));
        // …until a new one is started.
        chat.StartNewConversation();
        Assert.Equal(SupportComposer.Fresh, chat.Composer);
        Assert.Null(chat.Shown);
    }

    [Fact]
    public async Task A_conversation_ending_on_screen_stays_shown_until_a_new_one_is_started()
    {
        var api = new FakeSupport { History = new([new SupportConversation("c1", "open")], [new SupportItem("1", "c1", Body: "q")], "c1") };
        var chat = Make(api);
        await chat.RefreshAsync();
        api.History = new([new SupportConversation("c1", "resolved")], [new SupportItem("1", "c1", Body: "q")], null);
        await chat.LoadHistoryAsync();
        Assert.Equal(SupportComposer.Ended, chat.Composer);
        Assert.Contains(chat.Rows(TimeZoneInfo.Utc), r => r.Kind == SupportRowKind.Ended);
    }

    [Fact]
    public async Task A_failed_first_read_shows_the_failure_and_a_later_failure_keeps_the_chat()
    {
        var api = new FakeSupport { HistoryError = new ApiException(ApiFailure.Transport) };
        var chat = Make(api);
        await chat.LoadHistoryAsync();
        Assert.Equal(SupportPhase.Failed, chat.Phase);
        Assert.Equal(new Strings(Language.En)["offlineBody"], chat.FailedMessage);

        api.HistoryError = null;
        await chat.LoadHistoryAsync();
        Assert.Equal(SupportPhase.Loaded, chat.Phase);
        api.HistoryError = new ApiException(ApiFailure.Transport);
        await chat.LoadHistoryAsync();
        Assert.Equal(SupportPhase.Loaded, chat.Phase);
    }

    [Fact]
    public async Task Read_is_marked_only_on_screen_and_only_when_something_is_unread()
    {
        var api = new FakeSupport { Status = new SupportStatus(true, true, true, Unread: 2), History = new([new SupportConversation("c1", "open")], [], "c1") };
        var chat = Make(api);
        await chat.RefreshAsync();
        Assert.Equal(0, api.Reads);
        chat.Visible = true;
        Assert.Equal(1, api.Reads);
        Assert.Equal(0, chat.Status!.Unread);

        // Nothing new: no second mark.
        api.Status = api.Status with { Unread = 0 };
        await chat.RefreshAsync();
        Assert.Equal(1, api.Reads);

        // A reply arrives while on screen: read at once.
        api.History = new([new SupportConversation("c1", "open")], [new SupportItem("t1", "c1", Author: SupportItem.AuthorTeam, Body: "hi")], "c1");
        await chat.LoadHistoryAsync();
        Assert.Equal(2, api.Reads);
    }

    [Fact]
    public async Task Files_over_the_limit_or_of_another_type_never_leave()
    {
        var api = new FakeSupport { History = new([], [], null) };
        api.OnSend = (cid, conv) => Landed(cid, conv);
        var chat = Make(api);
        await chat.RefreshAsync();
        Assert.False(await chat.SendFileAsync(new byte[SupportRules.MaxFileBytes + 1], "big.png", "image/png"));
        Assert.Equal(new Strings(Language.En)["supportFileTooLarge"], chat.Notice);
        Assert.False(await chat.SendFileAsync([1], "a.mp3", null));
        Assert.Empty(api.Sent);
        Assert.True(await chat.SendFileAsync([1, 2], "a.png", "image/png"));
        Assert.Single(api.Sent);
    }

    [Fact]
    public async Task Too_long_a_message_is_refused_and_kept()
    {
        var chat = Make(new FakeSupport());
        await chat.RefreshAsync();
        chat.SetDraft(new string('x', SupportRules.MaxBody + 1));
        Assert.False(await chat.SendAsync());
        Assert.Equal(SupportRules.MaxBody + 1, chat.Draft.Length);
        Assert.NotNull(chat.Notice);
    }

    [Fact]
    public async Task A_conversation_is_rated_once()
    {
        var api = new FakeSupport { History = new([new SupportConversation("c1", "resolved", CanRate: true)], [], null), RateGate = new TaskCompletionSource() };
        var chat = Make(api);
        await chat.RefreshAsync();
        var first = chat.RateAsync("c1", 5, "  great  ");
        Assert.Contains("c1", chat.RatingBusy);
        await chat.RateAsync("c1", 4, null); // a second tap while the first is on its way
        api.RateGate.SetResult();
        await first;
        Assert.Equal(1, api.Rates);
        Assert.Equal(5, chat.Conversation("c1")!.Rating!.Score);
        Assert.Equal("great", chat.Conversation("c1")!.Rating!.Comment);
        Assert.Empty(chat.RatingBusy);
        await chat.RateAsync("c1", 3, null); // rated: CanRate is gone
        Assert.Equal(1, api.Rates);
        await chat.RateAsync("missing", 3, null);
        await chat.RateAsync("c1", 0, null);
        Assert.Equal(1, api.Rates);
    }

    [Fact]
    public async Task A_rating_the_server_calls_stale_reads_the_chat_again_quietly()
    {
        var api = new FakeSupport
        {
            History = new([new SupportConversation("c1", "resolved", CanRate: true)], [], null),
            RateError = new ApiException(ApiFailure.Server, 409, "already_rated"),
        };
        var chat = Make(api);
        await chat.RefreshAsync();
        api.History = new([new SupportConversation("c1", "resolved", Rating: new SupportRating(4))], [], null);
        await chat.RateAsync("c1", 5, null);
        await chat.LoadHistoryAsync();
        Assert.Null(chat.Notice);
        Assert.Equal(4, chat.Conversation("c1")!.Rating!.Score);
    }
}
