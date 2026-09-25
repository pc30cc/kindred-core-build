import Foundation

/// The endpoints the app uses, one method each, named and shaped like the
/// Windows app's `WebyarApi` (windows-native/src/Webyar.Core/Api/WebyarApi.cs),
/// so the clients stay easy to compare.
@MainActor
final class WebyarAPI {
    let client: ApiClient

    init(client: ApiClient) { self.client = client }

    private static func e(_ s: String) -> String { ApiClient.escape(s) }

    // A few `{ "key": [...] }` envelopes.
    private struct SessionResponse: Decodable { var user: User? }
    private struct WorkspacesResponse: Decodable { var workspaces: [Workspace]? }
    private struct ConversationsResponse: Decodable { var conversations: [Conversation]? }
    private struct MessagesResponse: Decodable { var messages: [Message]? }
    private struct PrefsResponse: Decodable { var prefs: NotificationPrefs? }
    private struct TeamPresenceResponse: Decodable { var presence: [TeamPresence]? }
    private struct ItemsResponse<T: Decodable>: Decodable { var items: [T]? }
    private struct QueueResponse: Decodable { var queue: [QueueEntry]? }
    private struct AgentsResponse: Decodable { var agents: [AgentCallStatus]? }
    private struct CallsResponse: Decodable { var calls: [CallSession]? }
    private struct CallNotesResponse: Decodable { var notes: [CallNote]? }
    private struct CallPresenceResponse: Decodable { var presence: [CallAgentPresence]? }
    private struct CallDepartmentsResponse: Decodable { var departments: [CallDepartment]? }
    private struct MembersResponse: Decodable { var members: [WorkspaceMember]? }
    private struct NotesResponse: Decodable { var notes: [ConversationNote]? }
    private struct ContactsResponse: Decodable { var contacts: [Contact]? }
    private struct ContactResponse: Decodable { var contact: Contact? }
    private struct ContactConversationsResponse: Decodable { var conversations: [ContactConversation]? }
    private struct ContactCallsResponse: Decodable { var calls: [ContactCall]? }
    private struct AttachmentReserve: Decodable { var attachmentId: String? }
    private struct CampaignsResponse: Decodable { var campaigns: [DesktopCampaign]? }
    private struct InvitationResponse: Decodable { var invitation: CallInvitation? }

    /// `byConversation` / `byContact` are keyed by ids; decoded raw so the
    /// snake-to-camel key conversion never touches an id.
    private func profiles(_ body: [String: Any?]) async throws -> (byConversation: [String: VisitorProfile], byContact: [String: VisitorProfile], bySession: [String: VisitorProfile]) {
        let root: JSONValue = try await client.post("/api/visitor-intel/network/batch", body: body)
        func map(_ v: JSONValue?) -> [String: VisitorProfile] {
            var out: [String: VisitorProfile] = [:]
            for (id, p) in v?.object ?? [:] {
                let geo = p["geo"], device = p["device"]
                out[id] = VisitorProfile(
                    geo: geo.map { VisitorGeo(countryCode: $0["country_code"]?.string, country: $0["country"]?.string, city: $0["city"]?.string, region: $0["region"]?.string) },
                    device: device.map { VisitorDevice(browser: $0["browser"]?.string, os: $0["os"]?.string, device: $0["device"]?.string) })
            }
            return out
        }
        return (map(root["by_conversation"]), map(root["by_contact"]), map(root["by_session"]))
    }

    // MARK: Session

    func currentUser() async throws -> User {
        let r: SessionResponse = try await client.get("/api/auth/session")
        guard let user = r.user else { throw ApiError(failure: .unauthorized, status: 401) }
        return user
    }

    /// Emails a reset link; answers the same whether or not the address has an account.
    func sendPasswordReset(email: String, locale: String) async throws {
        try await client.call("POST", "/api/auth-email/send-reset", body: ["email": email, "locale": locale])
    }

    // MARK: Workspaces

    func workspaces() async throws -> [Workspace] {
        let r: WorkspacesResponse = try await client.get("/api/workspaces")
        return r.workspaces ?? []
    }

    // MARK: Conversations

