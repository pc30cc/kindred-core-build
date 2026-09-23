using System.Text.Json.Serialization;

namespace Webyar.Core.Api;

// The rest of the surface the desktop client uses beyond the inbox: people,
// notes, contacts, colleagues, email, saved replies, calls. Same rule as
// Models.cs — mirror windows/src/renderer/src/api/types.ts, everything optional.

public sealed record MemberProfile(string? Id = null, string? FullName = null, string? Email = null, string? AvatarUrl = null);

public sealed record WorkspaceMember(
    string Id,
    string UserId,
    string? Role = null,
    DateTimeOffset? SuspendedAt = null,
    MemberProfile? Profile = null,
    IReadOnlyList<string>? DepartmentNames = null)
{
    public string DisplayName => Profile?.FullName is { Length: > 0 } n ? n : Profile?.Email ?? UserId;
}

public sealed record ConversationNote(string Id, string Body, string? AuthorId = null, MemberProfile? Author = null, DateTimeOffset? CreatedAt = null);

public sealed record Contact(
    string Id,
    string? WorkspaceId = null,
    string? Name = null,
    string? Email = null,
    string? Phone = null,
    string? AvatarUrl = null,
    string? VisitorCode = null,
    DateTimeOffset? CreatedAt = null,
    DateTimeOffset? UpdatedAt = null,
    string? Notes = null,
    IReadOnlyList<string>? Tags = null,
    System.Text.Json.JsonElement? Metadata = null)
{
    /// <summary>metadata.company | org | organization, as the web contacts table reads it.</summary>
    public string? Company => MetaString("company") ?? MetaString("org") ?? MetaString("organization");

    public string? MetaString(string key) =>
        Metadata is { ValueKind: System.Text.Json.JsonValueKind.Object } m && m.TryGetProperty(key, out var v)
            && v.ValueKind == System.Text.Json.JsonValueKind.String && v.GetString() is { Length: > 0 } text ? text : null;
}

/// <summary>One of a contact's conversations, from /api/contacts/:id/conversations.</summary>
public sealed record ContactConversation(
    string Id,
    string? Status = null,
    string? Subject = null,
    string? AiState = null,
    DateTimeOffset? CreatedAt = null,
    DateTimeOffset? UpdatedAt = null,
    bool? HandledByAi = null,
    bool? HandledByOperator = null,
    string? OperatorName = null,
    string? OperatorAvatar = null,
    string? LastMessageBody = null,
    int? MessageCount = null);

/// <summary>A call with the contact, from /api/workspace-integrations/:ws/contacts/:id/calls.</summary>
public sealed record ContactCall(
    string Id,
    string? CallType = null,
    string? Direction = null,
    string? State = null,
    int? DurationSeconds = null,
    int? WaitSeconds = null,
    DateTimeOffset? CreatedAt = null,
    string? AgentName = null,
    string? AgentAvatar = null,
    bool? RecordingAvailable = null,
    string? ConversationId = null);

public sealed record VisitorGeo(string? CountryCode = null, string? Country = null, string? City = null, string? Region = null);

public sealed record VisitorDevice(string? Browser = null, string? Os = null, string? Device = null);

public sealed record VisitorProfile(VisitorGeo? Geo = null, VisitorDevice? Device = null);

public sealed record ColleagueLastMessage(string? Body = null, DateTimeOffset? CreatedAt = null, bool? Outgoing = null, string? AttachmentKind = null);

public sealed record Colleague(
    string UserId,
    string? Role = null,
    string? FullName = null,
    string? Email = null,
    string? AvatarUrl = null,
    int? Unread = null,
    ColleagueLastMessage? LastMessage = null)
{
    public string DisplayName => FullName is { Length: > 0 } n ? n : Email ?? UserId;
}

public sealed record ColleaguesResponse(IReadOnlyList<Colleague>? Colleagues = null, int? TotalUnread = null, string? Me = null);

