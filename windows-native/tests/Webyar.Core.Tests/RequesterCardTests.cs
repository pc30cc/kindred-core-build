using System.Text.Json;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

public class RequesterCardTests
{
    // The notice's metadata as server/services/platformSupport/requester.ts writes it.
    private const string Notice = """
    {
      "kind": "platform_support_requester",
      "internal": true,
      "user": {
        "id": "u1", "name": "Sara Ahmadi", "email": "sara@example.com", "phone": "+98 912 000 0000",
        "company": "Kala Co", "website": "kala.example", "member_since": "2025-03-01T10:00:00.000Z",
        "client_platform": "windows", "source_workspace": "Kala Shop"
      },
      "workspace_count": 3,
      "workspaces": [
        {
          "id": "w1", "name": "Kala Shop", "role": "owner", "status": "active", "created_at": null,
          "plan": {
            "name": "Pro", "names": { "fa": "حرفه‌ای", "en": "" }, "slug": "pro", "is_free": false,
            "status": "active", "period_end": "2026-11-01T00:00:00Z", "trial_end": null, "cancel_at_period_end": false
          },
          "operators": { "used": 4, "limit": 5 },
          "contacts": { "used": 1200, "limit": -1 },
          "usage": {
            "period": "2026-10",
            "conversations": { "used": 950, "limit": 1000 },
            "visitors": { "used": 30, "limit": null },
            "messages": 4200,
            "ai_credits": { "used": 0, "limit": 500 },
            "call_minutes": 75,
            "storage_bytes": 1610612736,
            "storage_limit_gb": 10
          }
        },
        { "id": "w2", "name": "Side project", "role": "agent", "plan": null,
          "operators": { "used": 1, "limit": null }, "contacts": { "used": 0, "limit": null }, "usage": {} }
      ],
      "captured_at": "2026-10-02T08:30:00.000Z"
    }
    """;

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void Reads_the_person_and_each_workspace()
    {
        var card = RequesterCard.Parse(Json(Notice));
        Assert.NotNull(card);
        Assert.Equal("Sara Ahmadi", card!.Name);
        Assert.Equal("sara@example.com", card.Email);
        Assert.Equal("+98 912 000 0000", card.Phone);
        Assert.Equal("Kala Co", card.Company);
        Assert.Equal("kala.example", card.Website);
        Assert.Equal("windows", card.ClientPlatform);
        Assert.Equal("Kala Shop", card.SourceWorkspace);
        Assert.Equal(new DateTimeOffset(2025, 3, 1, 10, 0, 0, TimeSpan.Zero), card.MemberSince);
        Assert.Equal(3, card.WorkspaceCount);
        Assert.Equal(2, card.Workspaces.Count);

        var ws = card.Workspaces[0];
        Assert.Equal("Kala Shop", ws.Name);
        Assert.Equal("owner", ws.Role);
        Assert.True(ws.HasPlan);
        Assert.Equal("active", ws.PlanStatus);
        Assert.Equal(new Metered(4, 5), ws.Operators);
        Assert.Equal(new Metered(1200, -1), ws.Contacts);
        Assert.Equal(new Metered(950, 1000), ws.Conversations);
        Assert.Equal(new Metered(30, null), ws.Visitors);
        Assert.Equal(4200, ws.Messages);
        Assert.Equal(75, ws.CallMinutes);
        Assert.Equal(1610612736, ws.StorageBytes);
        Assert.Equal(10, ws.StorageLimitGb);

        var other = card.Workspaces[1];
        Assert.False(other.HasPlan);
        Assert.Equal(new Metered(0, null), other.Conversations);
        Assert.Equal(0, other.Messages);
        Assert.Null(other.StorageLimitGb);
    }

    [Fact]
    public void Any_other_notice_is_not_a_card()
    {
        Assert.Null(RequesterCard.Parse(Json("""{ "kind": "routing_agent_joined", "agent_name": "Ali" }""")));
        Assert.Null(RequesterCard.Parse(Json("[]")));
        Assert.Null(RequesterCard.Parse(null));
    }

    [Fact]
    public void A_bare_notice_still_draws()
    {
        var card = RequesterCard.Parse(Json("""{ "kind": "platform_support_requester" }"""));
        Assert.NotNull(card);
        Assert.Null(card!.Name);
        Assert.Null(card.ClientPlatform);
        Assert.Empty(card.Workspaces);
        Assert.Equal(0, card.WorkspaceCount);
    }

