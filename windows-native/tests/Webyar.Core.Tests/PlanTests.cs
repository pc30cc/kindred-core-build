using System.Net;
using System.Text.Json;
using Webyar.Core.Api;
using Webyar.Core.Local;
using Xunit;

namespace Webyar.Core.Tests;

/// <summary>
/// The Windows app shows exactly what Super Admin's plan (and the operator's
/// role) allows, by the web console's one rule (src/lib/planAccess.ts): a
/// capability is on only when the loaded snapshot says exactly true; nothing
/// gated shows while it loads or when it cannot be read; channel inboxes the
/// plan does not govern are the plugin catalog's call (planAllowed).
/// </summary>
public class PlanTests
{
    /// <summary>A /api/plans/workspace/:id/effective answer, values wrapped as the server sends them.</summary>
    private static string Effective(
        Dictionary<string, bool>? modules = null, Dictionary<string, bool>? features = null, Dictionary<string, bool>? channels = null)
    {
        static Dictionary<string, object> Wrap(Dictionary<string, bool>? flags) =>
            (flags ?? []).ToDictionary(kv => kv.Key, kv => (object)new { value = kv.Value, source = "plan" });
        return JsonSerializer.Serialize(new
        {
            workspaceId = "w1",
            plan = new { slug = "pro", name = "Pro" },
            features = Wrap(features),
            modules = Wrap(modules),
            channels = Wrap(channels),
            limits = new Dictionary<string, object> { ["max_agents"] = new { value = 5, source = "plan", unit = "count" } },
        });
    }

    private static WorkspacePlan Loaded(string effective, string? role = "owner") =>
        WorkspacePlan.Parse(JsonDocument.Parse(effective).RootElement).With(role, aiAgent: true, aiAuto: true, callCenter: true, aiVisible: true);

    private static WebyarApi Api(string effective, string role, string aiCaps, string callCaps) =>
        new(new ApiClient(new MemorySessionStore("t"), handler: new FakeHttp((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/plans/workspace/w1/effective" => (HttpStatusCode.OK, effective),
            "/api/workspaces/w1/role" => (HttpStatusCode.OK, $$"""{"role":"{{role}}"}"""),
            "/api/ai-agent/capabilities" => (HttpStatusCode.OK, aiCaps),
            "/api/call-center/capabilities" => (HttpStatusCode.OK, callCaps),
            _ => (HttpStatusCode.NotFound, "{}"),
        })));

    [Fact]
    public async Task Sections_follow_the_plan_modules_exactly()
    {
        var api = Api(
            Effective(modules: new() { ["contacts"] = false, ["visitor_tracking"] = true, ["call_center"] = true, ["email_inbox"] = true, ["voice_video"] = true, ["web_analytics"] = true },
                      features: new() { ["inbox_ai_queue"] = true },
                      channels: new() { ["voice"] = true, ["video"] = false }),
            "owner",
            """{"capabilities":{"ai_agent_enabled":true,"customer_ai_agent_visible":true,"auto_answer_enabled":true}}""",
            """{"workspace_call_center_visible":true}""");
        var plan = await api.PlanAsync("w1");
        Assert.Equal(PlanState.Loaded, plan.State);
        Assert.False(plan.Contacts);
        Assert.True(plan.Visitors);
        Assert.True(plan.CallCenter);
        Assert.True(plan.EmailInbox);
        Assert.True(plan.WebAnalytics);
        Assert.True(plan.VoiceCalls);
        Assert.False(plan.VideoCalls); // channel off
        Assert.True(plan.AiQueue(0));
    }

    [Fact]
    public async Task Owner_only_sections_stay_hidden_from_agents_whatever_the_plan()
    {
        var api = Api(Effective(modules: new() { ["email_inbox"] = true, ["web_analytics"] = true }), "agent",
            """{"capabilities":{"ai_agent_enabled":true,"customer_ai_agent_visible":true}}""", """{"workspace_call_center_visible":false}""");
        var plan = await api.PlanAsync("w1");
        Assert.False(plan.IsAdmin);
        Assert.False(plan.EmailInbox);
        Assert.False(plan.WebAnalytics);
        Assert.False(plan.CallCenter); // the workspace switched it off for operators
    }

    [Fact]
    public void Voice_and_video_calls_need_the_module_and_their_channel()
    {
        Assert.False(Loaded(Effective(modules: new() { ["voice_video"] = false }, channels: new() { ["voice"] = true })).VoiceCalls);
        Assert.True(Loaded(Effective(modules: new() { ["voice_video"] = true }, channels: new() { ["voice"] = true })).VoiceCalls);
    }

    [Fact]
    public void Call_recordings_follow_the_plan_feature()
    {
        Assert.False(Loaded(Effective(features: new() { ["call_recording"] = false })).CallRecordings);
        Assert.True(Loaded(Effective(features: new() { ["call_recording"] = true })).CallRecordings);
    }

    [Fact]
    public void A_key_the_snapshot_does_not_carry_is_not_available()
    {
        // The server sends every registry key (registry default applied), so a
        // missing one is a key it does not know — and it would refuse it.
        var plan = Loaded(Effective());
        Assert.False(plan.Contacts || plan.Visitors || plan.TeamChat || plan.NeedsHumanQueue || plan.VoiceCalls || plan.CallRecordings);
        Assert.False(plan.ChannelInPlan("telegram"));
    }

