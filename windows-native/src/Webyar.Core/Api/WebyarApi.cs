using System.Text.Json;

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
        // The server reads needs_human (snake case), and counts every status but closed, as the badge does.
        InboxFilter.NeedsHuman => [Q("queue", "main"), Q("status", "open,pending,resolved"), Q("needs_human", "true")],
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

    /// <summary>The web sidebar's badges: AI queue, needs-human and spam (same scope rules as the list).</summary>
    public Task<SidebarCounts> SidebarCountsAsync(string workspaceId, string scope = "mine", CancellationToken ct = default) =>
        _client.GetAsync<SidebarCounts>("/api/conversations/inbox-counts", [Q("workspace_id", workspaceId), Q("scope", scope)], ct);

    /// <summary>
    /// Installed channel plugins that bring an inbox ("Other inboxes" in the web
    /// sidebar). An owner/admin surface: other roles get 403 and see none.
    /// </summary>
    /// <summary>
    /// The plan snapshot the web console gates on, plus the operator's role and
    /// the AI and call-center switches. Only the snapshot itself is required.
    /// </summary>
    public async Task<WorkspacePlan> PlanAsync(string workspaceId, CancellationToken ct = default)
    {
        var id = Uri.EscapeDataString(workspaceId);
        var effective = _client.GetAsync<JsonElement>($"/api/plans/workspace/{id}/effective", ct: ct);
        var role = Optional(() => _client.GetAsync<JsonElement>($"/api/workspaces/{id}/role", ct: ct));
        var ai = Optional(() => _client.GetAsync<JsonElement>("/api/ai-agent/capabilities", [Q("workspaceId", workspaceId)], ct));
        var calls = Optional(() => _client.GetAsync<JsonElement>("/api/call-center/capabilities", [Q("workspaceId", workspaceId)], ct));
        var plan = WorkspacePlan.Parse(await effective.ConfigureAwait(false));
        var r = await role.ConfigureAwait(false);
        var a = await ai.ConfigureAwait(false);
        var caps = a is { ValueKind: JsonValueKind.Object } av && av.TryGetProperty("capabilities", out var inner) ? inner : a;
        var c = await calls.ConfigureAwait(false);
        return plan.With(
            role: StrOf(r, "role"),
            aiAgent: BoolOf(caps, "ai_agent_enabled"),
            aiAuto: BoolOf(caps, "auto_answer_enabled"),
            callCenter: BoolOf(c, "workspace_call_center_visible"));
    }

    private static async Task<JsonElement?> Optional(Func<Task<JsonElement>> call)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            return null;
        }
    }

    private static string? StrOf(JsonElement? e, string name) =>
        e is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? BoolOf(JsonElement? e, string name) =>
        e is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    public async Task<IReadOnlyList<string>> PluginInboxesAsync(string workspaceId, CancellationToken ct = default)
    {
        var doc = await _client.GetAsync<JsonElement>("/api/plugins/catalog", [Q("workspace_id", workspaceId)], ct).ConfigureAwait(false);
        var keys = new List<string>();
        if (doc.ValueKind != JsonValueKind.Object || !doc.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return keys;
        foreach (var item in items.EnumerateArray())
        {
            bool Flag(string camel, string snake) =>
                (item.TryGetProperty(camel, out var v) || item.TryGetProperty(snake, out v)) && v.ValueKind == JsonValueKind.True;
            if (!Flag("installed", "installed") || !Flag("supportsInbox", "supports_inbox")) continue;
            var key = (item.TryGetProperty("slug", out var slug) && slug.ValueKind == JsonValueKind.String ? slug.GetString() : null)
                ?? (item.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null);
            if (!string.IsNullOrWhiteSpace(key) && !keys.Contains(key.ToLowerInvariant())) keys.Add(key.ToLowerInvariant());
        }
        return keys;
    }

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

    /// <summary>Token for `ws:&lt;workspace&gt;:operators`: being subscribed is what makes an operator "connected" for teammates.</summary>
    public Task<RealtimeSubscribe> RealtimePresenceSubscribeAsync(string workspaceId, CancellationToken ct = default) =>
        _client.PostAsync<RealtimeSubscribe>("/api/realtime/operator-presence-subscribe", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct);

    public Task<Account> AccountAsync(CancellationToken ct = default) =>
        _client.GetAsync<Account>("/api/account/me", ct: ct);

    public Task<Availability> AvailabilityAsync(string locale, CancellationToken ct = default) =>
        _client.GetAsync<Availability>("/api/availability", [Q("locale", locale)], ct);

    /// <summary>The "invisible" switch of the web console: offline for visitors whatever the schedule says.</summary>
    public Task<Availability> SetForceOfflineAsync(bool offline, CancellationToken ct = default) =>
        _client.SendAsync<Availability>(HttpMethod.Patch, "/api/availability", null, new Dictionary<string, object?> { ["force_offline"] = offline }, ct);

    public async Task<IReadOnlyList<TeamPresence>> TeamPresenceAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<TeamPresenceResponse>($"/api/availability/team/{Uri.EscapeDataString(workspaceId)}", ct: ct).ConfigureAwait(false))?.Presence ?? [];

    /// <summary>Every two minutes while the app runs; `interacted` feeds active vs away.</summary>
    public Task HeartbeatAsync(string workspaceId, bool interacted, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/operator-activity/heartbeat", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["interacted"] = interacted }, ct: ct);

    // ── Visitors ──

    public async Task<IReadOnlyList<LiveVisitor>> LiveVisitorsAsync(string workspaceId, bool includeOffline, CancellationToken ct = default)
    {
        var q = new List<KeyValuePair<string, string?>> { Q("workspace_id", workspaceId), Q("limit", "200") };
        if (includeOffline) q.Add(Q("include_offline", "1"));
        return (await _client.GetAsync<ItemsResponse<LiveVisitor>>("/api/visitor-intel/live", q, ct).ConfigureAwait(false))?.Items ?? [];
    }

    public Task<PageHistory> PageHistoryAsync(string workspaceId, string sessionId, CancellationToken ct = default) =>
        _client.GetAsync<PageHistory>($"/api/visitor-intel/{Uri.EscapeDataString(sessionId)}/page-history", [Q("workspace_id", workspaceId), Q("limit", "20")], ct);

    /// <summary>Reuses the visitor's open conversation when there is one, as on the web.</summary>
    public Task<StartChatResult> StartChatWithVisitorAsync(string workspaceId, string sessionId, CancellationToken ct = default) =>
        _client.PostAsync<StartChatResult>("/api/conversations/start-from-visitor", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["visitor_session_id"] = sessionId }, ct);

    public Task<RealtimeSubscribe> RealtimeVisitorsSubscribeAsync(string workspaceId, CancellationToken ct = default) =>
        _client.PostAsync<RealtimeSubscribe>("/api/realtime/operator-visitors-subscribe", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct);

    /// <summary>Map markers and tile settings, handed to the map page as they come.</summary>
    public Task<System.Text.Json.JsonElement> VisitorMapAsync(string workspaceId, CancellationToken ct = default) =>
        _client.GetAsync<System.Text.Json.JsonElement>("/api/visitor-intel/map", [Q("workspace_id", workspaceId)], ct);

    public Task<System.Text.Json.JsonElement> VisitorMapConfigAsync(string workspaceId, CancellationToken ct = default) =>
        _client.GetAsync<System.Text.Json.JsonElement>("/api/visitor-intel/map-config", [Q("workspace_id", workspaceId)], ct);

    // ── Call center ──

    public async Task<IReadOnlyList<QueueEntry>> CallQueueAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<QueueResponse>("/api/call-center/queue", [Q("workspaceId", workspaceId)], ct).ConfigureAwait(false))?.Queue ?? [];

    public Task<CallCenterOverview> CallOverviewAsync(string workspaceId, CancellationToken ct = default) =>
        _client.GetAsync<CallCenterOverview>("/api/call-center/overview", [Q("workspaceId", workspaceId)], ct);

    public async Task<IReadOnlyList<AgentCallStatus>> AgentCallStatusesAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<AgentsResponse>("/api/call-center/agent-status", [Q("workspaceId", workspaceId)], ct).ConfigureAwait(false))?.Agents ?? [];

    /// <summary>"available" or "away", the two states the web desk offers.</summary>
    public Task SetAgentCallStatusAsync(string workspaceId, string status, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/call-center/agent-status", new Dictionary<string, object?> { ["workspaceId"] = workspaceId, ["status"] = status }, [Q("workspaceId", workspaceId)], ct);

    public Task<CallAccept> AcceptCallAsync(string workspaceId, string callId, CancellationToken ct = default) =>
        _client.SendAsync<CallAccept>(HttpMethod.Post, $"/api/call-center/calls/{Uri.EscapeDataString(callId)}/accept", [Q("workspaceId", workspaceId)], new Dictionary<string, object?> { ["workspaceId"] = workspaceId }, ct);

    public Task RejectCallAsync(string workspaceId, string callId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/call-center/calls/{Uri.EscapeDataString(callId)}/reject", new Dictionary<string, object?> { ["workspaceId"] = workspaceId }, [Q("workspaceId", workspaceId)], ct);

    public Task EndCallAsync(string workspaceId, string callId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/call-center/calls/{Uri.EscapeDataString(callId)}/end", new Dictionary<string, object?> { ["workspaceId"] = workspaceId }, [Q("workspaceId", workspaceId)], ct);

    public Task<CallDetail> CallDetailAsync(string workspaceId, string callId, CancellationToken ct = default) =>
        _client.GetAsync<CallDetail>($"/api/call-center/calls/{Uri.EscapeDataString(callId)}", [Q("workspaceId", workspaceId)], ct);

    public async Task<IReadOnlyList<CallSession>> CallHistoryAsync(string workspaceId, int limit = 50, CancellationToken ct = default) =>
        (await _client.GetAsync<CallsResponse>("/api/call-center/calls", [Q("workspaceId", workspaceId), Q("limit", limit.ToString(System.Globalization.CultureInfo.InvariantCulture))], ct).ConfigureAwait(false))?.Calls ?? [];

    public async Task<IReadOnlyList<CallNote>> CallNotesAsync(string workspaceId, string callId, CancellationToken ct = default) =>
        (await _client.GetAsync<CallNotesResponse>($"/api/call-center/calls/{Uri.EscapeDataString(callId)}/notes", [Q("workspaceId", workspaceId)], ct).ConfigureAwait(false))?.Notes ?? [];

    public Task AddCallNoteAsync(string workspaceId, string callId, string note, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/call-center/calls/{Uri.EscapeDataString(callId)}/notes", new Dictionary<string, object?> { ["note"] = note }, [Q("workspaceId", workspaceId)], ct);

    public Task<RealtimeSubscribe> RealtimeInboxSubscribeAsync(string workspaceId, CancellationToken ct = default) =>
        _client.PostAsync<RealtimeSubscribe>("/api/realtime/operator-inbox-subscribe", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct);

    /// <summary>Tags replace the whole list; send the full set.</summary>
    public Task SetTagsAsync(string conversationId, string workspaceId, IReadOnlyList<string> tags, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Patch, $"/api/conversations/{Uri.EscapeDataString(conversationId)}", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["tags"] = tags }, ct: ct);

    /// <summary>Takes a conversation back from the AI agent, falling back to the older AI-agent route on a 404.</summary>
    public async Task TakeOverAsync(string conversationId, string workspaceId, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["workspaceId"] = workspaceId, ["assign_to_me"] = true };
        try
        {
            await _client.SendAsync(HttpMethod.Post, $"/api/conversations/{Uri.EscapeDataString(conversationId)}/take-over", body, ct: ct).ConfigureAwait(false);
        }
        catch (ApiException e) when (e.Failure == ApiFailure.Server && e.Status == 404)
        {
            await _client.SendAsync(HttpMethod.Post, $"/api/ai-agent/conversations/{Uri.EscapeDataString(conversationId)}/take-over", body, ct: ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The AI tells the visitor what the operator wrote, in the specialist's
    /// voice or its own ("specialist" | "assistant") — the iOS say-now.
    /// </summary>
    public Task AiSayNowAsync(string conversationId, string body, string attribution, string? locale = null, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object?> { ["body"] = body, ["attribution"] = attribution };
        if (!string.IsNullOrEmpty(locale)) payload["locale"] = locale;
        return _client.SendAsync(HttpMethod.Post, $"/api/ai-agent/conversations/{Uri.EscapeDataString(conversationId)}/ai-say-now", payload, ct: ct);
    }

    // People and notes

    public async Task<IReadOnlyList<WorkspaceMember>> MembersAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<MembersResponse>("/api/workspace-members", [Q("workspaceId", workspaceId)], ct).ConfigureAwait(false))?.Members ?? [];

    public async Task<IReadOnlyList<ConversationNote>> NotesAsync(string conversationId, string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<NotesResponse>($"/api/conversations/{Uri.EscapeDataString(conversationId)}/notes", [Q("workspace_id", workspaceId)], ct).ConfigureAwait(false))?.Notes ?? [];

    public Task AddNoteAsync(string conversationId, string workspaceId, string body, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/conversations/{Uri.EscapeDataString(conversationId)}/notes", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["body"] = body }, ct: ct);

    public Task DeleteNoteAsync(string conversationId, string workspaceId, string noteId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Delete, $"/api/conversations/{Uri.EscapeDataString(conversationId)}/notes/{Uri.EscapeDataString(noteId)}", query: [Q("workspace_id", workspaceId)], ct: ct);

    /// <summary>Where the visitor is and what they browse with. Decorative: a failure means "no detail".</summary>
    public async Task<VisitorProfile?> VisitorProfileAsync(string workspaceId, string conversationId, CancellationToken ct = default)
    {
        try
        {
            var r = await _client.PostAsync<VisitorIntelResponse>("/api/visitor-intel/network/batch",
                new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["conversation_ids"] = new[] { conversationId } }, ct).ConfigureAwait(false);
            return r?.ByConversation?.GetValueOrDefault(conversationId);
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            return null;
        }
    }

    /// <summary>
    /// The web inbox's enrichment: one batched call for a page of
    /// conversations, giving each its visitor's OS and country for the avatar
    /// and city for the name. Decorative: a failure means "no detail".
    /// </summary>
    public async Task<IReadOnlyDictionary<string, VisitorProfile>> VisitorProfilesAsync(string workspaceId, IReadOnlyList<string> conversationIds, CancellationToken ct = default)
    {
        if (conversationIds.Count == 0) return new Dictionary<string, VisitorProfile>();
        try
        {
            var r = await _client.PostAsync<VisitorIntelResponse>("/api/visitor-intel/network/batch",
                new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["conversation_ids"] = conversationIds.Take(500).ToArray() }, ct).ConfigureAwait(false);
            return r?.ByConversation ?? new Dictionary<string, VisitorProfile>();
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            return new Dictionary<string, VisitorProfile>();
        }
    }

    // Attachments: reserve, upload, then reference — a client never learns a storage URL.

    public async Task<string> UploadAttachmentAsync(string workspaceId, string? conversationId, string fileName, string mimeType, byte[] data, CancellationToken ct = default)
    {
        var reserve = await _client.PostAsync<AttachmentReserve>("/api/conversation-attachments/init", new Dictionary<string, object?>
        {
            ["workspace_id"] = workspaceId,
            ["conversation_id"] = conversationId,
            ["file_name"] = fileName,
            ["mime_type"] = mimeType,
            ["size_bytes"] = data.LongLength,
        }, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(reserve?.AttachmentId)) throw new ApiException(ApiFailure.Decoding);
        await _client.SendAsync(HttpMethod.Post, $"/api/conversation-attachments/{Uri.EscapeDataString(reserve.AttachmentId)}/upload",
            new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["data"] = Convert.ToBase64String(data) }, ct: ct).ConfigureAwait(false);
        return reserve.AttachmentId;
    }

    public Task<byte[]> AttachmentDataAsync(string attachmentId, CancellationToken ct = default) =>
        _client.GetBytesAsync($"/api/conversation-attachments/{Uri.EscapeDataString(attachmentId)}/file", ct);

    public Task SendMessageWithAttachmentAsync(string conversationId, string workspaceId, string body, string clientMessageId, string attachmentId, CancellationToken ct = default) =>
        SendMessageAsync(conversationId, workspaceId, body, clientMessageId, attachmentId, ct);

    // Contacts

    public async Task<Contact?> ContactAsync(string contactId, CancellationToken ct = default) =>
        (await _client.GetAsync<ContactResponse>($"/api/contacts/{Uri.EscapeDataString(contactId)}", ct: ct).ConfigureAwait(false))?.Contact;

    public async Task<IReadOnlyList<ContactConversation>> ContactConversationsAsync(string contactId, CancellationToken ct = default) =>
        (await _client.GetAsync<ContactConversationsResponse>($"/api/contacts/{Uri.EscapeDataString(contactId)}/conversations", ct: ct).ConfigureAwait(false))?.Conversations ?? [];

    /// <summary>Calls with the contact; none when the workspace has no call center (a failure is not an error here).</summary>
    public async Task<IReadOnlyList<ContactCall>> ContactCallsAsync(string workspaceId, string contactId, CancellationToken ct = default)
    {
        try
        {
            return (await _client.GetAsync<ContactCallsResponse>($"/api/workspace-integrations/{Uri.EscapeDataString(workspaceId)}/contacts/{Uri.EscapeDataString(contactId)}/calls", ct: ct).ConfigureAwait(false))?.Calls ?? [];
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            return [];
        }
    }

    /// <summary>The contacts page's enrichment: OS and country per contact, for the avatar and the name.</summary>
    public async Task<IReadOnlyDictionary<string, VisitorProfile>> ContactProfilesAsync(string workspaceId, IReadOnlyList<string> contactIds, CancellationToken ct = default)
    {
        var all = new Dictionary<string, VisitorProfile>();
        try
        {
            foreach (var part in contactIds.Chunk(500))
            {
                var r = await _client.PostAsync<VisitorIntelResponse>("/api/visitor-intel/network/batch",
                    new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["contact_ids"] = part }, ct).ConfigureAwait(false);
                foreach (var (id, p) in r?.ByContact ?? []) all[id] = p;
            }
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
        }
        return all;
    }

    public async Task<IReadOnlyList<Contact>> ContactsAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<ContactsResponse>("/api/contacts", [Q("workspace_id", workspaceId)], ct).ConfigureAwait(false))?.Contacts ?? [];

    // Desktop app: ads, announcements, check-ins.

    /// <summary>Ads and announcements for this workspace's plan, in one locale. Never throws: none is fine.</summary>
    public async Task<IReadOnlyList<DesktopCampaign>> DesktopCampaignsAsync(string workspaceId, string locale, CancellationToken ct = default)
    {
        try
        {
            return (await _client.GetAsync<DesktopCampaignsResponse>("/api/desktop-app/campaigns", [Q("workspace_id", workspaceId), Q("locale", locale)], ct).ConfigureAwait(false))?.Campaigns ?? [];
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            return [];
        }
    }

    /// <summary>"This copy is running" — counted in the server's memory only — and any new Super Admin broadcast.</summary>
    public Task<DesktopHeartbeat> DesktopHeartbeatAsync(string sessionId, string? workspaceId, string? version, long? afterSeq, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["session_id"] = sessionId,
            ["version"] = version,
            ["os"] = Environment.OSVersion.VersionString,
        };
        if (workspaceId is not null) body["workspace_id"] = workspaceId;
        if (afterSeq is not null) body["after_seq"] = afterSeq;
        return _client.PostAsync<DesktopHeartbeat>("/api/desktop-app/heartbeat", body, ct);
    }

    public Task DesktopGoodbyeAsync(string sessionId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/desktop-app/goodbye", new Dictionary<string, object?> { ["session_id"] = sessionId }, ct: ct);

    // Colleagues — operator-to-operator messages.

    public async Task<ColleaguesResponse> ColleaguesAsync(string workspaceId, CancellationToken ct = default) =>
        await _client.GetAsync<ColleaguesResponse>("/api/team-chat/colleagues", [Q("workspace_id", workspaceId)], ct).ConfigureAwait(false) ?? new ColleaguesResponse();

    public async Task<TeamThread> TeamThreadAsync(string workspaceId, string peerId, CancellationToken ct = default) =>
        await _client.GetAsync<TeamThread>("/api/team-chat/thread", [Q("workspace_id", workspaceId), Q("peer_id", peerId)], ct).ConfigureAwait(false) ?? new TeamThread();

    public Task SendTeamMessageAsync(string workspaceId, string recipientId, string body, string? attachmentId = null, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/team-chat/messages", new Dictionary<string, object?>
        {
            ["workspace_id"] = workspaceId,
            ["recipient_id"] = recipientId,
            ["body"] = body,
            ["attachment_id"] = attachmentId,
        }, ct: ct);

    public Task MarkTeamReadAsync(string workspaceId, string peerId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, "/api/team-chat/read", new Dictionary<string, object?> { ["workspace_id"] = workspaceId, ["peer_id"] = peerId }, ct: ct);

    // Saved replies

    public async Task<IReadOnlyList<CannedResponse>> CannedResponsesAsync(string workspaceId, string locale, string query, CancellationToken ct = default) =>
        (await _client.GetAsync<CannedResponsesResponse>("/api/canned-responses",
            [Q("workspace_id", workspaceId), Q("locale", locale), Q("limit", "50"), Q("q", string.IsNullOrWhiteSpace(query) ? null : query.Trim())], ct).ConfigureAwait(false))?.Items ?? [];

    public Task TrackCannedUseAsync(string id, string workspaceId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/canned-responses/{Uri.EscapeDataString(id)}/track-use", new Dictionary<string, object?> { ["workspace_id"] = workspaceId }, ct: ct);

    // Email inbox — a real mailbox on its own /api/email-inbox surface.

    public async Task<IReadOnlyList<EmailThreadSummary>> EmailThreadsAsync(string workspaceId, string? search = null, CancellationToken ct = default) =>
        (await _client.GetAsync<EmailThreadsResponse>($"/api/email-inbox/{Uri.EscapeDataString(workspaceId)}/threads",
            [Q("limit", "50"), Q("q", string.IsNullOrWhiteSpace(search) ? null : search)], ct).ConfigureAwait(false))?.Threads ?? [];

    public async Task<EmailThreadDetail> EmailThreadAsync(string workspaceId, string threadId, CancellationToken ct = default) =>
        await _client.GetAsync<EmailThreadDetail>($"/api/email-inbox/{Uri.EscapeDataString(workspaceId)}/threads/{Uri.EscapeDataString(threadId)}", ct: ct).ConfigureAwait(false) ?? new EmailThreadDetail();

    public Task SetEmailReadAsync(string workspaceId, string threadId, bool isRead, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/email-inbox/{Uri.EscapeDataString(workspaceId)}/threads/{Uri.EscapeDataString(threadId)}/read", new Dictionary<string, object?> { ["is_read"] = isRead }, ct: ct);

    public Task SetEmailStarredAsync(string workspaceId, string threadId, bool starred, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/email-inbox/{Uri.EscapeDataString(workspaceId)}/threads/{Uri.EscapeDataString(threadId)}/star", new Dictionary<string, object?> { ["starred"] = starred }, ct: ct);

    public Task SendEmailAsync(string workspaceId, string? threadId, IReadOnlyList<string> to, string subject, string body, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/email-inbox/{Uri.EscapeDataString(workspaceId)}/send", new Dictionary<string, object?>
        {
            ["thread_id"] = threadId,
            ["to"] = to,
            ["subject"] = subject,
            ["text_body"] = body,
        }, ct: ct);

    public async Task<GmailConnection?> GmailConnectionAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<GmailConnectionResponse>("/api/plugins/gmail/connection", [Q("workspace_id", workspaceId)], ct).ConfigureAwait(false))?.Connection;

    // Calls on a conversation

    public async Task<CallInvitation> InviteToCallAsync(string conversationId, string workspaceId, string channel, CancellationToken ct = default) =>
        (await _client.PostAsync<InvitationResponse>("/api/call-invitations", new Dictionary<string, object?>
        {
            ["workspace_id"] = workspaceId,
            ["conversation_id"] = conversationId,
            ["channel"] = channel,
        }, ct).ConfigureAwait(false))?.Invitation ?? throw new ApiException(ApiFailure.Decoding);

    public async Task<CallInvitation> InvitationAsync(string id, CancellationToken ct = default) =>
        (await _client.GetAsync<InvitationResponse>($"/api/call-invitations/{Uri.EscapeDataString(id)}", ct: ct).ConfigureAwait(false))?.Invitation ?? throw new ApiException(ApiFailure.Decoding);

    public Task CancelInvitationAsync(string id, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/call-invitations/{Uri.EscapeDataString(id)}/cancel", ct: ct);

    /// <summary>`display_name` is optional but not nullable server-side: leave it out rather than send null.</summary>
    public Task<CallToken> CallTokenAsync(string callSessionId, string? displayName, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["participant_type"] = "operator" };
        if (!string.IsNullOrWhiteSpace(displayName)) body["display_name"] = displayName;
        return _client.PostAsync<CallToken>($"/api/calls/{Uri.EscapeDataString(callSessionId)}/token", body, ct);
    }

    public Task HangUpAsync(string callSessionId, CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"/api/calls/{Uri.EscapeDataString(callSessionId)}/hangup", ct: ct);

    private sealed record SessionResponse(User? User);
    private sealed record TeamPresenceResponse(IReadOnlyList<TeamPresence>? Presence);
    private sealed record ItemsResponse<T>(IReadOnlyList<T>? Items);
    private sealed record QueueResponse(IReadOnlyList<QueueEntry>? Queue);
    private sealed record AgentsResponse(IReadOnlyList<AgentCallStatus>? Agents);
    private sealed record CallsResponse(IReadOnlyList<CallSession>? Calls);
    private sealed record CallNotesResponse(IReadOnlyList<CallNote>? Notes);
    private sealed record WorkspacesResponse(IReadOnlyList<Workspace>? Workspaces);
    private sealed record ConversationsResponse(IReadOnlyList<Conversation>? Conversations);
    private sealed record MessagesResponse(IReadOnlyList<Message>? Messages);
    private sealed record PrefsResponse(NotificationPrefs? Prefs);
    private sealed record MembersResponse(IReadOnlyList<WorkspaceMember>? Members);
    private sealed record NotesResponse(IReadOnlyList<ConversationNote>? Notes);
    private sealed record ContactsResponse(IReadOnlyList<Contact>? Contacts);
    private sealed record AttachmentReserve(string? AttachmentId);
    private sealed record DesktopCampaignsResponse(IReadOnlyList<DesktopCampaign>? Campaigns);
    private sealed record ContactResponse(Contact? Contact);
    private sealed record ContactConversationsResponse(IReadOnlyList<ContactConversation>? Conversations);
    private sealed record ContactCallsResponse(IReadOnlyList<ContactCall>? Calls);
    private sealed record VisitorIntelResponse(Dictionary<string, VisitorProfile>? ByConversation, Dictionary<string, VisitorProfile>? ByContact);
    private sealed record CannedResponsesResponse(IReadOnlyList<CannedResponse>? Items);
    private sealed record EmailThreadsResponse([property: System.Text.Json.Serialization.JsonPropertyName("threads")] IReadOnlyList<EmailThreadSummary>? Threads);
    private sealed record GmailConnectionResponse([property: System.Text.Json.Serialization.JsonPropertyName("connection")] GmailConnection? Connection);
    private sealed record InvitationResponse(CallInvitation? Invitation);
    private sealed record SendMessageBody(string ConversationId, string WorkspaceId, string Body, string ClientMessageId, string? AttachmentId);
}
