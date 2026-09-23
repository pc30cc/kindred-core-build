using System.Text.Json;

namespace Webyar.Core.Api;

// ── Visitors (`/api/visitor-intel`), as the web Visitors page reads them ──

public sealed record VisitorGeoInfo(
    string? Country = null,
    string? CountryCode = null,
    string? Region = null,
    string? City = null,
    double? Latitude = null,
    double? Longitude = null,
    string? Source = null);

public sealed record VisitorContact(string Id, string? Name = null, string? Email = null, string? AvatarUrl = null, string? VisitorCode = null, JsonElement? Metadata = null)
{
    /// <summary>The short code the widget gave this visitor, as the web resolves it.</summary>
    public string? Code =>
        VisitorCode is { Length: > 0 } c ? c.Trim()
        : Metadata is { ValueKind: JsonValueKind.Object } m && m.TryGetProperty("anon_code", out var a) && a.ValueKind == JsonValueKind.String && a.GetString() is { Length: > 0 } ac ? ac.Trim()
        : null;
}

public sealed record VisitorConversation(string Id, string? Status = null, string? Subject = null);

/// <summary>One live visitor session. `Id` is the session id, the key everywhere.</summary>
public sealed record LiveVisitor(
    string Id,
    string? VisitorId = null,
    string? WorkspaceId = null,
    string? Status = null,
    string? CurrentPage = null,
    DateTimeOffset? LastActivityAt = null,
    DateTimeOffset? StartedAt = null,
    string? Browser = null,
    string? Device = null,
    string? Os = null,
    string? Referrer = null,
    VisitorGeoInfo? Geo = null,
    string? IpDisplay = null,
    bool? IpLocked = null,
    VisitorContact? Contact = null,
    VisitorConversation? Conversation = null);

public sealed record PageView(long Id, string? Url = null, string? Title = null, DateTimeOffset? ViewedAt = null);

public sealed record PageEntry(string? LandingUrl = null, string? LandingTitle = null, DateTimeOffset? LandedAt = null, string? Referrer = null);

public sealed record PageHistory(IReadOnlyList<PageView>? Items = null, PageEntry? Entry = null, PageView? Current = null);

public sealed record StartChatResult(bool Ok, string? ConversationId = null, bool? Created = null);

/// <summary>A realtime nudge on `ws:&lt;workspace&gt;:visitors`.</summary>
public sealed record VisitorPatch(string? Status = null, string? CurrentPage = null, DateTimeOffset? LastActivityAt = null);

// ── Call center (`/api/call-center`) ──

public sealed record CallSession(
    string Id,
    string? WorkspaceId = null,
    string? State = null,
    string? CallType = null,
    string? VisitorName = null,
    string? VisitorEmail = null,
    string? VisitorPhone = null,
    string? Subject = null,
    string? PageUrl = null,
    string? PageTitle = null,
    DateTimeOffset? CreatedAt = null,
    DateTimeOffset? EndedAt = null,
    int? DurationSeconds = null,
    string? EndReason = null,
    string? VisitorSessionId = null,
    string? ContactId = null,
    string? AssignedAgentId = null,
    JsonElement? Metadata = null)
{
    public bool IsVideo => CallType == "video";
}

public sealed record QueueEntry(
    string Id,
    string CallSessionId,
    string? State = null,
    string? Channel = null,
    int? Priority = null,
    DateTimeOffset? CreatedAt = null,
    string? VisitorSessionId = null,
    string? ContactId = null,
    string? ConversationId = null,
    string? OfferedToUserId = null,
    string? AssignedAgentId = null,
    CallSession? CallSession = null)
{
    public bool IsVideo => Channel == "video" || CallSession?.IsVideo == true;
}

public sealed record CallProvider(string? Provider = null, bool? Ready = null, string? Error = null);

public sealed record CallCenterOverview(
    int? TodayCalls = null,
    int? WaitingCalls = null,
    int? ActiveCalls = null,
    int? MissedToday = null,
    int? CallbacksPending = null,
    CallProvider? Provider = null);

public sealed record AgentCallStatus(string UserId, string? Status = null);

public sealed record CallConnect(bool Supported, string? Provider = null, string? ServerUrl = null, string? RoomId = null, string? Identity = null, string? Reason = null);

/// <summary>`POST /api/call-center/calls/:id/accept`: a LiveKit token for the operator.</summary>
public sealed record CallAccept(bool Ok, string? Provider = null, string? ProviderRoomId = null, string? Token = null, bool? Takeover = null, CallConnect? Connect = null);

public sealed record CallEvent(string? Id = null, string? EventType = null, string? ActorType = null, DateTimeOffset? CreatedAt = null);

public sealed record CallDetail(CallSession Call, IReadOnlyList<CallEvent>? Events = null);

public sealed record CallNote(string Id, string Note, string? AuthorName = null, DateTimeOffset? CreatedAt = null);