    [Fact]
    public void Inbox_queues_follow_the_inbox_features()
    {
        var plan = Loaded(Effective(features: new() { ["inbox_ai_queue"] = false, ["inbox_needs_human"] = false, ["inbox_team_chat"] = true }));
        Assert.False(plan.AiQueue(5));
        Assert.False(plan.NeedsHumanQueue);
        Assert.True(plan.TeamChat);
    }

    [Fact]
    public void The_ai_queue_is_hidden_when_super_admin_hides_the_ai_or_its_state_is_unknown()
    {
        var parsed = WorkspacePlan.Parse(JsonDocument.Parse(Effective(features: new() { ["inbox_ai_queue"] = true })).RootElement);
        Assert.False(parsed.With("owner", aiAgent: true, aiAuto: true, callCenter: null, aiVisible: false).AiQueue(3)); // not shown to customers
        Assert.False(parsed.With("owner", aiAgent: false, aiAuto: true, callCenter: null, aiVisible: true).AiQueue(3)); // switched off
        Assert.False(parsed.With("owner", aiAgent: null, aiAuto: null, callCenter: null).AiQueue(3)); // capabilities unreadable: fail closed
        // Not answering by itself: shown only while something is already in the queue.
        var manual = parsed.With("owner", aiAgent: true, aiAuto: false, callCenter: null, aiVisible: true);
        Assert.False(manual.AiQueue(0));
        Assert.True(manual.AiQueue(2));
    }

    [Fact]
    public void Channel_inboxes_the_plan_governs_need_it_on()
    {
        var plan = Loaded(Effective(channels: new() { ["telegram"] = true, ["whatsapp"] = false }));
        Assert.True(plan.ChannelInPlan("telegram"));
        Assert.False(plan.ChannelInPlan("WhatsApp"));
        Assert.False(plan.ChannelInPlan("bale")); // a plan channel the snapshot does not turn on
        Assert.True(plan.ChannelInPlan("x")); // not a plan channel: the plugin's own plan check decides
    }

    [Fact]
    public void Nothing_gated_shows_while_loading_or_when_the_plan_cannot_be_read()
    {
        foreach (var plan in new[] { WorkspacePlan.Loading, WorkspacePlan.Failed.With("owner", true, true, true, true) })
        {
            Assert.False(plan.Contacts || plan.Visitors || plan.EmailInbox || plan.WebAnalytics || plan.CallCenter || plan.TeamChat || plan.NeedsHumanQueue);
            Assert.False(plan.VoiceCalls || plan.CallRecordings || plan.AiQueue(5) || plan.ChannelInPlan("telegram"));
            Assert.True(plan.ChannelInPlan("x"));
        }
    }

    [Fact]
    public void The_plan_kept_on_the_pc_restores_exactly()
    {
        var plan = Loaded(Effective(modules: new() { ["contacts"] = false, ["email_inbox"] = true }, features: new() { ["inbox_team_chat"] = false }, channels: new() { ["video"] = false }), role: "admin");
        var restored = WorkspacePlan.Restore(plan.Serialize())!;
        Assert.Equal(PlanState.Loaded, restored.State);
        Assert.Equal("admin", restored.Role);
        Assert.Equal(plan.Contacts, restored.Contacts);
        Assert.Equal(plan.EmailInbox, restored.EmailInbox);
        Assert.Equal(plan.TeamChat, restored.TeamChat);
        Assert.Equal(plan.VideoCalls, restored.VideoCalls);
        Assert.Equal(plan.AiQueue(0), restored.AiQueue(0));
        Assert.Null(WorkspacePlan.Loading.Serialize());
        Assert.Null(WorkspacePlan.Restore("{not json"));
    }

    [Fact]
    public async Task The_plan_is_kept_per_workspace_and_leaves_with_the_workspace()
    {
        using var dir = new TempDir();
        await using var store = await LocalStore.OpenAsync(dir.Path, "u1");
        var json = Loaded(Effective(modules: new() { ["contacts"] = false })).Serialize()!;
        await store.SavePlanAsync("w1", json);
        Assert.Equal(json, await store.LoadPlanAsync("w1"));
        Assert.Null(await store.LoadPlanAsync("w2"));
        await store.DeleteWorkspaceAsync("w1");
        Assert.Null(await store.LoadPlanAsync("w1"));
    }

    [Fact]
    public async Task Channel_inboxes_are_the_installed_ones_the_plan_allows()
    {
        const string catalog = """
            {"items":[
              {"id":"telegram","slug":"telegram","installed":true,"supportsInbox":true,"planAllowed":true},
              {"id":"whatsapp","slug":"whatsapp","installed":true,"supportsInbox":true,"planAllowed":false},
              {"id":"bale","slug":"bale","installed":false,"supportsInbox":true,"planAllowed":true},
              {"id":"woocommerce","slug":"woocommerce","installed":true,"supportsInbox":false,"planAllowed":true},
              {"id":"x","slug":"x","installed":true,"supportsInbox":true}
            ]}
            """;
        var api = new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: new FakeHttp((_, _) => (HttpStatusCode.OK, catalog))));
        Assert.Equal(["telegram", "x"], await api.PluginInboxesAsync("w1"));
    }
}