    static func queue(of filter: InboxFilter) -> ApiClient.Query {
        switch filter {
        case .open: return [("queue", "main"), ("status", "open")]
        case .needsHuman: return [("queue", "main"), ("status", "open"), ("needsHuman", "true")]
        case .pending: return [("queue", "main"), ("status", "pending")]
        case .resolved: return [("queue", "main"), ("status", "resolved")]
        case .ai: return [("queue", "automated")]
        case .spam: return [("queue", "spam")]
        }
    }

    func conversations(workspaceId: String, filter: InboxFilter) async throws -> [Conversation] {
        let r: ConversationsResponse = try await client.get("/api/conversations", query: [("workspace_id", workspaceId)] + Self.queue(of: filter))
        return r.conversations ?? []
    }

    func inboxCounts(workspaceId: String, scope: String = "mine") async throws -> InboxCounts {
        try await client.get("/api/conversations/inbox-tab-counts", query: [("workspace_id", workspaceId), ("scope", scope)])
    }

    /// The web sidebar's badges: AI queue, needs-human and spam (same scope rules as the list).
    func sidebarCounts(workspaceId: String, scope: String = "mine") async throws -> SidebarCounts {
        try await client.get("/api/conversations/inbox-counts", query: [("workspace_id", workspaceId), ("scope", scope)])
    }

    /// The plan snapshot the web console gates on, plus the operator's role and
    /// the AI and call-center switches. Only the snapshot itself is required.
    func plan(workspaceId: String) async throws -> WorkspacePlan {
        let id = Self.e(workspaceId)
        async let effective: JSONValue = client.get("/api/plans/workspace/\(id)/effective")
        async let role = optional { try await self.client.get("/api/workspaces/\(id)/role", as: JSONValue.self) }
        async let ai = optional { try await self.client.get("/api/ai-agent/capabilities", query: [("workspaceId", workspaceId)], as: JSONValue.self) }
        async let calls = optional { try await self.client.get("/api/call-center/capabilities", query: [("workspaceId", workspaceId)], as: JSONValue.self) }
        let plan = WorkspacePlan.parse(try await effective)
        let r = await role, a = await ai, c = await calls
        let caps = a?["capabilities"]?.object != nil ? a?["capabilities"] : a
        return plan.with(role: r?["role"]?.string,
                         aiAgent: caps?["ai_agent_enabled"]?.bool,
                         aiAuto: caps?["auto_answer_enabled"]?.bool,
                         callCenter: c?["workspace_call_center_visible"]?.bool)
    }

    private func optional(_ call: () async throws -> JSONValue) async -> JSONValue? {
        do { return try await call() } catch { return nil }
    }

    /// Installed channel plugins that bring an inbox ("Other inboxes" in the web
    /// sidebar). An owner/admin surface: other roles get 403 and see none.
    func pluginInboxes(workspaceId: String) async throws -> [String] {
        let doc: JSONValue = try await client.get("/api/plugins/catalog", query: [("workspace_id", workspaceId)])
        var keys: [String] = []
        for item in doc["items"]?.array ?? [] {
            guard item["installed"]?.bool == true, (item["supportsInbox"] ?? item["supports_inbox"])?.bool == true else { continue }
            if let key = (item["slug"]?.text ?? item["id"]?.text)?.lowercased(), !keys.contains(key) { keys.append(key) }
        }
        return keys
    }

    func messages(conversationId: String) async throws -> [Message] {
        let r: MessagesResponse = try await client.get("/api/conversations/\(Self.e(conversationId))/messages")
        return r.messages ?? []
    }

    /// `clientMessageId` makes a retry safe: the server collapses a replay of
    /// the same key. Generate it once per message, not once per attempt.
    /// `then` is the web's split send: the server moves the conversation only
    /// once the message really went out, and says whether it did.
    @discardableResult
    func sendMessage(conversationId: String, workspaceId: String, body: String, clientMessageId: String, attachmentId: String? = nil,
                     then: PostSendAction = .none) async throws -> PostSendResult? {
        let r: SendMessageResponse = try await client.post("/api/conversations/send-message", body: [
            "conversation_id": conversationId,
            "workspace_id": workspaceId,
            "body": body,
            "client_message_id": clientMessageId,
            "attachment_id": attachmentId,
            "post_send_action": then.rawValue,
        ])
        return r.postSend
    }

    func markSeen(conversationId: String) async throws {
        try await client.call("POST", "/api/conversations/\(Self.e(conversationId))/seen")
    }

