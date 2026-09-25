import Foundation

/// Every way a request can fail, in the terms the UI needs to react.
///
/// The distinction that matters most is `unauthorized` versus `transport`: the
/// first means the session is genuinely gone and the operator must sign in
/// again; the second means we simply could not ask. Treating a dropped
/// connection as a logout would throw away a perfectly good session every time
/// someone walks into a lift.
enum APIError: Error, Equatable, Sendable {
    /// The server rejected our credentials, or the session was revoked.
    case unauthorized
    /// We never got an answer — offline, DNS, timeout, TLS.
    case transport
    /// The server answered with a failure and, where it gave one, a message.
    case server(status: Int, message: String?)
    /// The answer did not match what this version of the app understands.
    case decoding

    var isAuthFailure: Bool { self == .unauthorized }

    /// The server understood the request perfectly and has nothing to answer
    /// it with, because this deployment does not carry the feature.
    ///
    /// 501 rather than 500, and worth telling apart, because the two need
    /// opposite things from whoever sees them: a failure invites "try again",
    /// and a retry here can never succeed. The one case in practice is a
    /// database built from the self-host migration chain before
    /// `198_canned_responses_selfhost.sql` added the saved-replies table.
    var isFeatureMissing: Bool {
        if case .server(let status, _) = self { return status == 501 }
        return false
    }
}

