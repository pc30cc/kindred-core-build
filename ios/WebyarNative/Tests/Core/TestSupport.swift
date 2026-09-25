import Foundation
import XCTest
@testable import WebyarNative

/// A fixed moment the tests' timestamps are measured from.
let t0 = Date(timeIntervalSince1970: 1_790_000_000)

func msg(
    _ id: String,
    at seconds: Double,
    updated: Double? = nil,
    sender: SenderType = .contact,
    senderID: String? = nil,
    name: String? = nil,
    clientID: String? = nil,
    conversation: String = "c1",
    body: String = "hi"
) -> Message {
    Message(
        id: id, conversationId: conversation, senderType: sender, senderId: senderID, body: body,
        createdAt: t0.addingTimeInterval(seconds), updatedAt: updated.map { t0.addingTimeInterval($0) },
        senderName: name, senderAvatar: nil,
        metadata: clientID.map { ["client_message_id": .string($0)] }
    )
}

func conversation(_ id: String, workspace: String = "w1", unread: Int = 0, status: String = "open") throws -> Conversation {
    let json = #"{"id":"\#(id)","workspace_id":"\#(workspace)","status":"\#(status)","unread_count":\#(unread),"#
        + #""contacts":{"name":"Visitor \#(id)","email":null,"avatar_url":null,"visitor_code":null}}"#
    return try StoreCoding.decoder().decode(Conversation.self, from: Data(json.utf8))
}

/// A folder of its own for each test, removed afterwards.
func temporaryFolder() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Waits (briefly) for something asynchronous to become true.
@MainActor
func eventually(timeout: TimeInterval = 3, _ condition: @MainActor () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return await condition()
}

