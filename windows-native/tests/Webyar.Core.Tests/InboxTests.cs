using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

public class InboxTests
{
    private static readonly Strings Fa = new(Language.Fa);
    private static readonly Strings En = new(Language.En);

    private static Conversation Conv(string id, DateTimeOffset at, string sender = SenderTypes.Contact, int unread = 1, string? assigned = null) =>
        new(id, "w1", "open", AssignedTo: assigned, LastMessage: new MessagePreview("hi", at, sender), UnreadCount: unread);

    [Fact]
    public void Nothing_is_new_on_the_first_look_then_only_new_visitor_messages()
    {
        var t0 = DateTimeOffset.UtcNow;
        var rules = new NotificationRules();
        Assert.Empty(rules.Fresh([Conv("a", t0), Conv("b", t0)]));

        var fresh = rules.Fresh([
            Conv("a", t0.AddSeconds(5)),                              // visitor wrote again
            Conv("b", t0.AddSeconds(5), SenderTypes.Agent),           // our own reply
            Conv("c", t0.AddSeconds(5)),                              // a brand new conversation
            Conv("d", t0.AddSeconds(5), unread: 0),                   // already read elsewhere
        ]);
        Assert.Equal(["a", "c"], fresh.Select(c => c.Id));
        Assert.Empty(rules.Fresh([Conv("a", t0.AddSeconds(5))]));
    }

    [Fact]
    public void Preferences_gate_notifications()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.True(NotificationRules.Allowed(new NotificationPrefs(), now));
        Assert.False(NotificationRules.Allowed(new NotificationPrefs(DisableAll: true), now));
        Assert.False(NotificationRules.Allowed(new NotificationPrefs(PushScope: "none"), now));

        var mine = Conv("x", now, assigned: "me");
        var theirs = Conv("y", now, assigned: "someone");
        var assignedOnly = new NotificationPrefs(PushScope: "assigned");
        Assert.True(NotificationRules.InScope(assignedOnly, mine, "me"));
        Assert.False(NotificationRules.InScope(assignedOnly, theirs, "me"));
    }

    [Fact]
    public void Quiet_hours_wrap_past_midnight()
    {
        var p = new NotificationPrefs(QuietHoursEnabled: true, QuietHoursStart: "22:00", QuietHoursEnd: "07:00", QuietHoursTimezone: "UTC");
        Assert.True(NotificationRules.InQuietHours(p, new DateTimeOffset(2026, 9, 23, 23, 30, 0, TimeSpan.Zero)));
        Assert.True(NotificationRules.InQuietHours(p, new DateTimeOffset(2026, 9, 23, 6, 59, 0, TimeSpan.Zero)));
        Assert.False(NotificationRules.InQuietHours(p, new DateTimeOffset(2026, 9, 23, 12, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void Names_and_previews()
    {
        Assert.Equal("تستم", Display.ContactName(new ConversationContact("تستم"), Fa));
        Assert.StartsWith(Fa["unknownVisitor"], Display.ContactName(new ConversationContact(VisitorCode: "4ZTK"), Fa));
        Assert.Equal("مد", Display.Initials("مجتبی داودی"));
        Assert.Equal("V4", Display.Initials("Visitor 4ZTK"));

        Assert.Equal("You sent a photo", Display.Preview(new MessagePreview("", SenderType: SenderTypes.Agent, AttachmentKind: "image"), En));
        Assert.Equal("Sara sent a photo", Display.Preview(new MessagePreview(null, SenderType: SenderTypes.Contact, SenderName: "Sara", AttachmentKind: "image"), En));
        Assert.Equal("a b", Display.Preview(new MessagePreview("a\n b"), En));
    }

    [Fact]
    public void List_stamps_use_the_persian_calendar_and_digits()
    {
        var utc = TimeZoneInfo.Utc;
        var now = new DateTimeOffset(2026, 9, 23, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("۰۹:۰۵", Display.ListStamp(now.AddHours(-2).AddMinutes(-55), now, Fa, utc));
        Assert.Equal(Fa["yesterday"], Display.ListStamp(now.AddDays(-1), now, Fa, utc));
        // 2026-08-01 is 1405/05/10 in the Solar Hijri calendar.
        Assert.Equal("۱۴۰۵/۰۵/۱۰", Display.ListStamp(new DateTimeOffset(2026, 8, 1, 10, 0, 0, TimeSpan.Zero), now, Fa, utc));
        Assert.Equal("09:05", Display.ListStamp(now.AddHours(-2).AddMinutes(-55), now, En, utc));
    }

    [Fact]
    public void Errors_read_like_the_other_clients()
    {
        Assert.Equal(Fa["offlineBody"], ErrorText.For(new ApiException(ApiFailure.Transport), Fa));
        Assert.Equal(Fa["errorNotFound"], ErrorText.For(new ApiException(ApiFailure.Server, 404, "nope"), Fa));
        Assert.Equal("nope", ErrorText.For(new ApiException(ApiFailure.Server, 404, "nope"), En));
        Assert.Equal(Fa["errorNotAllowed"], ErrorText.For(new ApiException(ApiFailure.Server, 403), Fa));
    }
}

public class SystemTextTests
{
    private static System.Text.Json.JsonElement Meta(string json) => System.Text.Json.JsonDocument.Parse(json).RootElement;

    [Fact]
    public void RebuildsNoticesInTheOperatorsLanguage()
    {
        var en = new Webyar.Core.Localization.Strings(Webyar.Core.Localization.Language.En);
        Assert.Equal("Sara joined the conversation", Webyar.Core.Inbox.SystemText.For(Meta("""{"kind":"routing_agent_joined","agent_name":"Sara"}"""), en));
        Assert.Null(Webyar.Core.Inbox.SystemText.For(Meta("""{"kind":"something_new"}"""), en));
        Assert.Null(Webyar.Core.Inbox.SystemText.For(null, en));
        Assert.Contains("01:05", Webyar.Core.Inbox.SystemText.For(Meta("""{"kind":"call_ended","duration_seconds":65,"ended_by":"visitor"}"""), en));
        Assert.Equal(en["callEndedNotConnected"], Webyar.Core.Inbox.SystemText.For(Meta("""{"kind":"call_ended","duration_seconds":"0"}"""), en));
    }

    [Fact]
    public void DurationUsesPersianDigits()
    {
        Assert.Equal("۰۱:۰۲:۰۹", Webyar.Core.Inbox.SystemText.Duration(3729, Webyar.Core.Localization.Language.Fa));
    }
}