public sealed record TeamMessage(
    string Id,
    string SenderId,
    string? RecipientId = null,
    string? Body = null,
    MessageAttachment? Attachment = null,
    DateTimeOffset? ReadAt = null,
    DateTimeOffset? CreatedAt = null);

public sealed record TeamThread(IReadOnlyList<TeamMessage>? Messages = null, string? Me = null);

public sealed record CannedResponse(string Id, string Shortcut, string Title, string Body, string? Locale = null, int? UsageCount = null);

// The email inbox answers in camelCase, unlike the rest of the API.

public sealed record EmailAddress([property: JsonPropertyName("email")] string Email);

public sealed record EmailThreadSummary(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("provider")] string? Provider = null,
    [property: JsonPropertyName("subject")] string? Subject = null,
    [property: JsonPropertyName("participants")] IReadOnlyList<EmailAddress>? Participants = null,
    [property: JsonPropertyName("lastMessageAt")] DateTimeOffset? LastMessageAt = null,
    [property: JsonPropertyName("isRead")] bool? IsRead = null,
    [property: JsonPropertyName("isStarred")] bool? IsStarred = null,
    [property: JsonPropertyName("labels")] IReadOnlyList<string>? Labels = null,
    [property: JsonPropertyName("lastMessageSnippet")] string? LastMessageSnippet = null);

public sealed record EmailAttachmentView(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("filename")] string? Filename = null,
    [property: JsonPropertyName("contentType")] string? ContentType = null,
    [property: JsonPropertyName("sizeBytes")] long? SizeBytes = null,
    [property: JsonPropertyName("url")] string? Url = null);

public sealed record EmailMessageView(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("direction")] string? Direction = null,
    [property: JsonPropertyName("fromAddress")] string? FromAddress = null,
    [property: JsonPropertyName("toAddresses")] IReadOnlyList<EmailAddress>? ToAddresses = null,
    [property: JsonPropertyName("ccAddresses")] IReadOnlyList<EmailAddress>? CcAddresses = null,
    [property: JsonPropertyName("textBody")] string? TextBody = null,
    [property: JsonPropertyName("htmlBody")] string? HtmlBody = null,
    [property: JsonPropertyName("snippet")] string? Snippet = null,
    [property: JsonPropertyName("isRead")] bool? IsRead = null,
    [property: JsonPropertyName("deliveryStatus")] string? DeliveryStatus = null,
    [property: JsonPropertyName("deliveryError")] string? DeliveryError = null,
    [property: JsonPropertyName("sentAt")] DateTimeOffset? SentAt = null,
    [property: JsonPropertyName("attachments")] IReadOnlyList<EmailAttachmentView>? Attachments = null);

public sealed record EmailThreadDetail(
    [property: JsonPropertyName("thread")] EmailThreadSummary? Thread = null,
    [property: JsonPropertyName("messages")] IReadOnlyList<EmailMessageView>? Messages = null);

public sealed record GmailConnection(
    [property: JsonPropertyName("connected")] bool? Connected = null,
    [property: JsonPropertyName("emailAddress")] string? EmailAddress = null,
    [property: JsonPropertyName("status")] string? Status = null);

public sealed record CallInvitation(
    string Id,
    string? Status = null,
    string? Channel = null,
    string? CallSessionId = null,
    string? ConversationId = null,
    DateTimeOffset? ExpiresAt = null);

public sealed record CallToken(
    string Token,
    string? Provider = null,
    string? WsUrl = null,
    string? RtcUrl = null,
    TurnServer? Turn = null,
    string? IcePolicy = null,
    IReadOnlyList<string>? Warnings = null);

public sealed record TurnServer(IReadOnlyList<string>? Urls = null, string? Username = null, string? Credential = null);

public static class ConversationPriorities
{
    public const string Low = "low";
    public const string Normal = "normal";
    public const string High = "high";
    public const string Urgent = "urgent";
    public static readonly string[] All = [Low, Normal, High, Urgent];
}
