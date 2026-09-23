namespace Webyar.Core.Api;

/// <summary>
/// The endpoints the app uses, one method each, named and shaped like the
/// desktop client's `api` object (windows/src/renderer/src/api/client.ts) and
/// the iOS `APIClient`, so the three stay easy to compare.
/// </summary>
public sealed class WebyarApi
{
    private readonly ApiClient _client;

    public WebyarApi(ApiClient client) => _client = client;

    public ApiClient Client => _client;

    private static KeyValuePair<string, string?> Q(string key, string? value) => new(key, value);

    // Session

    public async Task<User> CurrentUserAsync(CancellationToken ct = default)
    {
        var r = await _client.GetAsync<SessionResponse>("/api/auth/session", ct: ct).ConfigureAwait(false);
        return r?.User ?? throw new ApiException(ApiFailure.Unauthorized, 401);
    }

    /// <summary>Emails a reset link; answers the same whether or not the address has an account.</summary>
    public Task SendPasswordResetAsync(string email, string locale, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/auth-email/send-reset", new Dictionary<string, object?> { ["email"] = email, ["locale"] = locale }, ct: ct);

    // Workspaces

    public async Task<IReadOnlyList<Workspace>> WorkspacesAsync(CancellationToken ct = default) =>
        (await _client.GetAsync<WorkspacesResponse>("/api/workspaces", ct: ct).ConfigureAwait(false))?.Workspaces ?? [];

    // Conversations

    public static IEnumerable<KeyValuePair<string, string?>> QueueOf(InboxFilter filter) => filter switch
    {
        InboxFilter.Open => [Q("queue", "main"), Q("status", "open")],
        InboxFilter.NeedsHuman => [Q("queue", "main"), Q("status", "open"), Q("needsHuman", "true")],
        InboxFilter.Pending => [Q("queue", "main"), Q("status", "pending")],
        InboxFilter.Resolved => [Q("queue", "main"), Q("status", "resolved")],
        InboxFilter.Ai => [Q("queue", "automated")],
        InboxFilter.Spam => [Q("queue", "spam")],
        _ => throw new ArgumentOutOfRangeException(nameof(filter)),
    };

    public async Task<IReadOnlyList<Conversation>> ConversationsAsync(string workspaceId, InboxFilter filter, CancellationToken ct = default)
    {
        var query = new List<KeyValuePair<string, string?>> { Q("workspace_id", workspaceId) };
        query.AddRange(QueueOf(filter));
        return (await _client.GetAsync<ConversationsResponse>("/api/conversations", query, ct).ConfigureAwait(false))?.Conversations ?? [];
    }

    public Task<InboxCounts> InboxCountsAsync(string workspaceId, string scope = "mine", CancellationToken ct = default) =>
        _client.GetAsync<InboxCounts>("/api/conversations/inbox-tab-counts", [Q("workspace_id", workspaceId), Q("scope", scope)], ct);

    public async Task<IReadOnlyList<Message>> MessagesAsync(string conversationId, CancellationToken ct = default) =>
        (await _client.GetAsync<MessagesResponse>($"/api/conversations/{Uri.EscapeDataString(conversationId)}/messages", ct: ct).ConfigureAwait(false))?.Messages ?? [];

    /// <summary>
    /// `clientMessageId` makes a retry safe: the server collapses a replay of
    /// the same key. Generate it once per message, not once per attempt.
    /// </summary>
    public Task SendMessageAsync(string conversationId, string workspaceId, string body, string clientMessageId, string? attachmentId = null, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/conversations/send-message", new SendMessageBody(conversationId, workspaceId, body, clientMessageId, attachmentId), ct: ct);

    public Task MarkSeenAsync(string conversationId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/conversations/{Uri.EscapeDataString(conversationId)}/seen", ct: ct);

    /// <summary>Omitted fields are left alone; <paramref name="unassign"/> sends an explicit null.</summary>
    public Task UpdateConversationAsync(string conversationId, string workspaceId, string? status = null, string? priority = null, string? assignTo = null, bool unassign = false, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["workspace_id"] = workspaceId };
        if (status is not null) body["status"] = status;
        if (priority is not null) body["priority"] = priority;
        if (unassign) body["assigned_to"] = null;
        else if (assignTo is not null) body["assigned_to"] = assignTo;
        return _client.SendAsync(HttpMethod.Patch, $"/api/conversations/{Uri.EscapeDataString(conversationId)}", body, ct: ct);
    }

    public Task ClaimAsync(string conversationId, string workspaceId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/conversations/{Uri.EscapeDataString(conversationId)}/claim", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct: ct);

    // Notifications — the same row the web console reads.

    public async Task<NotificationPrefs> NotificationPrefsAsync(CancellationToken ct = default) =>
        (await _client.GetAsync<PrefsResponse>("/api/notifications/prefs", [Q("platform", "web")], ct).ConfigureAwait(false))?.Prefs ?? new NotificationPrefs();

    // Realtime — the Centrifugo negotiation the web console makes.

    public Task<RealtimeConnect> RealtimeConnectAsync(string workspaceId, string intent = "initial", CancellationToken ct = default) =>
        _client.PostAsync<RealtimeConnect>("/api/realtime/operator-connect", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["intent"] = intent }, ct);

    public Task<RealtimeSubscribe> RealtimeInboxSubscribeAsync(string workspaceId, CancellationToken ct = default) =>
        _client.PostAsync<RealtimeSubscribe>("/api/realtime/operator-inbox-subscribe", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct);

    private sealed record SessionResponse(User? User);
    private sealed record WorkspacesResponse(IReadOnlyList<Workspace>? Workspaces);
    private sealed record ConversationsResponse(IReadOnlyList<Conversation>? Conversations);
    private sealed record MessagesResponse(IReadOnlyList<Message>? Messages);
    private sealed record PrefsResponse(NotificationPrefs? Prefs);
    private sealed record SendMessageBody(string ConversationId, string WorkspaceId, string Body, string ClientMessageId, string? AttachmentId);
}
