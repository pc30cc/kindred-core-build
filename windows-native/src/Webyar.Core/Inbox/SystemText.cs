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
                var actor = Person(meta, "actor_name");
                var to = Person(meta, "to_name");
                if (to.Length == 0) return s["sysTransferredGeneric"];
                return actor.Length > 0
                    ? s.Get("sysTransferred", new Dictionary<string, object> { ["actor"] = actor, ["to"] = to })
                    : s.Get("sysTransferredTo", "to", to);
            case "conversation_unassigned":
                var unassignedBy = Person(meta, "actor_name");
                return unassignedBy.Length > 0 ? s.Get("sysUnassigned", "actor", unassignedBy) : s["sysUnassignedGeneric"];
            case "routing_agent_joined":
                var agent = Person(meta, "agent_name");
                return agent.Length > 0 ? s.Get("sysAgentJoined", "name", agent) : s["sysAgentJoinedGeneric"];
            case "conversation_closed":
                // The visitor-visible line an operator's close writes.
                var closedBy = Person(meta, "agent_name");
                return closedBy.Length > 0 ? s.Get("sysClosedBy", "name", closedBy) : s["sysClosed"];
            case "routing_no_agent_available":
                return s["sysNoAgentAvailable"];
            case "routing_in_queue":
                // Everyone at capacity (auto routing), or the manual queue.
                return Str(meta, "reason") == "all_busy" ? s["sysInQueueAllBusy"] : s["sysInQueue"];
            case "platform_support_requester":
                // The "who is asking" card as one line.
                var asker = meta.TryGetProperty("user", out var user) && user.ValueKind == JsonValueKind.Object ? Person(user, "name") : string.Empty;
                return asker.Length > 0 ? $"{s["requesterTitle"]} · {asker}" : s["requesterTitle"];
            case "support_rating":
                // Without a whole score from 1 to 5 there is nothing to say; the stored body is better.
                if (!meta.TryGetProperty("score", out var sc) || sc.ValueKind != JsonValueKind.Number
                    || !sc.TryGetInt32(out var score) || score < 1 || score > 5) return null;
                var rated = s.Get("sysSupportRating", "score", score.ToString(CultureInfo.InvariantCulture));
                var comment = Str(meta, "comment");
                return comment.Length > 0
                    ? s.Get("sysSupportRatingComment", new Dictionary<string, object> { ["rating"] = rated, ["comment"] = comment })
                    : rated;
            case "call_invitation":
                var video = Str(meta, "channel") == "video";
                var op = Person(meta, "operator_name");
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

    /// <summary>English stand-ins once stored as a name (chatRouting's 'a colleague', the inbox PATCH's 'An operator').</summary>
    private static readonly HashSet<string> PlaceholderNames = new(StringComparer.OrdinalIgnoreCase) { "a colleague", "an operator" };

    /// <summary>A person's name, or empty for none: a stand-in reads as the generic sentence instead.</summary>
    private static string Person(JsonElement meta, string key)
    {
        var name = Str(meta, key);
        return PlaceholderNames.Contains(name) ? string.Empty : name;
    }
}
