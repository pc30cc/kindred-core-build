using System.Text.Json;

namespace Webyar.Core.Api;

public enum PlanState
{
    Loading,
    Loaded,
    Failed,
}

/// <summary>
/// What the workspace's plan lets this operator see — the same snapshot the
/// web console reads (/api/plans/workspace/:id/effective), where the super
/// admin switches features, modules and channels on and off per plan. The
/// rules copy the web sidebar and the iOS app: while it loads nothing gated
/// shows; if it cannot be fetched at all, nothing is hidden (as the web).
/// </summary>
public sealed class WorkspacePlan
{
    private readonly Dictionary<string, bool?> _features;
    private readonly Dictionary<string, bool?> _modules;
    private readonly Dictionary<string, bool?> _channels;

    private WorkspacePlan(PlanState state, Dictionary<string, bool?>? features = null, Dictionary<string, bool?>? modules = null, Dictionary<string, bool?>? channels = null)
    {
        State = state;
        _features = features ?? [];
        _modules = modules ?? [];
        _channels = channels ?? [];
    }

    public static WorkspacePlan Loading { get; } = new(PlanState.Loading);
    public static WorkspacePlan Failed { get; } = new(PlanState.Failed);

    public PlanState State { get; }
    public string? PlanName { get; private init; }

    /// <summary>owner, admin, agent… from /api/workspaces/:id/role.</summary>
    public string? Role { get; init; }

    /// <summary>/api/ai-agent/capabilities: the AI agent is on for this workspace.</summary>
    public bool? AiAgentEnabled { get; init; }

    /// <summary>/api/ai-agent/capabilities: the AI answers visitors by itself.</summary>
    public bool? AiAutoAnswer { get; init; }

    /// <summary>/api/call-center/capabilities: workspace_call_center_visible.</summary>
    public bool? CallCenterVisible { get; init; }

    public bool IsAdmin => Role is "owner" or "admin";

    public static WorkspacePlan Parse(JsonElement root)
    {
        return new WorkspacePlan(PlanState.Loaded, Flags(root, "features"), Flags(root, "modules"), Flags(root, "channels"))
        {
            PlanName = root.TryGetProperty("plan", out var p) && p.ValueKind == JsonValueKind.Object
                ? Str(p, "name") ?? Str(p, "slug") : null,
        };
    }

    public WorkspacePlan With(string? role, bool? aiAgent, bool? aiAuto, bool? callCenter) =>
        new(State, _features, _modules, _channels)
        {
            PlanName = PlanName,
            Role = role ?? Role,
            AiAgentEnabled = aiAgent ?? AiAgentEnabled,
            AiAutoAnswer = aiAuto ?? AiAutoAnswer,
            CallCenterVisible = callCenter ?? CallCenterVisible,
        };

    /// <summary>The web's moduleInPlan: hidden while loading; shown when the key is absent or on.</summary>
    public bool ModuleInPlan(string key) => State switch
    {
        PlanState.Failed => true,
        PlanState.Loaded => !_modules.TryGetValue(key, out var v) || v == true,
        _ => false,
    };

    /// <summary>A plan feature (widget_attachments, inbox_team_chat…): on only if the plan says so.</summary>
    public bool Feature(string key) => State switch
    {
        PlanState.Failed => true,
        PlanState.Loaded => !_features.TryGetValue(key, out var v) || v == true,
        _ => false,
    };

    /// <summary>The inbox's inboxCapAllowed: features[key] ?? modules[key], allowed unless false.</summary>
    public bool InboxCap(string key) => State switch
    {
        PlanState.Failed => true,
        PlanState.Loaded => (_features.TryGetValue(key, out var f) ? f : _modules.TryGetValue(key, out var m) ? m : null) != false,
        _ => false,
    };

    /// <summary>Calls, as the web's SidebarCallCard: voice_video not off, and the channel not off.</summary>
    private bool Call(string channel) => State switch
    {
        PlanState.Failed => true,
        PlanState.Loaded => (!_modules.TryGetValue("voice_video", out var vv) || vv != false)
            && (!_channels.TryGetValue(channel, out var c) || c != false),
        _ => false,
    };

    public bool VoiceCalls => Call("voice");
    public bool VideoCalls => Call("video");

    public bool Attachments => Feature("widget_attachments");
    public bool VoiceNotes => Feature("widget_voice_notes");
    public bool Emoji => Feature("widget_emoji");

    public bool Contacts => ModuleInPlan("contacts");
    public bool Visitors => ModuleInPlan("visitor_tracking");
    public bool CallCenter => ModuleInPlan("call_center") && CallCenterVisible != false;
    public bool TeamChat => InboxCap("inbox_team_chat");
    public bool NeedsHumanQueue => InboxCap("inbox_needs_human");

    /// <summary>The AI queue: the plan's AI surface, and the AI answering (or something already in it).</summary>
    public bool AiQueue(int? automated) =>
        InboxCap("inbox_ai_queue") && AiAgentEnabled != false && (AiAutoAnswer != false || automated > 0);

    private static Dictionary<string, bool?> Flags(JsonElement root, string name)
    {
        var map = new Dictionary<string, bool?>(StringComparer.Ordinal);
        if (!root.TryGetProperty(name, out var group) || group.ValueKind != JsonValueKind.Object) return map;
        foreach (var entry in group.EnumerateObject())
        {
            var v = entry.Value;
            if (v.ValueKind == JsonValueKind.Object) v = v.TryGetProperty("value", out var inner) ? inner : default;
            map[entry.Name] = v.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };
        }
        return map;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