/// A scripted server: only what the tests ask for, counting every request.
/// Everything else in `WebyarAPI` answers "no connection" (`TestAPIBase`).
actor TestAPI: TestAPIBase {
    // Files
    var files: [String: Data] = [:]
    var failingFiles: Set<String> = []
    private(set) var dataCalls = 0
    private(set) var fileCalls = 0
    /// Nanoseconds each file read takes, to overlap concurrent readers.
    var fileDelay: UInt64 = 0

    // Threads
    /// What each thread read answers, in order; the last one repeats.
    var pages: [String: [ThreadPage]] = [:]
    var threadError: APIError?
    private(set) var threadReads: [(conversation: String, since: String?)] = []
    var threadDelay: UInt64 = 0

    // Lists
    var lists: [String: [Conversation]] = [:]
    var listETags: [String: String] = [:]
    var listError: APIError?
    private(set) var listReads: [(workspace: String, etag: String?)] = []
    var listDelays: [String: UInt64] = [:]

    // One conversation
    var single: [String: Conversation] = [:]
    private(set) var singleReads = 0

    // Sending
    private(set) var sentKeys: [String] = []
    /// Rows the "server" has, per conversation, added by `send`.
    private(set) var inserted: [String: [Message]] = [:]
    /// Fail the next sends: `.beforeInsert` never reaches the server,
    /// `.afterInsert` stores the message and then loses the answer.
    enum SendFailure: Sendable { case beforeInsert, afterInsert }
    var sendFailures: [SendFailure] = []
    var sendDelay: UInt64 = 0
    private(set) var seenMarks = 0

    func setFile(_ id: String, _ data: Data) { files[id] = data }
    func setFailing(_ id: String, _ failing: Bool) { if failing { failingFiles.insert(id) } else { failingFiles.remove(id) } }
    func setFileDelay(_ nanoseconds: UInt64) { fileDelay = nanoseconds }
    func setPages(_ conversationID: String, _ queue: [ThreadPage]) { pages[conversationID] = queue }
    func setThreadError(_ error: APIError?) { threadError = error }
    func setThreadDelay(_ nanoseconds: UInt64) { threadDelay = nanoseconds }
    func setList(_ workspaceID: String, _ conversations: [Conversation], etag: String? = nil) {
        lists[workspaceID] = conversations
        listETags[workspaceID] = etag
    }
    func setListError(_ error: APIError?) { listError = error }
    func setListDelay(_ workspaceID: String, _ nanoseconds: UInt64) { listDelays[workspaceID] = nanoseconds }
    func setSingle(_ conversation: Conversation) { single[conversation.id] = conversation }
    func setSendFailures(_ failures: [SendFailure]) { sendFailures = failures }
    func setSendDelay(_ nanoseconds: UInt64) { sendDelay = nanoseconds }
    var threadReadCount: Int { threadReads.count }
    var lastThreadSince: String?? { threadReads.last.map { $0.since } }
    var listReadCount: Int { listReads.count }
    var lastListETag: String?? { listReads.last.map { $0.etag } }

    func attachmentData(id: String) async throws -> Data {
        dataCalls += 1
        if fileDelay > 0 { try? await Task.sleep(nanoseconds: fileDelay) }
        if failingFiles.contains(id) { throw APIError.server(status: 502, message: nil) }
        guard let data = files[id] else { throw APIError.server(status: 404, message: nil) }
        return data
    }

    func attachmentFile(id: String) async throws -> URL {
        fileCalls += 1
        if fileDelay > 0 { try? await Task.sleep(nanoseconds: fileDelay) }
        if failingFiles.contains(id) { throw APIError.server(status: 502, message: nil) }
        guard let data = files[id] else { throw APIError.server(status: 404, message: nil) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("webyar-test-download-\(UUID().uuidString)")
        try data.write(to: url)
        return url
    }

    func messagePage(conversationID: String, since: String?) async throws -> ThreadPage {
        threadReads.append((conversationID, since))
        if threadDelay > 0 { try? await Task.sleep(nanoseconds: threadDelay) }
        if let threadError { throw threadError }
        var queue = pages[conversationID] ?? []
        var page = queue.first ?? ThreadPage(messages: [], delta: since != nil, cursor: since)
        if queue.count > 1 { queue.removeFirst(); pages[conversationID] = queue }
        // What `send` put on the server comes back on every read after it.
        let sent = inserted[conversationID] ?? []
        let ids = Set(page.messages.map(\.id))
        page.messages += sent.filter { !ids.contains($0.id) }
        return page
    }

    func conversations(workspaceID: String, filter: InboxFilter, etag: String?) async throws -> ListPage {
        listReads.append((workspaceID, etag))
        if let delay = listDelays[workspaceID] { try? await Task.sleep(nanoseconds: delay) }
        if let listError { throw listError }
        let tag = listETags[workspaceID]
        if let etag, etag == tag { return ListPage(conversations: nil, etag: tag) }
        return ListPage(conversations: lists[workspaceID] ?? [], etag: tag)
    }

    func conversation(id: String, workspaceID: String) async throws -> Conversation? {
        singleReads += 1
        return single[id].flatMap { $0.workspaceId == workspaceID ? $0 : nil }
    }

    func realtimeConnect(workspaceID: String, intent: String) async throws -> RealtimeConnect {
        RealtimeConnect(vendor: "disabled", wsURL: nil, token: nil, expiresAt: nil)
    }

    func realtimeInboxSubscribe(workspaceID: String) async throws -> RealtimeSubscribe {
        RealtimeSubscribe(vendor: "disabled", channel: nil, token: nil, expiresAt: nil)
    }

    func send(body: String, conversationID: String, workspaceID: String, clientMessageID: String, attachmentID: String?) async throws {
        sentKeys.append(clientMessageID)
        if sendDelay > 0 { try? await Task.sleep(nanoseconds: sendDelay) }
        let failure = sendFailures.isEmpty ? nil : sendFailures.removeFirst()
        if failure == .beforeInsert { throw APIError.transport }
        // The server collapses a replay of the same key.
        if !(inserted[conversationID] ?? []).contains(where: { $0.clientMessageID == clientMessageID }) {
            let row = Message(
                id: "srv-\(clientMessageID)", conversationId: conversationID, senderType: .agent, senderId: "me",
                body: body, createdAt: Date(), updatedAt: Date(), senderName: "Me", senderAvatar: nil,
                metadata: ["client_message_id": .string(clientMessageID)]
            )
            inserted[conversationID, default: []].append(row)
        }
        if failure == .afterInsert { throw APIError.transport }
    }

    func markSeen(conversationID: String) async throws {
        seenMarks += 1
    }

    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile] {
        [:]
    }

    func inboxCounts(workspaceID: String, scope: String) async throws -> InboxCounts {
        throw APIError.transport
    }
}