    /// Omitted fields are left alone; `unassign` sends an explicit null.
    func updateConversation(_ id: String, workspaceId: String, status: String? = nil, priority: String? = nil, assignTo: String? = nil, unassign: Bool = false) async throws {
        var body: [String: Any?] = ["workspace_id": workspaceId]
        if let status { body["status"] = status }
        if let priority { body["priority"] = priority }
        if unassign { body["assigned_to"] = NSNull() } else if let assignTo { body["assigned_to"] = assignTo }
        try await client.call("PATCH", "/api/conversations/\(Self.e(id))", body: body)
    }

    /// Spam is soft routing, as on the web: the thread (and the visitor's other threads) go to
    /// the Spam queue and the AI stops answering; the visitor is not blocked.
    func markSpam(_ id: String, workspaceId: String) async throws {
        try await client.call("POST", "/api/conversations/spam", body: ["workspace_id": workspaceId, "conversation_id": id])
    }

    func unmarkSpam(_ id: String, workspaceId: String) async throws {
        try await client.call("POST", "/api/conversations/not-spam", body: ["workspace_id": workspaceId, "conversation_id": id])
    }

    func claim(_ id: String, workspaceId: String) async throws {
        try await client.call("POST", "/api/conversations/\(Self.e(id))/claim", body: ["workspace_id": workspaceId])
    }

    /// Tags replace the whole list; send the full set.
    func setTags(_ id: String, workspaceId: String, tags: [String]) async throws {
        try await client.call("PATCH", "/api/conversations/\(Self.e(id))", body: ["workspace_id": workspaceId, "tags": tags])
    }

    /// Takes a conversation back from the AI agent, falling back to the older AI-agent route on a 404.
    func takeOver(_ id: String, workspaceId: String) async throws {
        let body: [String: Any?] = ["workspaceId": workspaceId, "assign_to_me": true]
        do {
            try await client.call("POST", "/api/conversations/\(Self.e(id))/take-over", body: body)
        } catch let e as ApiError where e.failure == .server && e.status == 404 {
            try await client.call("POST", "/api/ai-agent/conversations/\(Self.e(id))/take-over", body: body)
        }
    }

    /// The AI tells the visitor what the operator wrote, in the specialist's
    /// voice or its own ("specialist" | "assistant").
    func aiSayNow(_ id: String, body: String, attribution: String, locale: String? = nil) async throws {
        var payload: [String: Any?] = ["body": body, "attribution": attribution]
        if let locale, !locale.isEmpty { payload["locale"] = locale }
        try await client.call("POST", "/api/ai-agent/conversations/\(Self.e(id))/ai-say-now", body: payload)
    }

    // MARK: Notifications, realtime, presence

    func notificationPrefs() async throws -> NotificationPrefs {
        let r: PrefsResponse = try await client.get("/api/notifications/prefs", query: [("platform", "web")])
        return r.prefs ?? NotificationPrefs()
    }

    func realtimeConnect(workspaceId: String, intent: String = "initial") async throws -> RealtimeConnect {
        try await client.post("/api/realtime/operator-connect", body: ["workspace_id": workspaceId, "intent": intent])
    }

    func realtimeInboxSubscribe(workspaceId: String) async throws -> RealtimeSubscribe {
        try await client.post("/api/realtime/operator-inbox-subscribe", body: ["workspace_id": workspaceId])
    }

    /// Token for `ws:<workspace>:operators`: being subscribed is what makes an operator "connected" for teammates.
    func realtimePresenceSubscribe(workspaceId: String) async throws -> RealtimeSubscribe {
        try await client.post("/api/realtime/operator-presence-subscribe", body: ["workspace_id": workspaceId])
    }

    func realtimeVisitorsSubscribe(workspaceId: String) async throws -> RealtimeSubscribe {
        try await client.post("/api/realtime/operator-visitors-subscribe", body: ["workspace_id": workspaceId])
    }

    func account() async throws -> Account {
        try await client.get("/api/account/me")
    }

    /// The operator's own photo, as the web's Settings → Profile uploads it (base64, up to 10 MB).
    func uploadAvatar(data: Data, contentType: String, fileName: String) async throws {
        try await client.call("POST", "/api/account/avatar", body: [
            "data": data.base64EncodedString(),
            "contentType": contentType,
            "fileName": fileName,
        ])
    }

