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
/// admin switches features, modules and channels on and off per plan, and by
/// the web's one rule (src/lib/planAccess.ts): a capability is available only
/// when the snapshot is in and says exactly true. While it loads — or when it
/// cannot be read and no copy is kept on the PC — nothing gated shows (the
/// server would refuse it anyway) and the shell asks again soon.
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

    /// <summary>/api/ai-agent/capabilities: Super Admin shows the AI agent to customers.</summary>
    public bool? AiCustomerVisible { get; init; }

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

    public WorkspacePlan With(string? role, bool? aiAgent, bool? aiAuto, bool? callCenter, bool? aiVisible = null) =>
        new(State, _features, _modules, _channels)
        {
            PlanName = PlanName,
            Role = role ?? Role,
            AiAgentEnabled = aiAgent ?? AiAgentEnabled,
            AiCustomerVisible = aiVisible ?? AiCustomerVisible,
            AiAutoAnswer = aiAuto ?? AiAutoAnswer,
            CallCenterVisible = callCenter ?? CallCenterVisible,
        };

    // ── Kept on the PC: the last plan the server sent, for an offline or instant launch ──

    private sealed record Snapshot(
        string? PlanName, string? Role, bool? AiAgentEnabled, bool? AiCustomerVisible, bool? AiAutoAnswer, bool? CallCenterVisible,
        Dictionary<string, bool?> Features, Dictionary<string, bool?> Modules, Dictionary<string, bool?> Channels);

    /// <summary>A loaded plan as JSON (flags and switches only: nothing personal, no limits or usage).</summary>
    public string? Serialize() => State != PlanState.Loaded ? null : JsonSerializer.Serialize(
        new Snapshot(PlanName, Role, AiAgentEnabled, AiCustomerVisible, AiAutoAnswer, CallCenterVisible, _features, _modules, _channels));

    /// <summary>The plan <see cref="Serialize"/> wrote, as Loaded; null for anything unreadable.</summary>
    public static WorkspacePlan? Restore(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            if (JsonSerializer.Deserialize<Snapshot>(json) is not { Features: not null, Modules: not null, Channels: not null } s) return null;
            return new WorkspacePlan(PlanState.Loaded, s.Features, s.Modules, s.Channels)
            {
                PlanName = s.PlanName,
                Role = s.Role,
                AiAgentEnabled = s.AiAgentEnabled,
                AiCustomerVisible = s.AiCustomerVisible,
                AiAutoAnswer = s.AiAutoAnswer,
                CallCenterVisible = s.CallCenterVisible,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A plan module (contacts, call_center…): on only if the loaded plan says exactly true.</summary>
    public bool ModuleInPlan(string key) => State == PlanState.Loaded && _modules.TryGetValue(key, out var v) && v == true;

    /// <summary>A plan feature (inbox_team_chat, call_recording…): on only if the loaded plan says exactly true.</summary>
    public bool Feature(string key) => State == PlanState.Loaded && _features.TryGetValue(key, out var v) && v == true;

    private bool Channel(string key) => State == PlanState.Loaded && _channels.TryGetValue(key, out var v) && v == true;

    /// <summary>Calls, as the web's SidebarCallCard: the Voice &amp; Video module and the call's channel.</summary>
    private bool Call(string channel) => ModuleInPlan("voice_video") && Channel(channel);

    public bool VoiceCalls => Call("voice");
    public bool VideoCalls => Call("video");

    public bool Contacts => ModuleInPlan("contacts");
    public bool Visitors => ModuleInPlan("visitor_tracking");
    public bool CallCenter => ModuleInPlan("call_center") && CallCenterVisible == true;
    public bool TeamChat => Feature("inbox_team_chat");
    public bool NeedsHumanQueue => Feature("inbox_needs_human");

    /// <summary>The mailbox, as the web sidebar shows it: owners and admins, when the plan has the Email Inbox module.</summary>
    public bool EmailInbox => IsAdmin && ModuleInPlan("email_inbox");

    /// <summary>Website analytics, as the web sidebar shows it: owners and admins, when the plan has the Web Analytics module.</summary>
    public bool WebAnalytics => IsAdmin && ModuleInPlan("web_analytics");

    /// <summary>Call recordings, where the plan keeps them (the web's Recordings tab).</summary>
    public bool CallRecordings => Feature("call_recording");

    /// <summary>Channel keys the plan itself governs; the others are decided by the plugin's own plan check.</summary>
    private static readonly HashSet<string> PlanChannels = new(StringComparer.Ordinal)
    {
        "chat_widget", "email", "whatsapp", "sms", "instagram", "telegram", "bale", "gmail", "yahoomail", "voice", "video",
    };

    /// <summary>
    /// A channel inbox (telegram, whatsapp, bale…), as the web's channelInboxVisible:
    /// a channel the plan governs must be on in the loaded plan; any other one is
    /// the plugin catalog's call (its planAllowed).
    /// </summary>
    public bool ChannelInPlan(string key)
    {
        var k = key.ToLowerInvariant();
        return !PlanChannels.Contains(k) || Channel(k);
    }

    /// <summary>
    /// The AI queue, as the web: the plan's AI queue (inboxCapAllowed), the AI
    /// surface switched on and shown to customers by Super Admin (fail-closed:
    /// capabilities that could not be read hide it), and the AI answering by
    /// itself or something already waiting in the queue.
    /// </summary>
    public bool AiQueue(int? automated) =>
        Feature("inbox_ai_queue") && AiAgentEnabled == true && AiCustomerVisible == true && (AiAutoAnswer == true || automated > 0);

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
