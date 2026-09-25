import Foundation
@testable import WebyarNative

/// Every `WebyarAPI` requirement, answered with "no connection" — so a test
/// double states only the handful of calls its test is about (`TestAPI`).
/// Generated from the protocol: a requirement added there without a line
/// here fails the test build, never a test.
protocol TestAPIBase: WebyarAPI {}

extension TestAPIBase {
    var hasToken: Bool { get async { true } }
    func logIn(email: String, password: String) async throws -> User { throw APIError.transport }
    func currentUser() async throws -> User { throw APIError.transport }
    func logOut() async throws { throw APIError.transport }
    func discardSession() async {}
    func requestPasswordReset(email: String, locale: String) async throws { throw APIError.transport }
    func workspaces() async throws -> [Workspace] { throw APIError.transport }
    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation] { throw APIError.transport }
    func conversations(workspaceID: String, filter: InboxFilter, etag: String?) async throws -> ListPage { throw APIError.transport }
    func conversation(id: String) async throws -> Conversation? { throw APIError.transport }
    func messages(conversationID: String) async throws -> [Message] { throw APIError.transport }
    func messagePage(conversationID: String, since: String?) async throws -> ThreadPage { throw APIError.transport }
    func realtimeConnect(workspaceID: String, intent: String) async throws -> RealtimeConnect { throw APIError.transport }
    func realtimeInboxSubscribe(workspaceID: String) async throws -> RealtimeSubscribe { throw APIError.transport }
    func send(body: String, conversationID: String, workspaceID: String, clientMessageID: String, attachmentID: String?) async throws { throw APIError.transport }
    func uploadAttachment(conversationID: String?, workspaceID: String, fileName: String, mimeType: String, data: Data) async throws -> String { throw APIError.transport }
    func markSeen(conversationID: String) async throws { throw APIError.transport }
    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws { throw APIError.transport }
    func takeOverConversation(conversationID: String, workspaceID: String) async throws { throw APIError.transport }
    func aiSayNow(conversationID: String, body: String, voice: SayNowVoice) async throws { throw APIError.transport }
    func claim(conversationID: String, workspaceID: String) async throws { throw APIError.transport }
    func inboxCounts(workspaceID: String, scope: String) async throws -> InboxCounts { throw APIError.transport }
    func emailThreads(workspaceID: String, search: String?) async throws -> [EmailThreadSummary] { throw APIError.transport }
    func emailThread(workspaceID: String, threadID: String) async throws -> EmailThreadResponse { throw APIError.transport }
    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool) async throws { throw APIError.transport }
    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool) async throws { throw APIError.transport }
    func sendEmail(workspaceID: String, threadID: String?, to: [String], subject: String, body: String) async throws { throw APIError.transport }
    func gmailConnection(workspaceID: String) async throws -> GmailConnection? { throw APIError.transport }
    func channelInboxes(workspaceID: String) async throws -> [ChannelInbox] { throw APIError.transport }
    func colleagues(workspaceID: String) async throws -> ColleaguesResponse { throw APIError.transport }
    func teamThread(workspaceID: String, peerID: String) async throws -> TeamThreadResponse { throw APIError.transport }
    func sendTeamMessage(workspaceID: String, recipientID: String, body: String, attachmentID: String?) async throws { throw APIError.transport }
    func markTeamThreadRead(workspaceID: String, peerID: String) async throws { throw APIError.transport }
    func cannedResponses(workspaceID: String, locale: String, query: String) async throws -> [CannedResponse] { throw APIError.transport }
    func trackCannedResponseUse(id: String, workspaceID: String) async throws { throw APIError.transport }
    func availability() async throws -> AvailabilityResponse { throw APIError.transport }
    func updateAvailability(_ update: AvailabilityUpdate) async throws -> AvailabilityResponse { throw APIError.transport }
    func promotions(workspaceID: String, locale: String) async throws -> Promotions { throw APIError.transport }
    func refreshOrigin() async {}
    func contacts(workspaceID: String) async throws -> [Contact] { throw APIError.transport }
    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile] { throw APIError.transport }
    func visitorIntel(workspaceID: String, contactIDs: [String]) async throws -> [String: VisitorProfile] { throw APIError.transport }
    func updateConversation(conversationID: String, workspaceID: String, status: ConversationStatus?, priority: ConversationPriority?, assignedTo: String??, tags: [String]?) async throws { throw APIError.transport }
    func workspaceMembers(workspaceID: String) async throws -> [WorkspaceMember] { throw APIError.transport }
    func notes(conversationID: String, workspaceID: String) async throws -> [ConversationNote] { throw APIError.transport }
    func addNote(conversationID: String, workspaceID: String, body: String) async throws { throw APIError.transport }
    func deleteNote(conversationID: String, workspaceID: String, noteID: String) async throws { throw APIError.transport }
    func inviteToCall(conversationID: String, workspaceID: String, channel: CallChannel) async throws -> CallInvitation { throw APIError.transport }
    func cancelInvitation(id: String) async throws { throw APIError.transport }
    func invitation(id: String) async throws -> CallInvitation { throw APIError.transport }
    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken { throw APIError.transport }
    func hangUp(callSessionID: String) async throws { throw APIError.transport }
    func entitlements(workspaceID: String) async throws -> Entitlements { throw APIError.transport }
    func account() async throws -> Account { throw APIError.transport }
    func updateProfile(fullName: String?, preferredLocale: String?) async throws -> Account { throw APIError.transport }
    func uploadAvatar(imageData: Data, contentType: String, fileName: String?) async throws -> AccountProfile? { throw APIError.transport }
    func attachmentData(id: String) async throws -> Data { throw APIError.transport }
    func attachmentFile(id: String) async throws -> URL { throw APIError.transport }
    func deleteAvatar() async throws { throw APIError.transport }
    func sessions() async throws -> AccountSessionsResponse { throw APIError.transport }
    func revokeSession(id: String) async throws { throw APIError.transport }
    func changePassword(current: String, new: String) async throws { throw APIError.transport }
    func registerPushDevice(token: String, deviceID: String, deviceName: String, appVersion: String, permission: String, workspaceID: String?) async throws -> PushRegistration { throw APIError.transport }
    func unregisterPushDevice(deviceID: String) async throws { throw APIError.transport }
    func deleteAccount(password: String) async throws -> AccountDeletion { throw APIError.transport }
    func notificationPrefs() async throws -> NotificationPrefs { throw APIError.transport }
    func updateNotificationPrefs(_ prefs: NotificationPrefs) async throws -> NotificationPrefs { throw APIError.transport }
}