/// Talks to the same REST API the web client uses.
///
/// Native sessions use `Authorization: Bearer <opaque token>` — the server
/// runs the identical security flow it runs for the web's cookie session and
/// simply returns the token in the login response body instead
/// (`server/lib/sessionTransport.ts`).
actor APIClient {

    static let shared = APIClient()

    private var baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// Set on login, cleared on a *confirmed* logout. Held in memory so the
    /// Keychain is not read on every single request.
    private var token: String?

    init(baseURL: URL = PlatformOrigin.current) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        // A hung request is worse than a failed one: the operator is left
        // staring at a spinner. Fail fast enough to show a retry affordance.
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 60
        config.waitsForConnectivity = false
        // The session token is the auth; cookies would only add a second,
        // confusing transport.
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        // No HTTP cache for the API. An authenticated JSON answer kept by
        // `URLCache` would be an application cache nobody decided on — keyed
        // by URL, shared across accounts, and able to answer a revalidation
        // with a stale 200 instead of the 304 the app asked for. What the app
        // keeps, it keeps on purpose: messages and lists in `LocalStore`
        // (checked with a cursor or an ETag), files in `AttachmentDiskCache`.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)

        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = DateParsing.parse(raw) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Unrecognised date: \(raw)")
                )
            }
            return date
        }
        self.decoder = dec

        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        self.encoder = enc

        self.token = TokenStore.read()
    }

    // MARK: - Where the platform lives

    /// Asks the platform where it lives and moves there if the answer differs.
    ///
    /// Run once at launch, before anything else talks to the server, so the
    /// whole session uses an origin that has just proved it answers.
    ///
    /// The retry is the important part. If the origin we remembered has gone
    /// dark — a domain typed wrong in Super Admin, a certificate that lapsed —
    /// we forget it and ask the value compiled into the build instead. Without
    /// that, one bad edit would brick every installed copy until the App Store
    /// shipped a new one.
    func refreshOrigin() async {
        if let origins = await askOrigins(at: baseURL) {
            adopt(origins)
            return
        }
        guard PlatformOrigin.isStored else { return }
        PlatformOrigin.forget()
        baseURL = GeneratedConfig.apiBaseURL
        if let origins = await askOrigins(at: baseURL) { adopt(origins) }
    }

    private func adopt(_ origins: PlatformOrigins) {
        PlatformOrigin.rememberSupport(origins.support)
        guard let api = origins.api, api != baseURL else { return }
        PlatformOrigin.remember(api)
        baseURL = api
    }

    /// Deliberately its own request rather than going through `perform`: it
    /// runs before there is a session, it must not be treated as a failure
    /// worth showing, and it has to be able to ask a host we are about to stop
    /// trusting.
    private func askOrigins(at origin: URL) async -> PlatformOrigins? {
        guard let url = URL(string: "/api/platform/origins", relativeTo: origin) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 8
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode)
        else { return nil }
        return try? decoder.decode(PlatformOrigins.self, from: data)
    }

    // MARK: - Session lifecycle

    var hasToken: Bool { token != nil }

    func setToken(_ value: String?) {
        token = value
        if let value { TokenStore.save(value) } else { TokenStore.delete() }
    }

    // MARK: - Request plumbing

    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError.transport
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.transport }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.transport }

        guard (200..<300).contains(http.statusCode) else {
            // Only 401 means "this session is void". A 403 means the session
            // is fine and this particular thing is not allowed — treating the
            // two the same signed an operator out of the whole app because
            // one endpoint refused them.
            if http.statusCode == 401 { throw APIError.unauthorized }
            let message = try? decoder.decode(ErrorResponse.self, from: data).error
            throw APIError.server(status: http.statusCode, message: message)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    /// For endpoints whose body we do not need — only that they succeeded.
    private func performIgnoringBody(_ request: URLRequest) async throws {
        let response: URLResponse
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.server(status: http.statusCode, message: nil)
        }
    }

    /// Fetches a response body as bytes rather than JSON.
    ///
    /// Media does not come back as JSON and cannot be fetched by `AsyncImage`
    /// or `AVPlayer` either, because the stream endpoint authorizes on the
    /// operator's bearer token and neither of those can carry a header.
    private func performData(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            let message = try? decoder.decode(ErrorResponse.self, from: data).error
            throw APIError.server(status: http.statusCode, message: message)
        }
        return data
    }

    // MARK: - Auth

    private struct LoginBody: Encodable, Sendable {
        let email: String
        let password: String
        /// Asks the server for a Bearer-transport session instead of a cookie.
        let client = "mobile"
    }

    func logIn(email: String, password: String) async throws -> User {
        let request = try makeRequest("POST", "/api/auth/login", body: LoginBody(email: email, password: password))
        let result = try await perform(request, as: LoginResponse.self)

        guard let sessionToken = result.sessionToken, let user = result.user else {
            throw APIError.decoding
        }
        setToken(sessionToken)
        return user
    }

    /// Confirms the stored token still names a live session.
    func currentUser() async throws -> User {
        guard token != nil else { throw APIError.unauthorized }
        let request = try makeRequest("GET", "/api/auth/session")
        let result = try await perform(request, as: SessionResponse.self)
        guard let user = result.user else { throw APIError.unauthorized }
        return user
    }

    /// Only a confirmed server-side revocation clears the token. A network
    /// failure here proves nothing, so the caller stays signed in and can
    /// retry — clearing locally would show a signed-out UI while a usable
    /// session still existed on the server.
    func logOut() async throws {
        let request = try makeRequest("POST", "/api/auth/logout")
        try await performIgnoringBody(request)
        setToken(nil)
    }

    /// Drops the local session without asking the server. Reserved for the one
    /// case where the server has already told us the session is void (401).
    func discardSession() {
        setToken(nil)
    }

    private struct ResetBody: Encodable, Sendable {
        let email: String
        let locale: String
    }

    /// Asks the server to email a reset link.
    ///
    /// The response is deliberately not inspected for whether the address
    /// exists: the endpoint answers the same either way so that it cannot be
    /// used to discover which addresses have accounts, and the UI must not
    /// undo that by reporting a difference.
    ///
    /// The locale is the operator's chosen interface language, and it is sent
    /// because this is the one message the product writes to somebody who is
    /// not signed in: there is no stored preference to look up on the server
    /// side, so an app that did not say arrived as English no matter what the
    /// screen it was requested from was written in.
    func requestPasswordReset(email: String, locale: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/auth-email/send-reset",
            body: ResetBody(email: email, locale: locale)
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Workspaces

    func workspaces() async throws -> [Workspace] {
        let request = try makeRequest("GET", "/api/workspaces")
        return try await perform(request, as: WorkspacesResponse.self).workspaces
    }

    // MARK: - Conversations

    private func listQuery(workspaceID: String, filter: InboxFilter) -> [URLQueryItem] {
        var query = [
            URLQueryItem(name: "workspace_id", value: workspaceID),
            URLQueryItem(name: "queue", value: filter.queue),
        ]
        if let status = filter.status {
            query.append(URLQueryItem(name: "status", value: status))
        }
        if filter.needsHumanOnly {
            // Snake case: the route's schema reads `needs_human`, and an
            // unknown key is silently dropped — which is how this queue used
            // to show the whole open inbox.
            query.append(URLQueryItem(name: "needs_human", value: "true"))
        }
        return query
    }

    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation] {
        let request = try makeRequest("GET", "/api/conversations", query: listQuery(workspaceID: workspaceID, filter: filter))
        return try await perform(request, as: ConversationsResponse.self).conversations
    }

    /// The list, revalidated against the copy already held.
    ///
    /// `etag` goes out as `If-None-Match`; a 304 comes back as
    /// `conversations == nil` — "what you have is current" — with no body at
    /// all, which on a busy queue is the difference between a few hundred
    /// bytes and a few hundred kilobytes for every refresh that finds nothing
    /// new.
    func conversations(workspaceID: String, filter: InboxFilter, etag: String?) async throws -> ListPage {
        var request = try makeRequest("GET", "/api/conversations", query: listQuery(workspaceID: workspaceID, filter: filter))
        if let etag, !etag.isEmpty { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, http) = try await exchange(request, accepting304: true)
        let tag = http.value(forHTTPHeaderField: "ETag")
        if http.statusCode == 304 { return ListPage(conversations: nil, etag: tag ?? etag) }
        do {
            return ListPage(conversations: try decoder.decode(ConversationsResponse.self, from: data).conversations, etag: tag)
        } catch {
            throw APIError.decoding
        }
    }

    /// One conversation of `workspaceID`, wherever it is filed; nil when the
    /// server does not have it there (gone, or in another workspace).
    func conversation(id: String, workspaceID: String) async throws -> Conversation? {
        let request = try makeRequest(
            "GET", "/api/conversations/\(Self.escape(id))",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        do {
            return try await perform(request, as: ConversationResponse.self).conversation
        } catch APIError.server(status: 404, message: _) {
            return nil
        }
    }

    func messages(conversationID: String) async throws -> [Message] {
        try await messagePage(conversationID: conversationID, since: nil).messages
    }

    /// A thread, or only what changed in it since `since`.
    ///
    /// The server answers a cursor with the rows created *or changed* after
    /// it (so a delivery receipt or a file landing on an old message comes
    /// back too), and says which it did. A server that predates this — or
    /// whose database is not migrated yet — ignores the cursor and sends the
    /// whole thread, which is read as exactly that.
    func messagePage(conversationID: String, since: String?) async throws -> ThreadPage {
        var query: [URLQueryItem] = []
        if let since { query.append(URLQueryItem(name: "since", value: since)) }
        let request = try makeRequest("GET", "/api/conversations/\(Self.escape(conversationID))/messages", query: query)
        let response = try await perform(request, as: MessagesResponse.self)
        let delta = since != nil && response.sync?.mode == "delta"
        return ThreadPage(messages: response.messages, delta: delta, cursor: response.sync?.cursor)
    }

    private static func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    }

    /// The raw exchange, for the few callers that need the status and headers
    /// themselves. 401 is still the session ending, everywhere.
    private func exchange(_ request: URLRequest, accepting304: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        if (200..<300).contains(http.statusCode) || (accepting304 && http.statusCode == 304) { return (data, http) }
        if http.statusCode == 401 { throw APIError.unauthorized }
        let message = try? decoder.decode(ErrorResponse.self, from: data).error
        throw APIError.server(status: http.statusCode, message: message)
    }

    // MARK: - Realtime

    private struct RealtimeConnectBody: Encodable, Sendable {
        let workspace_id: String
        let intent: String
    }

    private struct WorkspaceBody: Encodable, Sendable {
        let workspace_id: String
    }

    /// The Centrifugo connection token, the same one the console and the
    /// desktop apps ask for. A platform running without realtime answers with
    /// another vendor and no token, and the app keeps to its polling.
    func realtimeConnect(workspaceID: String, intent: String) async throws -> RealtimeConnect {
        let request = try makeRequest(
            "POST", "/api/realtime/operator-connect",
            body: RealtimeConnectBody(workspace_id: workspaceID, intent: intent)
        )
        return try await perform(request, as: RealtimeConnect.self)
    }

    /// The subscription token for `ws:<workspace>:inbox`, the operator-only
    /// channel every message and conversation change in the workspace is
    /// published on.
    func realtimeInboxSubscribe(workspaceID: String) async throws -> RealtimeSubscribe {
        let request = try makeRequest(
            "POST", "/api/realtime/operator-inbox-subscribe",
            body: WorkspaceBody(workspace_id: workspaceID)
        )
        return try await perform(request, as: RealtimeSubscribe.self)
    }

    private struct SendBody: Encodable, Sendable {
        let conversation_id: String
        let workspace_id: String
        let body: String
        /// The server collapses a replay of the same key instead of sending
        /// twice, which is what makes a retry safe. Must be 8–64 characters.
        let client_message_id: String
        /// Set when the message carries a file. The server requires a body or
        /// an attachment, so a file with no caption sends an empty body.
        let attachment_id: String?
    }

    func send(
        body: String,
        conversationID: String,
        workspaceID: String,
        clientMessageID: String,
        attachmentID: String?
    ) async throws {
        let request = try makeRequest(
            "POST",
            "/api/conversations/send-message",
            body: SendBody(
                conversation_id: conversationID,
                workspace_id: workspaceID,
                body: body,
                client_message_id: clientMessageID,
                attachment_id: attachmentID
            )
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Sending a file

    private struct AttachmentInitBody: Encodable, Sendable {
        let workspace_id: String
        /// Nil for an internal message. The server's schema declares it
        /// nullable and optional for exactly this: a file an operator sends a
        /// colleague is reserved against the workspace and never bound to a
        /// visitor's thread.
        let conversation_id: String?
        let file_name: String
        let mime_type: String
        let size_bytes: Int
    }

    private struct AttachmentInitResponse: Decodable, Sendable {
        let attachmentID: String

        enum CodingKeys: String, CodingKey {
            case attachmentID = "attachment_id"
        }
    }

    private struct AttachmentUploadBody: Encodable, Sendable {
        let workspace_id: String
        let data: String
    }

    /// Puts a file where a message can point at it.
    ///
    /// Three steps, and all three are the server's design rather than ours:
    /// the row is reserved first so the storage key and the size cap are
    /// decided server-side, the bytes follow, and only then may a message
    /// reference it. Uploading straight to the provider is deliberately not
    /// possible — a client never learns a storage URL.
    func uploadAttachment(
        conversationID: String?,
        workspaceID: String,
        fileName: String,
        mimeType: String,
        data: Data
    ) async throws -> String {
        let reserve = try makeRequest(
            "POST",
            "/api/conversation-attachments/init",
            body: AttachmentInitBody(
                workspace_id: workspaceID,
                conversation_id: conversationID,
                file_name: fileName,
                mime_type: mimeType,
                size_bytes: data.count
            )
        )
        let attachmentID = try await perform(reserve, as: AttachmentInitResponse.self).attachmentID

        let upload = try makeRequest(
            "POST",
            "/api/conversation-attachments/\(attachmentID)/upload",
            body: AttachmentUploadBody(
                workspace_id: workspaceID,
                data: data.base64EncodedString()
            )
        )
        try await performIgnoringBody(upload)
        return attachmentID
    }

    /// Takes no body: the route authorises against the conversation's own
    /// `workspace_id`, so a client-supplied one could only ever disagree.
    func markSeen(conversationID: String) async throws {
        let request = try makeRequest("POST", "/api/conversations/\(conversationID)/seen")
        try await performIgnoringBody(request)
    }

    private struct StatusBody: Encodable, Sendable {
        let workspace_id: String
        let status: String
    }

    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws {
        let request = try makeRequest(
            "PATCH",
            "/api/conversations/\(conversationID)",
            body: StatusBody(workspace_id: workspaceID, status: status.rawValue)
        )
        try await performIgnoringBody(request)
    }

    /// The full conversation patch the web's action panel sends.
    ///
    /// One shape for all four fields rather than a method each: the server
    /// takes them together, records one diff, and omitted keys are left
    /// alone — so encoding `nil` for a field has to mean "don't touch it".
    private struct ConversationPatch: Encodable, Sendable {
        let workspace_id: String
        var status: String?
        var priority: String?
        var assigned_to: String??
        var tags: [String]?

        enum CodingKeys: String, CodingKey {
            case workspace_id, status, priority, assigned_to, tags
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(workspace_id, forKey: .workspace_id)
            try container.encodeIfPresent(status, forKey: .status)
            try container.encodeIfPresent(priority, forKey: .priority)
            try container.encodeIfPresent(tags, forKey: .tags)
            // Unassigning is an explicit `null`, which is a different thing
            // from leaving the assignee alone. The double optional is what
            // keeps those two apart all the way to the wire.
            if let assigned_to {
                try container.encode(assigned_to, forKey: .assigned_to)
            }
        }
    }

    func updateConversation(
        conversationID: String,
        workspaceID: String,
        status: ConversationStatus? = nil,
        priority: ConversationPriority? = nil,
        assignedTo: String?? = nil,
        tags: [String]? = nil
    ) async throws {
        let request = try makeRequest(
            "PATCH",
            "/api/conversations/\(conversationID)",
            body: ConversationPatch(
                workspace_id: workspaceID,
                status: status?.rawValue,
                priority: priority?.rawValue,
                assigned_to: assignedTo,
                tags: tags
            )
        )
        try await performIgnoringBody(request)
    }

    func workspaceMembers(workspaceID: String) async throws -> [WorkspaceMember] {
        let request = try makeRequest(
            "GET",
            "/api/workspace-members",
            // This route spells it `workspaceId`; most of the others use
            // `workspace_id`. Matching the server is what matters.
            query: [URLQueryItem(name: "workspaceId", value: workspaceID)]
        )
        return try await perform(request, as: WorkspaceMembersResponse.self).members
    }

    // MARK: - Internal notes

    func notes(conversationID: String, workspaceID: String) async throws -> [ConversationNote] {
        let request = try makeRequest(
            "GET",
            "/api/conversations/\(conversationID)/notes",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        return try await perform(request, as: NotesResponse.self).notes
    }

    private struct NoteBody: Encodable, Sendable {
        let workspace_id: String
        let body: String
    }

    func addNote(conversationID: String, workspaceID: String, body: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/conversations/\(conversationID)/notes",
            body: NoteBody(workspace_id: workspaceID, body: body)
        )
        try await performIgnoringBody(request)
    }

    func deleteNote(conversationID: String, workspaceID: String, noteID: String) async throws {
        let request = try makeRequest(
            "DELETE",
            "/api/conversations/\(conversationID)/notes/\(noteID)",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Calls on a conversation

    private struct InvitationBody: Encodable, Sendable {
        let workspace_id: String
        let conversation_id: String
        let channel: String
    }

    func inviteToCall(
        conversationID: String,
        workspaceID: String,
        channel: CallChannel
    ) async throws -> CallInvitation {
        let request = try makeRequest(
            "POST",
            "/api/call-invitations",
            body: InvitationBody(
                workspace_id: workspaceID,
                conversation_id: conversationID,
                channel: channel.rawValue
            )
        )
        return try await perform(request, as: CallInvitationResponse.self).invitation
    }

    func cancelInvitation(id: String) async throws {
        let request = try makeRequest("POST", "/api/call-invitations/\(id)/cancel")
        try await performIgnoringBody(request)
    }

    /// Re-reads an invitation, which is how the operator learns the visitor
    /// accepted: the widget's acceptance mints the call session, and the
    /// session id appearing here is the signal to go and join it.
    func invitation(id: String) async throws -> CallInvitation {
        let request = try makeRequest("GET", "/api/call-invitations/\(id)")
        return try await perform(request, as: CallInvitationResponse.self).invitation
    }

    private struct TokenBody: Encodable, Sendable {
        let participant_type: String
        let display_name: String?
    }

    /// Mints this operator's participant token for a call session.
    ///
    /// The same endpoint the operator console uses, with the same
    /// `participant_type`, so the phone and the desktop appear in the room as
    /// the same kind of participant with the same permissions.
    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken {
        let request = try makeRequest(
            "POST",
            "/api/calls/\(callSessionID)/token",
            body: TokenBody(participant_type: "operator", display_name: displayName)
        )
        return try await perform(request, as: CallToken.self)
    }

    /// Ends the call for everyone. Idempotent server-side, which matters: a
    /// hang-up that races the visitor's own hang-up must not turn into an
    /// error the operator sees.
    func hangUp(callSessionID: String) async throws {
        let request = try makeRequest("POST", "/api/calls/\(callSessionID)/hangup")
        try await performIgnoringBody(request)
    }

    // MARK: - Plan

    func entitlements(workspaceID: String) async throws -> Entitlements {
        let request = try makeRequest("GET", "/api/plans/workspace/\(workspaceID)/effective")
        return try await perform(request, as: Entitlements.self)
    }

    func inboxCounts(workspaceID: String, scope: String = "mine") async throws -> InboxCounts {
        let request = try makeRequest(
            "GET",
            "/api/conversations/inbox-tab-counts",
            query: [
                URLQueryItem(name: "workspace_id", value: workspaceID),
                URLQueryItem(name: "scope", value: scope),
            ]
        )
        return try await perform(request, as: InboxCounts.self)
    }

    // MARK: - Email inbox
    //
    // `/api/email-inbox` is not `/api/email`: the second is the outbound
    // transactional sender the platform has always had, and the first is this
    // — an actual mailbox, inbound and outbound, behind the workspace's
    // Gmail connection. The server keeps them apart deliberately; so does
    // this client.

    func emailThreads(workspaceID: String, search: String? = nil) async throws -> [EmailThreadSummary] {
        var query: [URLQueryItem] = [URLQueryItem(name: "limit", value: "50")]
        if let search, !search.isEmpty { query.append(URLQueryItem(name: "q", value: search)) }
        let request = try makeRequest("GET", "/api/email-inbox/\(workspaceID)/threads", query: query)
        return try await perform(request, as: EmailThreadsResponse.self).threads
    }

    func emailThread(workspaceID: String, threadID: String) async throws -> EmailThreadResponse {
        let request = try makeRequest("GET", "/api/email-inbox/\(workspaceID)/threads/\(threadID)")
        return try await perform(request, as: EmailThreadResponse.self)
    }

    private struct EmailReadBody: Encodable, Sendable { let is_read: Bool }

    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool) async throws {
        let request = try makeRequest(
            "POST", "/api/email-inbox/\(workspaceID)/threads/\(threadID)/read",
            body: EmailReadBody(is_read: isRead)
        )
        try await performIgnoringBody(request)
    }

    private struct EmailStarBody: Encodable, Sendable { let starred: Bool }

    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool) async throws {
        let request = try makeRequest(
            "POST", "/api/email-inbox/\(workspaceID)/threads/\(threadID)/star",
            body: EmailStarBody(starred: starred)
        )
        try await performIgnoringBody(request)
    }

    private struct EmailSendBody: Encodable, Sendable {
        let thread_id: String?
        let to: [String]
        let subject: String
        let text_body: String
    }

    func sendEmail(
        workspaceID: String,
        threadID: String?,
        to: [String],
        subject: String,
        body: String
    ) async throws {
        let request = try makeRequest(
            "POST", "/api/email-inbox/\(workspaceID)/send",
            body: EmailSendBody(thread_id: threadID, to: to, subject: subject, text_body: body)
        )
        try await performIgnoringBody(request)
    }

    /// Whose mailbox this is, or nil when none is connected.
    ///
    /// A failure here is not an error state: the thread list is the screen,
    /// and the address is a caption on it.
    func gmailConnection(workspaceID: String) async throws -> GmailConnection? {
        let request = try makeRequest(
            "GET", "/api/plugins/gmail/connection",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        return try await perform(request, as: GmailConnectionResponse.self).connection
    }

    // MARK: - Channel inboxes

    /// The messaging channels this workspace can actually work in.
    ///
    /// Read from the plugin catalog rather than from entitlements, because a
    /// channel being *in the plan* and a channel being *installed and
    /// connected* are different questions and only the second one belongs in
    /// a switcher. The console builds its "Other inboxes" list from the same
    /// call.
    func channelInboxes(workspaceID: String) async throws -> [ChannelInbox] {
        let request = try makeRequest(
            "GET", "/api/plugins/catalog",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        let response = try await perform(request, as: PluginCatalogResponse.self)
        return (response.items ?? [])
            .filter(\.isUsableInbox)
            .compactMap(\.slug)
            .map(ChannelInbox.init(key:))
    }

    // MARK: - Colleagues

    func colleagues(workspaceID: String) async throws -> ColleaguesResponse {
        let request = try makeRequest(
            "GET", "/api/team-chat/colleagues",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        return try await perform(request, as: ColleaguesResponse.self)
    }

    func teamThread(workspaceID: String, peerID: String) async throws -> TeamThreadResponse {
        let request = try makeRequest(
            "GET", "/api/team-chat/thread",
            query: [
                URLQueryItem(name: "workspace_id", value: workspaceID),
                URLQueryItem(name: "peer_id", value: peerID),
            ]
        )
        return try await perform(request, as: TeamThreadResponse.self)
    }

    private struct TeamMessageBody: Encodable, Sendable {
        let workspace_id: String
        let recipient_id: String
        let body: String
        let attachment_id: String?
    }

    func sendTeamMessage(
        workspaceID: String,
        recipientID: String,
        body: String,
        attachmentID: String?
    ) async throws {
        let request = try makeRequest(
            "POST", "/api/team-chat/messages",
            body: TeamMessageBody(
                workspace_id: workspaceID,
                recipient_id: recipientID,
                body: body,
                attachment_id: attachmentID
            )
        )
        try await performIgnoringBody(request)
    }

    private struct TeamReadBody: Encodable, Sendable {
        let workspace_id: String
        let peer_id: String
    }

    // MARK: - Canned responses

    func cannedResponses(
        workspaceID: String, locale: String, query: String
    ) async throws -> [CannedResponse] {
        var items = [
            URLQueryItem(name: "workspace_id", value: workspaceID),
            URLQueryItem(name: "locale", value: locale),
            URLQueryItem(name: "limit", value: "50"),
        ]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.append(URLQueryItem(name: "q", value: trimmed)) }

        let request = try makeRequest("GET", "/api/canned-responses", query: items)
        return try await perform(request, as: CannedResponsesResponse.self).items
    }

    private struct TrackUseBody: Encodable, Sendable {
        let workspace_id: String
    }

    func trackCannedResponseUse(id: String, workspaceID: String) async throws {
        let request = try makeRequest(
            "POST", "/api/canned-responses/\(id)/track-use",
            body: TrackUseBody(workspace_id: workspaceID)
        )
        try await performIgnoringBody(request)
    }

    func markTeamThreadRead(workspaceID: String, peerID: String) async throws {
        let request = try makeRequest(
            "POST", "/api/team-chat/read",
            body: TeamReadBody(workspace_id: workspaceID, peer_id: peerID)
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Availability

    func availability() async throws -> AvailabilityResponse {
        let request = try makeRequest("GET", "/api/availability")
        return try await perform(request, as: AvailabilityResponse.self)
    }

    func updateAvailability(_ update: AvailabilityUpdate) async throws -> AvailabilityResponse {
        let request = try makeRequest("PATCH", "/api/availability", body: update)
        return try await perform(request, as: AvailabilityResponse.self)
    }

    // MARK: - Promotions

    func promotions(workspaceID: String, locale: String) async throws -> Promotions {
        let request = try makeRequest(
            "GET", "/api/mobile-app/promotions",
            query: [
                URLQueryItem(name: "workspace_id", value: workspaceID),
                URLQueryItem(name: "locale", value: locale),
            ]
        )
        return try await perform(request, as: Promotions.self)
    }

    private struct ClaimBody: Encodable, Sendable {
        let workspace_id: String
    }

    /// Takes ownership of a thread so the rest of the team can see it is
    /// handled.
    func claim(conversationID: String, workspaceID: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/conversations/\(conversationID)/claim",
            body: ClaimBody(workspace_id: workspaceID)
        )
        try await performIgnoringBody(request)
    }

    private struct VisitorIntelBody: Encodable, Sendable {
        let workspace_id: String
        var conversation_ids: [String]?
        var contact_ids: [String]?
    }

    /// Fetches the visitor device and location behind a page of conversations.
    ///
    /// Batched on purpose — one request per page, never one per row — and the
    /// result is decorative: the inbox renders fine without it, so callers
    /// treat a failure as "no extra detail" rather than as an error.
    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile] {
        let ids = Array(Set(conversationIDs.filter { !$0.isEmpty })).prefix(500)
        guard !ids.isEmpty else { return [:] }

        let request = try makeRequest(
            "POST",
            "/api/visitor-intel/network/batch",
            body: VisitorIntelBody(workspace_id: workspaceID, conversation_ids: Array(ids))
        )
        return try await perform(request, as: VisitorIntelResponse.self).byConversation ?? [:]
    }

    /// The same read, keyed by contact instead.
    ///
    /// Contacts have no conversation to key on, and the rule that a visitor's
    /// avatar shows their operating system and their flag cannot hold on one
    /// screen and not another. Same endpoint, same server-side privacy policy
    /// — the console's Contacts page reads it exactly this way.
    func visitorIntel(workspaceID: String, contactIDs: [String]) async throws -> [String: VisitorProfile] {
        let ids = Array(Set(contactIDs.filter { !$0.isEmpty })).prefix(500)
        guard !ids.isEmpty else { return [:] }

        let request = try makeRequest(
            "POST",
            "/api/visitor-intel/network/batch",
            body: VisitorIntelBody(workspace_id: workspaceID, contact_ids: Array(ids))
        )
        return try await perform(request, as: VisitorIntelResponse.self).byContact ?? [:]
    }

    // MARK: - Account

    func account() async throws -> Account {
        let request = try makeRequest("GET", "/api/account/me")
        return try await perform(request, as: Account.self)
    }

    private struct ProfileBody: Encodable, Sendable {
        let full_name: String?
        let preferred_locale: String?
    }

    func updateProfile(fullName: String?, preferredLocale: String?) async throws -> Account {
        let request = try makeRequest(
            "PATCH",
            "/api/account/me",
            body: ProfileBody(full_name: fullName, preferred_locale: preferredLocale)
        )
        try await performIgnoringBody(request)
        return try await account()
    }

    private struct AvatarBody: Encodable, Sendable {
        let data: String
        let contentType: String
        let fileName: String?
    }

    /// Uploads a new profile photo.
    ///
    /// The endpoint takes base64 in a JSON body rather than multipart, which
    /// is why the image is re-encoded before sending rather than streamed.
    func uploadAvatar(imageData: Data, contentType: String, fileName: String?) async throws -> AccountProfile? {
        let request = try makeRequest(
            "POST",
            "/api/account/avatar",
            body: AvatarBody(
                data: imageData.base64EncodedString(),
                contentType: contentType,
                fileName: fileName
            )
        )
        return try await perform(request, as: AccountAvatarResponse.self).profile
    }

    /// The bytes behind one attachment.
    ///
    /// Streams through the server rather than from storage: a provider URL
    /// never reaches a client, and the route re-checks workspace membership
    /// per call from the attachment's own row.
    func attachmentData(id: String) async throws -> Data {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let request = try makeRequest("GET", "/api/conversation-attachments/\(escaped)/file")
        return try await performData(request)
    }

    /// The same bytes, straight to a file rather than into memory.
    ///
    /// For video and documents, which can be tens of megabytes: a download
    /// task writes as it receives, so the file never has to fit in memory
    /// first. The file is moved out of URLSession's own temporary location
    /// before this returns, and the caller owns it from there.
    func attachmentFile(id: String) async throws -> URL {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let request = try makeRequest("GET", "/api/conversation-attachments/\(escaped)/file")
        let location: URL
        let response: URLResponse
        do {
            (location, response) = try await session.download(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.transport
        }
        defer { try? FileManager.default.removeItem(at: location) }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.server(status: http.statusCode, message: nil)
        }
        let owned = FileManager.default.temporaryDirectory
            .appendingPathComponent("webyar-download-\(UUID().uuidString)")
        do {
            try FileManager.default.moveItem(at: location, to: owned)
        } catch {
            throw APIError.transport
        }
        return owned
    }

    func deleteAvatar() async throws {
        let request = try makeRequest("DELETE", "/api/account/avatar")
        try await performIgnoringBody(request)
    }

    func sessions() async throws -> AccountSessionsResponse {
        let request = try makeRequest("GET", "/api/account/security/sessions")
        return try await perform(request, as: AccountSessionsResponse.self)
    }

    func revokeSession(id: String) async throws {
        let request = try makeRequest("DELETE", "/api/account/security/sessions/\(id)")
        try await performIgnoringBody(request)
    }

    private struct PasswordBody: Encodable, Sendable {
        let currentPassword: String
        let newPassword: String
    }

    func changePassword(current: String, new: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/account/change-password",
            body: PasswordBody(currentPassword: current, newPassword: new)
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Notifications

    private struct DeviceBody: Encodable, Sendable {
        let platform = "ios"
        /// Not "fcm". The server reads this to decide whether `push_token`
        /// addresses Firebase or Apple, and it defaults to Firebase for every
        /// client that predates this app.
        let transport = "apns"
        let push_token: String
        let device_id: String
        let device_name: String
        let app_version: String
        let permission_status: String
        let workspace_id: String?
    }

    private struct DeviceIDBody: Encodable, Sendable {
        let device_id: String
    }

    func registerPushDevice(
        token: String,
        deviceID: String,
        deviceName: String,
        appVersion: String,
        permission: String,
        workspaceID: String?
    ) async throws -> PushRegistration {
        let request = try makeRequest(
            "POST",
            "/api/push/devices",
            body: DeviceBody(
                push_token: token,
                device_id: deviceID,
                device_name: deviceName,
                app_version: appVersion,
                permission_status: permission,
                workspace_id: workspaceID
            )
        )
        return try await perform(request, as: PushRegistration.self)
    }

    func unregisterPushDevice(deviceID: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/push/devices/unregister",
            body: DeviceIDBody(device_id: deviceID)
        )
        try await performIgnoringBody(request)
    }

    private struct PasswordOnlyBody: Encodable, Sendable {
        let password: String
    }

    private struct DeletionRefusal: Decodable, Sendable {
        let error: String
        let workspaces: [String]?
    }

    /// Its own response handling rather than `perform`, because the one
    /// answer this screen most needs to show — "you still own these
    /// workspaces" — arrives as a 409 with a list in it, and `perform` turns
    /// every non-2xx into a thrown `APIError` with the list discarded.
    func deleteAccount(password: String) async throws -> AccountDeletion {
        let request = try makeRequest("DELETE", "/api/account", body: PasswordOnlyBody(password: password))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }

        if (200..<300).contains(http.statusCode) { return .deleted }
        if http.statusCode == 401 { throw APIError.unauthorized }

        if http.statusCode == 409,
           let refusal = try? decoder.decode(DeletionRefusal.self, from: data),
           refusal.error == "owns_workspaces" {
            return .blockedByOwnedWorkspaces(refusal.workspaces ?? [])
        }

        let message = (try? decoder.decode(DeletionRefusal.self, from: data))?.error
        throw APIError.server(status: http.statusCode, message: message)
    }

    /// The phone's own preferences, named as such.
    ///
    /// Without the surface the server answers with the browser's row — which
    /// is what it did when there was only one, and is why turning push off
    /// here also turned off the operator's desk.
    func notificationPrefs() async throws -> NotificationPrefs {
        let request = try makeRequest(
            "GET",
            "/api/notifications/prefs?platform=\(NotificationPrefs.surface)"
        )
        return try await perform(request, as: NotificationPrefsResponse.self).prefs
    }

    func updateNotificationPrefs(_ prefs: NotificationPrefs) async throws -> NotificationPrefs {
        let request = try makeRequest("PATCH", "/api/notifications/prefs", body: PrefsPatch(prefs: prefs))
        return try await perform(request, as: NotificationPrefsResponse.self).prefs
    }

    /// The preference fields plus the surface they belong to, in one flat
    /// object — which is the shape the endpoint reads.
    ///
    /// Encoding both into the same keyed container rather than nesting is
    /// what keeps `NotificationPrefs` a description of the settings and
    /// nothing else: the surface is a fact about the client, not a setting.
    private struct PrefsPatch: Encodable {
        let prefs: NotificationPrefs

        private enum SurfaceKey: String, CodingKey { case platform }

        func encode(to encoder: Encoder) throws {
            try prefs.encode(to: encoder)
            var container = encoder.container(keyedBy: SurfaceKey.self)
            try container.encode(NotificationPrefs.surface, forKey: .platform)
        }
    }

    // MARK: - Human guidance (operator → AI, private)

    /// Take the conversation off the AI and onto this operator.
    ///
    /// Two paths because the server grew a canonical one and kept the old:
    /// `/api/conversations/:id/take-over` is current, and the AI-agent route
    /// is what older deployments answer. The web client falls back the same
    /// way, and a 404 is the only error that earns the second attempt —
    /// anything else is a real failure and must not be retried into a
    /// second, differently-shaped refusal.
    func takeOverConversation(conversationID: String, workspaceID: String) async throws {
        let body = TakeOverBody(workspaceId: workspaceID, assign_to_me: true)
        do {
            try await performIgnoringBody(
                try makeRequest("POST", "/api/conversations/\(conversationID)/take-over", body: body)
            )
        } catch APIError.server(status: 404, message: _) {
            try await performIgnoringBody(
                try makeRequest("POST", "/api/ai-agent/conversations/\(conversationID)/take-over", body: body)
            )
        }
    }

    /// Operator dictation the AI rewrites and sends to the visitor now.
    ///
    /// This is the whole of what the phone does with the AI on a thread it
    /// owns. The console's private-guidance calls are deliberately not here:
    /// nothing on iOS reaches them, and an API method with no caller reads
    /// like a live path to whoever finds it next.
    func aiSayNow(
        conversationID: String,
        body: String,
        voice: SayNowVoice
    ) async throws {
        let request = try makeRequest(
            "POST",
            "/api/ai-agent/conversations/\(conversationID)/ai-say-now",
            // The server's field is still `attribution`; only the app's name
            // for it changed, and renaming the wire format to match would be
            // a server change for a label.
            body: SayNowBody(body: body, attribution: voice.rawValue)
        )
        try await performIgnoringBody(request)
    }

    private struct TakeOverBody: Encodable, Sendable {
        let workspaceId: String
        let assign_to_me: Bool
    }


    private struct SayNowBody: Encodable, Sendable {
        let body: String
        let attribution: String
    }


    // MARK: - Contacts

    func contacts(workspaceID: String) async throws -> [Contact] {
        let request = try makeRequest(
            "GET",
            "/api/contacts",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        return try await perform(request, as: ContactsResponse.self).contacts
    }
}

/// The inbox queues, expressed the way the API wants them.
///
/// Two of these are plan-gated, so the set an operator actually sees is
/// decided by `available(for:)` rather than by `allCases`.
enum InboxFilter: String, CaseIterable, Identifiable, Sendable {
    case open
    case needsHuman
    case pending
    case ai
    case resolved
    case spam

    var id: String { rawValue }

    var queue: String {
        switch self {
        case .open, .needsHuman, .pending, .resolved: "main"
        case .ai: "automated"
        case .spam: "spam"
        }
    }

    var status: String? {
        switch self {
        case .open, .needsHuman: "open"
        // The main queue narrowed to threads the customer owes us a reply
        // on — the same `status=pending` the console's tab sends.
        case .pending: "pending"
        case .resolved: "resolved"
        case .ai, .spam: nil
        }
    }

    /// What this queue is called where it names the screen rather than a chip.
    ///
    /// The main queue is simply "the inbox" in that position — nobody calls
    /// the screen they land on "Open".
    func headerTitle(_ language: Language) -> String {
        self == .open ? Str.tabInbox(language) : title(language)
    }

    var icon: String {
        switch self {
        case .open: "tray"
        case .needsHuman: "person.wave.2"
        case .pending: "hourglass"
        case .ai: "sparkles"
        case .resolved: "checkmark.circle"
        case .spam: "exclamationmark.octagon"
        }
    }

    /// Narrows Main Inbox to threads the AI has handed back.
    var needsHumanOnly: Bool { self == .needsHuman }

    func title(_ language: Language) -> String {
        switch self {
        case .open: Str.filterOpen(language)
        case .needsHuman: Str.filterNeedsHuman(language)
        case .pending: Str.filterPending(language)
        case .ai: Str.filterAI(language)
        case .resolved: Str.filterResolved(language)
        case .spam: Str.filterSpam(language)
        }
    }

    /// Which queues this workspace's plan actually includes.
    ///
    /// Open and Resolved are core and always present. The AI queue and the
    /// needs-human queue are features an operator either has or does not, and
    /// showing a tab that returns nothing because the plan excludes it reads
    /// as a broken app rather than as an upsell.
    static func available(for entitlements: Entitlements?) -> [InboxFilter] {
        var filters: [InboxFilter] = [.open]
        if entitlements?.featureEnabled("inbox_needs_human") == true { filters.append(.needsHuman) }
        // Every plan can put a thread on hold for the customer, so this one
        // is core like Open and Resolved rather than an entitlement.
        filters.append(.pending)
        if entitlements?.featureEnabled("inbox_ai_queue") == true { filters.append(.ai) }
        filters.append(.resolved)
        filters.append(.spam)
        return filters
    }

    /// The two queues that stay on the strip above the list.
    ///
    /// The rest moved into the menu behind the screen's own title, which is
    /// where the console keeps them too: its top strip carries Open and AI
    /// and its sidebar carries the whole list. Four chips across a phone left
    /// no room for the counts, and two of them — Resolved and the AI handover
    /// queue — are places you go now and then rather than switch between all
    /// day.
    static func chips(for entitlements: Entitlements?) -> [InboxFilter] {
        var filters: [InboxFilter] = [.open]
        if entitlements?.featureEnabled("inbox_ai_queue") == true { filters.append(.ai) }
        return filters
    }
}

/// Timestamps arrive from Postgres in more than one shape — with and without
/// fractional seconds, occasionally with a space instead of `T`. Rather than
/// let one variant break an entire response, every known form is tried.
enum DateParsing {
    // `nonisolated(unsafe)` because the compiler cannot see what Apple
    // documents: date formatters are thread-safe for formatting and parsing
    // on iOS 7 and later. Nothing here mutates them after construction, so
    // sharing one instance is both safe and considerably cheaper than
    // building a formatter for every timestamp in a response.
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // `DateFormatter` is itself marked `Sendable`, unlike its ISO8601
    // counterpart, so this one needs no annotation.
    private static let postgres: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSSSSSZZZZZ"
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        if let d = withFraction.date(from: raw) { return d }
        if let d = plain.date(from: raw) { return d }
        if let d = postgres.date(from: raw) { return d }
        // Postgres writes however many fractional digits the value needs —
        // real rows in this database carry 3, 5 and 6 — and
        // ISO8601DateFormatter is documented for milliseconds. Rather than
        // depend on how tolerant it happens to be, truncate the fraction to
        // three digits and try once more. Losing sub-millisecond precision on
        // a chat timestamp costs nothing; failing to parse it drops the whole
        // response.
        if let truncated = truncatingFraction(raw), let d = withFraction.date(from: truncated) { return d }
        return nil
    }

    /// Rewrites `…:15.008353+00:00` as `…:15.008+00:00`, leaving anything
    /// without an over-long fractional part untouched.
    private static func truncatingFraction(_ raw: String) -> String? {
        guard let dot = raw.firstIndex(of: ".") else { return nil }

        let afterDot = raw.index(after: dot)
        var end = afterDot
        while end < raw.endIndex, raw[end].isNumber {
            end = raw.index(after: end)
        }

        let digitCount = raw.distance(from: afterDot, to: end)
        guard digitCount > 3 else { return nil }

        let keepUntil = raw.index(afterDot, offsetBy: 3)
        return String(raw[..<keepUntil]) + String(raw[end...])
    }
}
