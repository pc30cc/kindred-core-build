using System.Net;
using System.Text.Json;
using Webyar.Core.Api;
using Webyar.Core.Local;
using Xunit;

namespace Webyar.Core.Tests;

/// <summary>
/// The Windows app shows exactly what Super Admin's plan (and the operator's
/// role) allows, by the same rules as the web console: AppSidebar's
/// moduleInPlan/channelInPlan, InboxPage's inboxCapAllowed, the AI queue's
/// capability check, SidebarCallCard, and the plugin catalog's planAllowed.
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
            Effective(modules: new() { ["contacts"] = false, ["visitor_tracking"] = true, ["call_center"] = true, ["email_inbox"] = true, ["voice_video"] = true },
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
        Assert.True(plan.VoiceCalls);
        Assert.False(plan.VideoCalls); // channel off
        Assert.True(plan.AiQueue(0));
    }

    [Fact]
    public async Task Owner_only_sections_stay_hidden_from_agents_whatever_the_plan()
    {
        var api = Api(Effective(modules: new() { ["email_inbox"] = true }), "agent",
            """{"capabilities":{"ai_agent_enabled":true,"customer_ai_agent_visible":true}}""", """{"workspace_call_center_visible":false}""");
        var plan = await api.PlanAsync("w1");
        Assert.False(plan.IsAdmin);
        Assert.False(plan.EmailInbox);
        Assert.False(plan.CallCenter); // the workspace switched it off for operators
    }

    [Fact]
    public void Voice_and_video_calls_need_the_module_and_their_channel()
    {
        Assert.False(Loaded(Effective(modules: new() { ["voice_video"] = false }, channels: new() { ["voice"] = true })).VoiceCalls);
        Assert.True(Loaded(Effective(modules: new() { ["voice_video"] = true }, channels: new() { ["voice"] = true })).VoiceCalls);
    }

    [Fact]
    public void Composer_tools_follow_the_widget_features()
    {
        var plan = Loaded(Effective(features: new() { ["widget_attachments"] = true, ["widget_voice_notes"] = false, ["widget_emoji"] = true, ["call_recording"] = false }));
        Assert.True(plan.Attachments);
        Assert.False(plan.VoiceNotes);
        Assert.True(plan.Emoji);
        Assert.False(plan.CallRecordings);
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
        var parsed = WorkspacePlan.Parse(JsonDocument.Parse(Effective()).RootElement);
        Assert.False(parsed.With("owner", aiAgent: true, aiAuto: true, callCenter: null, aiVisible: false).AiQueue(3)); // not shown to customers
        Assert.False(parsed.With("owner", aiAgent: false, aiAuto: true, callCenter: null, aiVisible: true).AiQueue(3)); // switched off
        Assert.False(parsed.With("owner", aiAgent: null, aiAuto: null, callCenter: null).AiQueue(3)); // capabilities unreadable: fail closed
        // Not answering by itself: shown only while something is already in the queue.
        var manual = parsed.With("owner", aiAgent: true, aiAuto: false, callCenter: null, aiVisible: true);
        Assert.False(manual.AiQueue(0));
        Assert.True(manual.AiQueue(2));
    }

    [Fact]
    public void Channels_are_shown_unless_the_plan_turns_them_off()
    {
        var plan = Loaded(Effective(channels: new() { ["telegram"] = true, ["whatsapp"] = false }));
        Assert.True(plan.ChannelInPlan("telegram"));
        Assert.False(plan.ChannelInPlan("WhatsApp"));
        Assert.True(plan.ChannelInPlan("x")); // not a plan channel: the plugin's own plan check decides
    }

    [Fact]
    public void While_loading_nothing_gated_shows_and_an_unreachable_plan_hides_nothing()
    {
        var loading = WorkspacePlan.Loading;
        Assert.False(loading.Contacts || loading.Visitors || loading.EmailInbox || loading.Attachments || loading.ChannelInPlan("telegram"));
        var failed = WorkspacePlan.Failed.With("owner", null, null, null);
        Assert.True(failed.Contacts && failed.Visitors && failed.EmailInbox && failed.Attachments && failed.ChannelInPlan("telegram"));
    }

    [Fact]
    public void The_plan_kept_on_the_pc_restores_exactly()
    {
        var plan = Loaded(Effective(modules: new() { ["contacts"] = false, ["email_inbox"] = true }, features: new() { ["widget_emoji"] = false }, channels: new() { ["video"] = false }), role: "admin");
        var restored = WorkspacePlan.Restore(plan.Serialize())!;
        Assert.Equal(PlanState.Loaded, restored.State);
        Assert.Equal("admin", restored.Role);
        Assert.Equal(plan.Contacts, restored.Contacts);
        Assert.Equal(plan.EmailInbox, restored.EmailInbox);
        Assert.Equal(plan.Emoji, restored.Emoji);
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