    func removeAvatar() async throws {
        try await client.call("DELETE", "/api/account/avatar")
    }

    func availability(locale: String) async throws -> Availability {
        try await client.get("/api/availability", query: [("locale", locale)])
    }

    /// The "invisible" switch of the web console: offline for visitors whatever the schedule says.
    func setForceOffline(_ offline: Bool) async throws -> Availability {
        try await client.send("PATCH", "/api/availability", body: ["force_offline": offline])
    }

    /// Whether the weekly schedule decides when visitors see this operator; off means always, while not invisible.
    func setScheduleEnabled(_ on: Bool) async throws -> Availability {
        try await client.send("PATCH", "/api/availability", body: ["schedule_enabled": on])
    }

    func teamPresence(workspaceId: String) async throws -> [TeamPresence] {
        let r: TeamPresenceResponse = try await client.get("/api/availability/team/\(Self.e(workspaceId))")
        return r.presence ?? []
    }

    /// Every two minutes while the app runs; `interacted` feeds active vs away.
    func heartbeat(workspaceId: String, interacted: Bool) async throws {
        try await client.call("POST", "/api/operator-activity/heartbeat", body: ["workspace_id": workspaceId, "interacted": interacted])
    }

    // MARK: Visitors

    func liveVisitors(workspaceId: String, includeOffline: Bool) async throws -> [LiveVisitor] {
        var q: ApiClient.Query = [("workspace_id", workspaceId), ("limit", "200")]
        if includeOffline { q.append(("include_offline", "1")) }
        let r: ItemsResponse<LiveVisitor> = try await client.get("/api/visitor-intel/live", query: q)
        return r.items ?? []
    }

    func pageHistory(workspaceId: String, sessionId: String) async throws -> PageHistory {
        try await client.get("/api/visitor-intel/\(Self.e(sessionId))/page-history", query: [("workspace_id", workspaceId), ("limit", "20")])
    }

    /// Reuses the visitor's open conversation when there is one, as on the web.
    func startChatWithVisitor(workspaceId: String, sessionId: String) async throws -> StartChatResult {
        try await client.post("/api/conversations/start-from-visitor", body: ["workspace_id": workspaceId, "visitor_session_id": sessionId])
    }

    // MARK: Call center

    func callQueue(workspaceId: String) async throws -> [QueueEntry] {
        let r: QueueResponse = try await client.get("/api/call-center/queue", query: [("workspaceId", workspaceId)])
        return r.queue ?? []
    }

    func callOverview(workspaceId: String) async throws -> CallCenterOverview {
        try await client.get("/api/call-center/overview", query: [("workspaceId", workspaceId)])
    }

    func agentCallStatuses(workspaceId: String) async throws -> [AgentCallStatus] {
        let r: AgentsResponse = try await client.get("/api/call-center/agent-status", query: [("workspaceId", workspaceId)])
        return r.agents ?? []
    }

    /// "available" or "away", the two states the web desk offers.
    func setAgentCallStatus(workspaceId: String, status: String) async throws {
        try await client.call("POST", "/api/call-center/agent-status", body: ["workspaceId": workspaceId, "status": status], query: [("workspaceId", workspaceId)])
    }

    func acceptCall(workspaceId: String, callId: String) async throws -> CallAccept {
        try await client.post("/api/call-center/calls/\(Self.e(callId))/accept", body: ["workspaceId": workspaceId], query: [("workspaceId", workspaceId)])
    }

    func rejectCall(workspaceId: String, callId: String) async throws {
        try await client.call("POST", "/api/call-center/calls/\(Self.e(callId))/reject", body: ["workspaceId": workspaceId], query: [("workspaceId", workspaceId)])
    }

    func endCall(workspaceId: String, callId: String) async throws {
        try await client.call("POST", "/api/call-center/calls/\(Self.e(callId))/end", body: ["workspaceId": workspaceId], query: [("workspaceId", workspaceId)])
    }

    func callDetail(workspaceId: String, callId: String) async throws -> CallDetail {
        try await client.get("/api/call-center/calls/\(Self.e(callId))", query: [("workspaceId", workspaceId)])
    }

    func callHistory(workspaceId: String, limit: Int = 50) async throws -> [CallSession] {
        let r: CallsResponse = try await client.get("/api/call-center/calls", query: [("workspaceId", workspaceId), ("limit", String(limit))])
        return r.calls ?? []
    }

