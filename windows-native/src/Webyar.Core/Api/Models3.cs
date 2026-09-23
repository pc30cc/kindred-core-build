using System.Text.Json.Serialization;

namespace Webyar.Core.Api;

/// <summary>`GET /api/account/me` — the signed-in operator, with the photo the server already resolved to a URL.</summary>
public sealed record Account(string Id, string? Email = null, AccountProfile? Profile = null)
{
    public string? AvatarUrl => Profile?.AvatarUrl;
}

public sealed record AccountProfile(string? FullName = null, string? AvatarUrl = null);

/// <summary>
/// The operator's own availability (`/api/availability`), exactly as the web
/// console stores it: a manual switch, "available whenever I use the app" and
/// an optional weekly schedule.
/// </summary>
public sealed record AvailabilityPrefs(
    bool ForceOffline = false,
    bool AvailableWhenUsingApp = true,
    bool ScheduleEnabled = false,
    string? Timezone = null);

public sealed record AvailabilityStatus(string State, string? Reason = null)
{
    public bool IsOnline => State == "online";
}

public sealed record Availability(AvailabilityPrefs Prefs, AvailabilityStatus Status);

/// <summary>
/// One teammate in `GET /api/availability/team/:workspaceId`. `PresenceState`
/// is what the web shows on avatars: active, away, disconnected or offline.
/// </summary>
public sealed record TeamPresence(
    string UserId,
    string? State = null,
    string? PresenceState = null,
    string? CustomerAvailability = null,
    string? Manual = null,
    bool? Connected = null,
    string? Reason = null,
    DateTimeOffset? LastSeenAt = null,
    DateTimeOffset? LastActivityAt = null,
    string? FullName = null,
    string? Email = null,
    string? AvatarUrl = null)
{
    /// <summary>Older servers only send online/offline; online then means active.</summary>
    public string Effective => PresenceState ?? (State == "online" ? PresenceStates.Active : PresenceStates.Offline);
}

public static class PresenceStates
{
    public const string Active = "active";
    public const string Away = "away";
    public const string Disconnected = "disconnected";
    public const string Offline = "offline";
}
