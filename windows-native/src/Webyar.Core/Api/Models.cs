using System.Text.Json;
using System.Text.Json.Serialization;

namespace Webyar.Core.Api;

// The server is the schema of record. These mirror the responses the web
// console and the iOS app already read, field for field (see
// windows/src/renderer/src/api/types.ts), so no client disagrees about what a
// conversation is. Everything optional stays optional: an older server that
// omits a field must not break decoding.

public sealed record User(
    string Id,
    string? Email = null,
    [property: JsonPropertyName("fullName")] string? FullName = null,
    [property: JsonPropertyName("emailVerified")] bool? EmailVerified = null);

public sealed record Workspace(string Id, string Name, string? Slug = null, string? LogoUrl = null);

public sealed record ConversationContact(string? Name = null, string? Email = null, string? AvatarUrl = null, string? VisitorCode = null);

public sealed record MessagePreview(
    string? Body = null,
    DateTimeOffset? CreatedAt = null,
    string? SenderType = null,
    string? SenderName = null,
    string? AttachmentKind = null,
    string? SystemKind = null);

public sealed record Conversation(
    string Id,
    string WorkspaceId,
    string Status,
    string? ContactId = null,
    string? Subject = null,
    string? AssignedTo = null,
    string? Priority = null,
    IReadOnlyList<string>? Tags = null,
    DateTimeOffset? CreatedAt = null,
    DateTimeOffset? UpdatedAt = null,
    ConversationContact? Contacts = null,
    MessagePreview? LastMessage = null,
    int? UnreadCount = null,
    string? AiState = null,
    string? VisitorOs = null,
    string? VisitorDevice = null,
    string? VisitorCountryCode = null,
    string? VisitorCountryName = null,
    string? VisitorCity = null,
    string? VisitorRegion = null,
    JsonElement? Metadata = null)
{
    /// <summary>When anything last happened, for sorting and "5m ago".</summary>
    [JsonIgnore]
    public DateTimeOffset? LastActivity => LastMessage?.CreatedAt ?? UpdatedAt ?? CreatedAt;

    /// <summary>
    /// ai_managed, needs_human or human_active — metadata.ai_state first, as
    /// the iOS app and the web read it, then the column.
    /// </summary>
    [JsonIgnore]
    public string? AiStateValue
    {
        get
        {
            if (Metadata is { ValueKind: JsonValueKind.Object } m && m.TryGetProperty("ai_state", out var v) && v.ValueKind == JsonValueKind.String)
                return v.GetString();
            return AiState;
        }
    }

    /// <summary>The AI is answering this visitor: the operator steers it instead of writing directly.</summary>
    [JsonIgnore]
    public bool IsAiManaged => AiStateValue == "ai_managed";

    private static readonly string[] Channels = ["telegram", "bale", "whatsapp", "instagram", "x", "email", "phone", "widget"];

    /// <summary>
    /// Where the visitor wrote from, as the web's resolveChannelKey reads it:
    /// metadata.channel, else metadata.source, else the chat widget.
    /// </summary>
    [JsonIgnore]
    public string ChannelKey
    {
        get
        {
            if (Metadata is { ValueKind: JsonValueKind.Object } m)
            {
                foreach (var key in new[] { "channel", "source" })
                {
                    if (m.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
                        && v.GetString()?.ToLowerInvariant() is { } raw && Array.IndexOf(Channels, raw) >= 0) return raw;
                }
            }
            return "widget";
        }
    }
}

public sealed record MessageAttachment(string Id, string? FileName = null, string? MimeType = null, long? SizeBytes = null, string? Kind = null);

public sealed record Message(
    string Id,
    string ConversationId,
    string SenderType,
    string Body,
    string? SenderId = null,
    DateTimeOffset? CreatedAt = null,
    string? SenderName = null,
    string? SenderAvatar = null,
    IReadOnlyList<MessageAttachment>? Attachments = null,
    JsonElement? Metadata = null,
    DateTimeOffset? UpdatedAt = null)
{
    /// <summary>Operator-side messages sit on the trailing edge of the thread.</summary>
    [JsonIgnore]
    public bool IsOutgoing => SenderType is SenderTypes.Agent or SenderTypes.Ai or SenderTypes.Bot;

    [JsonIgnore]
    public bool IsSystem => SenderType == SenderTypes.System;

    /// <summary>
    /// The key the composer sent it with (metadata.client_message_id): how an
    /// optimistic bubble recognises its own confirmed copy.
    /// </summary>
    [JsonIgnore]
    public string? ClientMessageId =>
        Metadata is { ValueKind: JsonValueKind.Object } m && m.TryGetProperty("client_message_id", out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
}

/// <summary>
/// `sync` on a thread answer: whether it is the whole thread or only what
/// changed, the cursor to send back as `since`, and how many messages the
/// whole thread has right now (so a delete can be told from "nothing new").
/// Absent from servers that predate incremental sync.
/// </summary>
public sealed record MessageSyncInfo(string? Mode = null, string? Cursor = null, int? Total = null)
{
    [JsonIgnore]
    public bool IsDelta => Mode == "delta";
}

public sealed record MessagesPage(IReadOnlyList<Message>? Messages = null, MessageSyncInfo? Sync = null);

public static class SenderTypes
{
    public const string Agent = "agent";
    public const string Contact = "contact";
    public const string Ai = "ai";
    public const string Bot = "bot";
    public const string System = "system";
}

public static class ConversationStatuses
{
    public const string Open = "open";
    public const string Pending = "pending";
    public const string Resolved = "resolved";
    public const string Closed = "closed";
}

public sealed record SidebarCounts(int? Main = null, int? Automated = null, int? NeedsHuman = null, int? Spam = null);

public sealed record InboxCounts(int? Open = null, int? Pending = null, int? Resolved = null, int? All = null, int? NeedsHuman = null, int? Automated = null);

public sealed record NotificationPrefs(
    bool DisableAll = false,
    string PushScope = "all",
    bool PushPreview = true,
    bool PlaySound = true,
    bool QuietHoursEnabled = false,
    string? QuietHoursStart = null,
    string? QuietHoursEnd = null,
    string? QuietHoursTimezone = null);

public sealed record RealtimeConnect(string Vendor, string? WsUrl = null, string? Token = null, long? ExpiresAt = null);

public sealed record RealtimeSubscribe(string Vendor, string? Channel = null, string? Token = null, long? ExpiresAt = null);

/// <summary>`GET /api/platform/origins` — where the platform actually lives.</summary>
public sealed record PlatformOrigins(
    [property: JsonPropertyName("apiBaseUrl")] string? ApiBaseUrl = null,
    [property: JsonPropertyName("supportUrl")] string? SupportUrl = null,
    [property: JsonPropertyName("helpCenterUrl")] string? HelpCenterUrl = null,
    [property: JsonPropertyName("publicBaseUrl")] string? PublicBaseUrl = null);

/// <summary>The inbox queues, as the web console and the iOS app split them.</summary>
public enum InboxFilter
{
    Open,
    NeedsHuman,
    Pending,
    Ai,
    Resolved,
    Spam,
}