    func callNotes(workspaceId: String, callId: String) async throws -> [CallNote] {
        let r: CallNotesResponse = try await client.get("/api/call-center/calls/\(Self.e(callId))/notes", query: [("workspaceId", workspaceId)])
        return r.notes ?? []
    }

    /// A call marked as spam on the desk; a call still waiting leaves the line.
    func markCallSpam(workspaceId: String, callId: String, spam: Bool) async throws {
        try await client.call("POST", "/api/call-center/calls/\(Self.e(callId))/\(spam ? "spam" : "not-spam")", query: [("workspaceId", workspaceId)])
    }

    func addCallNote(workspaceId: String, callId: String, note: String) async throws {
        try await client.call("POST", "/api/call-center/calls/\(Self.e(callId))/notes", body: ["note": note], query: [("workspaceId", workspaceId)])
    }

    /// The calls under way — to notice one a colleague has just handed to this operator.
    func activeCalls(workspaceId: String) async throws -> [CallSession] {
        let r: CallsResponse = try await client.get("/api/call-center/calls", query: [("workspaceId", workspaceId), ("status", "active"), ("limit", "20")])
        return r.calls ?? []
    }

    /// Who is on the desk and how busy, for the transfer menu.
    func callAgentPresence(workspaceId: String) async throws -> [CallAgentPresence] {
        let r: CallPresenceResponse = try await client.get("/api/call-center/agents/presence", query: [("workspaceId", workspaceId)])
        return r.presence ?? []
    }

    func callDepartments(workspaceId: String) async throws -> [CallDepartment] {
        let r: CallDepartmentsResponse = try await client.get("/api/call-center/departments", query: [("workspaceId", workspaceId)])
        return r.departments ?? []
    }

    /// Hands a live call to another operator or to a department. The call stays up: the new
    /// operator joins the same room, and the one handing it on leaves without ending it.
    func transferCall(workspaceId: String, callId: String, toAgentId: String?, toDepartmentId: String?, reason: String?) async throws {
        var body: [String: Any?] = ["workspaceId": workspaceId]
        if let toAgentId { body["to_agent_id"] = toAgentId }
        if let toDepartmentId { body["to_department_id"] = toDepartmentId }
        if let reason, !reason.isEmpty { body["reason"] = reason }
        try await client.call("POST", "/api/call-center/calls/\(Self.e(callId))/transfer", body: body, query: [("workspaceId", workspaceId)])
    }

    // MARK: People and notes

    func members(workspaceId: String) async throws -> [WorkspaceMember] {
        let r: MembersResponse = try await client.get("/api/workspace-members", query: [("workspaceId", workspaceId)])
        return r.members ?? []
    }

    func notes(conversationId: String, workspaceId: String) async throws -> [ConversationNote] {
        let r: NotesResponse = try await client.get("/api/conversations/\(Self.e(conversationId))/notes", query: [("workspace_id", workspaceId)])
        return r.notes ?? []
    }

    func addNote(conversationId: String, workspaceId: String, body: String) async throws {
        try await client.call("POST", "/api/conversations/\(Self.e(conversationId))/notes", body: ["workspace_id": workspaceId, "body": body])
    }

    func deleteNote(conversationId: String, workspaceId: String, noteId: String) async throws {
        try await client.call("DELETE", "/api/conversations/\(Self.e(conversationId))/notes/\(Self.e(noteId))", query: [("workspace_id", workspaceId)])
    }

    /// Where the visitor is and what they browse with. Decorative: a failure means "no detail".
    func visitorProfile(workspaceId: String, conversationId: String) async -> VisitorProfile? {
        do {
            return try await profiles(["workspace_id": workspaceId, "conversation_ids": [conversationId]]).byConversation[conversationId]
        } catch {
            return nil
        }
    }

    /// The web inbox's enrichment: one batched call for a page of conversations.
    func visitorProfiles(workspaceId: String, conversationIds: [String]) async -> [String: VisitorProfile] {
        guard !conversationIds.isEmpty else { return [:] }
        do {
            return try await profiles(["workspace_id": workspaceId, "conversation_ids": Array(conversationIds.prefix(500))]).byConversation
        } catch {
            return [:]
        }
    }