    [Fact]
    public void Plan_names_follow_the_reader_and_fall_back_to_the_name()
    {
        var ws = RequesterCard.Parse(Json(Notice))!.Workspaces[0];
        Assert.Equal("حرفه‌ای", ws.PlanLabel(new Strings(Language.Fa)));
        Assert.Equal("Pro", ws.PlanLabel(new Strings(Language.En)));
        Assert.Equal("Pro", ws.PlanLabel(new Strings(Language.Tr)));
        Assert.Equal("بدون پلن", RequesterCard.Parse(Json(Notice))!.Workspaces[1].PlanLabel(new Strings(Language.Fa)));
    }

    [Fact]
    public void Amounts_read_against_their_limits()
    {
        Assert.Equal("950 / 1,000", new Metered(950, 1000).Text(Language.En));
        Assert.Equal("1,200 / ∞", new Metered(1200, -1).Text(Language.En));
        Assert.Equal("30", new Metered(30, null).Text(Language.En));
        Assert.Equal("۹۵۰ / ۱٬۰۰۰", new Metered(950, 1000).Text(Language.Fa));
        Assert.Equal(0.95, new Metered(950, 1000).Share);
        Assert.Null(new Metered(1200, -1).Share);
        Assert.Null(new Metered(30, null).Share);
        Assert.Equal(1, new Metered(1200, 1000).Share);
    }

    [Fact]
    public void Storage_reads_in_its_unit_against_the_plan()
    {
        var ws = RequesterCard.Parse(Json(Notice))!.Workspaces[0];
        Assert.Equal("1.5 GB / 10 GB", RequesterText.Storage(ws, Language.En));
        Assert.Equal("0 B", RequesterText.Bytes(0, Language.En));
    }

    [Fact]
    public void Roles_statuses_and_renewal_are_in_the_readers_language()
    {
        var fa = new Strings(Language.Fa);
        Assert.Equal("مالک", RequesterText.Role("owner", fa));
        Assert.Equal("member", RequesterText.Role("member", fa));
        Assert.Equal("فعال", RequesterText.PlanStatus("active", fa));
        var ws = RequesterCard.Parse(Json(Notice))!.Workspaces[0];
        Assert.StartsWith("Renews ", RequesterText.Renewal(ws, new Strings(Language.En)));
        Assert.StartsWith("Ends ", RequesterText.Renewal(ws with { CancelAtPeriodEnd = true }, new Strings(Language.En)));
        Assert.StartsWith("Trial ends ", RequesterText.Renewal(ws with { PlanStatus = "trialing", TrialEnd = DateTimeOffset.UtcNow }, new Strings(Language.En)));
        Assert.Null(RequesterText.Renewal(ws with { PeriodEnd = null }, new Strings(Language.En)));
    }

    [Theory]
    [InlineData("windows", "کاربر ویندوز", "Windows user")]
    [InlineData("android", "کاربر اندروید", "Android user")]
    [InlineData("ios", "کاربر آیفون", "iPhone user")]
    [InlineData("macos", "کاربر مک", "Mac user")]
    [InlineData("web", "کاربر وب", "Web user")]
    [InlineData(null, "کاربر سایت", "Site user")]
    public void Support_conversations_name_the_app_they_came_from(string? platform, string fa, string en)
    {
        Assert.Equal(fa, ClientPlatforms.UserLabel(platform, new Strings(Language.Fa)));
        Assert.Equal(en, ClientPlatforms.UserLabel(platform, new Strings(Language.En)));
    }

    [Fact]
    public void Only_a_support_conversation_carries_a_platform()
    {
        var support = new Conversation("c1", "w", "open", Metadata: Json("""{ "channel": "platform_support", "client_platform": "Android" }"""));
        Assert.Equal("platform_support", support.ChannelKey);
        Assert.Equal("android", ClientPlatforms.Of(support));

        var unknown = new Conversation("c2", "w", "open", Metadata: Json("""{ "channel": "platform_support", "client_platform": "fridge" }"""));
        Assert.Null(ClientPlatforms.Of(unknown));

        var widget = new Conversation("c3", "w", "open", Metadata: Json("""{ "client_platform": "windows" }"""));
        Assert.Equal("widget", widget.ChannelKey);
        Assert.Null(ClientPlatforms.Of(widget));
    }
}
