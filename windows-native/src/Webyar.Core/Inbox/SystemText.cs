using System.Globalization;
using System.Text.Json;
using Webyar.Core.Localization;

namespace Webyar.Core.Inbox;

/// <summary>
/// A system notice rebuilt in the operator's language from its metadata, since
/// the stored body is an English sentence frozen when it was written —
/// windows/src/renderer/src/lib/format.ts `systemText`, case for case.
/// </summary>
public static class SystemText
{
    public static string? For(JsonElement? metadata, Strings s)
    {
        if (metadata is not { ValueKind: JsonValueKind.Object } meta) return null;
        var kind = Str(meta, "kind");
        switch (kind)
        {
            case "conversation_transferred":
                return s.Get("sysTransferred", new Dictionary<string, object> { ["actor"] = Str(meta, "actor_name"), ["to"] = Str(meta, "to_name") });
            case "conversation_unassigned":
                return s.Get("sysUnassigned", "actor", Str(meta, "actor_name"));
            case "routing_agent_joined":
                var agent = Str(meta, "agent_name");
                return agent.Length > 0 ? s.Get("sysAgentJoined", "name", agent) : s["sysAgentJoinedGeneric"];
            case "routing_no_agent_available":
                return s["sysNoAgentAvailable"];
            case "routing_in_queue":
                return s["sysInQueue"];
            case "call_invitation":
                var video = Str(meta, "channel") == "video";
                var op = Str(meta, "operator_name");
                var text = op.Length > 0
                    ? s.Get(video ? "sysCallInviteVideoFrom" : "sysCallInviteAudioFrom", "op", op)
                    : s[video ? "sysCallInviteVideo" : "sysCallInviteAudio"];
                return $"{text} · {InvitationStatus(Str(meta, "status") is { Length: > 0 } st ? st : "pending", s)}";
            case "call_ended":
                var seconds = meta.TryGetProperty("duration_seconds", out var d)
                    ? d.ValueKind switch
                    {
                        JsonValueKind.Number when d.TryGetDouble(out var n) => (int)n,
                        JsonValueKind.String when int.TryParse(d.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) => n,
                        _ => 0,
                    }
                    : 0;
                if (Str(meta, "end_reason") == "failed" || seconds <= 0) return s["callEndedNotConnected"];
                var by = Str(meta, "ended_by");
                var key = by == "operator" ? "callEndedByOperator" : by == "visitor" ? "callEndedByVisitor" : "callEndedBySystem";
                return s.Get(key, "duration", Duration(seconds, s.Language));
            default:
                return null;
        }
    }

    public static string InvitationStatus(string status, Strings s) => s[status switch
    {
        "joined" => "inviteStatusJoined",
        "expired" => "inviteStatusExpired",
        "cancelled" => "inviteStatusCancelled",
        "declined" => "inviteStatusDeclined",
        _ => "inviteStatusPending",
    }];

    /// <summary>"4:05", or "1:02:09" past an hour, with every field after the first two digits wide.</summary>
    public static string Duration(int seconds, Language language)
    {
        var t = Math.Max(0, seconds);
        int h = t / 3600, m = t % 3600 / 60, sec = t % 60;
        var text = h > 0 ? $"{h:00}:{m:00}:{sec:00}" : $"{m:00}:{sec:00}";
        return Digits.Localize(text, language);
    }

    private static string Str(JsonElement meta, string key) =>
        meta.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : string.Empty;
}