    /// The call center's enrichment: OS and country per caller's visitor session.
    /// Decorative: a failure means "no detail".
    func sessionProfiles(workspaceId: String, sessionIds: [String]) async -> [String: VisitorProfile] {
        // The server takes UUIDs only, and one odd id would sink the batch.
        let ids = sessionIds.filter { UUID(uuidString: $0) != nil }
        guard !ids.isEmpty else { return [:] }
        do {
            return try await profiles(["workspace_id": workspaceId, "session_ids": Array(ids.prefix(500))]).bySession
        } catch {
            Log.error("caller devices", error)
            return [:]
        }
    }

    /// The contacts page's enrichment: OS and country per contact.
    func contactProfiles(workspaceId: String, contactIds: [String]) async -> [String: VisitorProfile] {
        var all: [String: VisitorProfile] = [:]
        var rest = contactIds[...]
        while !rest.isEmpty {
            let part = Array(rest.prefix(500))
            rest = rest.dropFirst(500)
            guard let r = try? await profiles(["workspace_id": workspaceId, "contact_ids": part]) else { break }
            all.merge(r.byContact) { _, b in b }
        }
        return all
    }

    // MARK: Attachments: reserve, upload, then reference — a client never learns a storage URL.

    func uploadAttachment(workspaceId: String, conversationId: String?, fileName: String, mimeType: String, data: Data) async throws -> String {
        let reserve: AttachmentReserve = try await client.post("/api/conversation-attachments/init", body: [
            "workspace_id": workspaceId,
            "conversation_id": conversationId,
            "file_name": fileName,
            "mime_type": mimeType,
            "size_bytes": data.count,
        ])
        guard let id = reserve.attachmentId, !id.isEmpty else { throw ApiError(failure: .decoding) }
        try await client.call("POST", "/api/conversation-attachments/\(Self.e(id))/upload", body: ["workspace_id": workspaceId, "data": data.base64EncodedString()])
        return id
    }

    func attachmentData(_ id: String) async throws -> Data {
        try await client.bytes("/api/conversation-attachments/\(Self.e(id))/file")
    }

    // MARK: Contacts

    func contacts(workspaceId: String) async throws -> [Contact] {
        let r: ContactsResponse = try await client.get("/api/contacts", query: [("workspace_id", workspaceId)])
        return r.contacts ?? []
    }

    func contact(_ id: String) async throws -> Contact? {
        let r: ContactResponse = try await client.get("/api/contacts/\(Self.e(id))")
        return r.contact
    }

    func contactConversations(_ id: String) async throws -> [ContactConversation] {
        let r: ContactConversationsResponse = try await client.get("/api/contacts/\(Self.e(id))/conversations")
        return r.conversations ?? []
    }

    /// Calls with the contact; none when the workspace has no call center (a failure is not an error here).
    func contactCalls(workspaceId: String, contactId: String) async -> [ContactCall] {
        let r: ContactCallsResponse? = try? await client.get("/api/workspace-integrations/\(Self.e(workspaceId))/contacts/\(Self.e(contactId))/calls")
        return r?.calls ?? []
    }

    // MARK: Desktop app: ads, announcements, check-ins

    /// Ads and announcements for this workspace's plan and this app, in one locale. Never throws: none is fine.
    func desktopCampaigns(workspaceId: String, locale: String, platform: String) async -> [DesktopCampaign] {
        let r: CampaignsResponse? = try? await client.get("/api/desktop-app/campaigns",
                                                          query: [("workspace_id", workspaceId), ("locale", locale), ("platform", platform)])
        return r?.campaigns ?? []
    }

    /// "This copy is running" — counted in the server's memory only — and any new Super Admin broadcast.
    func desktopHeartbeat(sessionId: String, workspaceId: String?, version: String?, afterSeq: Int64?) async throws -> DesktopHeartbeat {
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        // The platform tells the two desktop apps apart for Super Admin's live count and broadcasts.
        var body: [String: Any?] = ["session_id": sessionId, "version": version, "os": "macOS \(os)", "platform": "macos"]
        if let workspaceId { body["workspace_id"] = workspaceId }
        if let afterSeq { body["after_seq"] = afterSeq }
        return try await client.post("/api/desktop-app/heartbeat", body: body)
    }

