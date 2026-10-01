using System.Text.Json;
using System.Text.Json.Serialization;

namespace Webyar.Core.Support;

/// <summary>
/// Platform support: the operator talking to the team that runs the platform
/// (docs/PLATFORM_SUPPORT.md, `/api/platform-support`). Unlike the rest of
/// the API these keys are camelCase, as the endpoint writes them for every
/// client, so they are read with <see cref="SupportJson.Options"/>.
/// </summary>
public static class SupportJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };
}

/// <summary>`GET /status`: whether support is offered, who answers, and whether they are there now.</summary>
public sealed record SupportStatus(
    bool Enabled = false,
    bool Available = false,
    bool Online = false,
    string? TeamName = null,
    string? TeamAvatar = null,
    int Unread = 0,
    SupportHours? Hours = null,
    DateTimeOffset? NextOpenAt = null)
{
    /// <summary>Super Admin turned it on and this operator may use it.</summary>
    public bool Shown => Enabled && Available;
}

/// <summary>The support workspace's week, in its own time zone; keys `sat`…`fri`.</summary>
public sealed record SupportHours(string? Timezone = null, IReadOnlyDictionary<string, IReadOnlyList<SupportInterval>>? Weekly = null);

/// <summary>One opening on one day, as `HH:mm` wall-clock times.</summary>
public sealed record SupportInterval(string? From = null, string? To = null);

/// <summary>`GET /history`: the last conversations, oldest first, and their items across them.</summary>
public sealed record SupportHistory(
    IReadOnlyList<SupportConversation>? Conversations = null,
    IReadOnlyList<SupportItem>? Items = null,
    string? ActiveConversationId = null);

public sealed record SupportConversation(
    string Id,
    string Status = SupportConversation.StatusOpen,
    DateTimeOffset? CreatedAt = null,
    DateTimeOffset? EndedAt = null,
    SupportRating? Rating = null,
    bool CanRate = false)
{
    public const string StatusOpen = "open";
    public const string StatusPending = "pending";
    public const string StatusResolved = "resolved";
    public const string StatusClosed = "closed";

    /// <summary>Resolved or closed: nothing more is written to it.</summary>
    [JsonIgnore]
    public bool Ended => Status is StatusResolved or StatusClosed;
}

public sealed record SupportRating(int Score = 0, string? Comment = null, DateTimeOffset? RatedAt = null);

/// <summary>A message in the chat, or a line saying who joined it.</summary>
public sealed record SupportItem(
    string Id,
    string ConversationId = "",
    string Kind = SupportItem.KindMessage,
    string Author = SupportItem.AuthorMe,
    string? Body = null,
    string? SenderName = null,
    string? SenderAvatar = null,
    DateTimeOffset? CreatedAt = null,
    string? ClientMessageId = null,
    IReadOnlyList<SupportAttachment>? Attachments = null)
{
    public const string KindMessage = "message";
    public const string KindJoined = "joined";
    public const string AuthorMe = "me";
    public const string AuthorTeam = "team";

    [JsonIgnore]
    public bool FromTeam => Author == AuthorTeam;

    [JsonIgnore]
    public bool IsJoin => Kind == KindJoined;

    [JsonIgnore]
    public string Text => Body ?? string.Empty;

    [JsonIgnore]
    public IReadOnlyList<SupportAttachment> Files => Attachments ?? [];
}

/// <summary>A file on a support message, fetched by id through `GET /attachments/:id`.</summary>
public sealed record SupportAttachment(string Id, string? FileName = null, string? MimeType = null, long SizeBytes = 0, string? Kind = null)
{
    /// <summary>
    /// The id the app's file store files it under: support files come from
    /// their own endpoint, so they never share an id with an inbox file.
    /// </summary>
    public string StoreId => SupportRules.StoreId(Id);
}

/// <summary>What `POST /messages` and `POST /attachments` answer with.</summary>
public sealed record SupportPostResult(SupportConversation Conversation, SupportItem Item);

/// <summary>What `POST /conversations/:id/rating` answers with.</summary>
public sealed record SupportRatingResult(SupportConversation Conversation);