    func desktopGoodbye(sessionId: String) async throws {
        try await client.call("POST", "/api/desktop-app/goodbye", body: ["session_id": sessionId])
    }

    // MARK: Colleagues — operator-to-operator messages

    func colleagues(workspaceId: String) async throws -> ColleaguesResponse {
        try await client.get("/api/team-chat/colleagues", query: [("workspace_id", workspaceId)])
    }

    func teamThread(workspaceId: String, peerId: String) async throws -> TeamThread {
        try await client.get("/api/team-chat/thread", query: [("workspace_id", workspaceId), ("peer_id", peerId)])
    }

    func sendTeamMessage(workspaceId: String, recipientId: String, body: String, attachmentId: String? = nil) async throws {
        try await client.call("POST", "/api/team-chat/messages", body: [
            "workspace_id": workspaceId,
            "recipient_id": recipientId,
            "body": body,
            "attachment_id": attachmentId,
        ])
    }

    func markTeamRead(workspaceId: String, peerId: String) async throws {
        try await client.call("POST", "/api/team-chat/read", body: ["workspace_id": workspaceId, "peer_id": peerId])
    }

    // MARK: Saved replies

    func cannedResponses(workspaceId: String, locale: String, query: String) async throws -> [CannedResponse] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let r: ItemsResponse<CannedResponse> = try await client.get("/api/canned-responses", query: [
            ("workspace_id", workspaceId), ("locale", locale), ("limit", "50"), ("q", q.isEmpty ? nil : q),
        ])
        return r.items ?? []
    }

    func trackCannedUse(_ id: String, workspaceId: String) async throws {
        try await client.call("POST", "/api/canned-responses/\(Self.e(id))/track-use", body: ["workspace_id": workspaceId])
    }

    // MARK: Calls on a conversation

    func inviteToCall(conversationId: String, workspaceId: String, channel: String) async throws -> CallInvitation {
        let r: InvitationResponse = try await client.post("/api/call-invitations", body: [
            "workspace_id": workspaceId, "conversation_id": conversationId, "channel": channel,
        ])
        guard let inv = r.invitation else { throw ApiError(failure: .decoding) }
        return inv
    }

    func invitation(_ id: String) async throws -> CallInvitation {
        let r: InvitationResponse = try await client.get("/api/call-invitations/\(Self.e(id))")
        guard let inv = r.invitation else { throw ApiError(failure: .decoding) }
        return inv
    }

    func cancelInvitation(_ id: String) async throws {
        try await client.call("POST", "/api/call-invitations/\(Self.e(id))/cancel")
    }

    /// `display_name` is optional but not nullable server-side: leave it out rather than send null.
    func callToken(callSessionId: String, displayName: String?) async throws -> CallToken {
        var body: [String: Any?] = ["participant_type": "operator"]
        if let n = displayName?.trimmingCharacters(in: .whitespaces), !n.isEmpty { body["display_name"] = n }
        return try await client.post("/api/calls/\(Self.e(callSessionId))/token", body: body)
    }

    func hangUp(callSessionId: String) async throws {
        try await client.call("POST", "/api/calls/\(Self.e(callSessionId))/hangup")
    }

    // MARK: Visitors map

    /// The web Visitors page's map markers: `{ markers: [{ id, lat, lng, status, city, country, current_page }] }`.
    func visitorMap(workspaceId: String) async throws -> JSONValue {
        try await client.get("/api/visitor-intel/map", query: [("workspace_id", workspaceId)])
    }

    /// The map's settings: `enabled` (false hides the map) and `default_center` `{ lat, lng, zoom }`.
    func visitorMapConfig(workspaceId: String) async throws -> JSONValue {
        try await client.get("/api/visitor-intel/map-config", query: [("workspace_id", workspaceId)])
    }
}

/// What happens to the conversation once a reply is out, as the web inbox's split Send button.
enum PostSendAction: String, CaseIterable, Identifiable, Sendable {
    case none
    case waitForCustomer = "wait_for_customer"
    case resolve
    var id: String { rawValue }
}

struct PostSendResult: Decodable, Sendable {
    var changed: Bool?
    var status: String?
    /// Why the status stayed ("newer_customer_message", "delivery_failed", "no_change", …).
    var blocked: String?
}

private struct SendMessageResponse: Decodable {
    var postSend: PostSendResult?
}
