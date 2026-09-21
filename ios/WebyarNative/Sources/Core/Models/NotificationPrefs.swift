import Foundation

/// What the operator has said should reach their phone.
///
/// The server owns this, not the device. `server/services/push/recipients.ts`
/// reads the same row before it sends, so turning something off here stops
/// the notification being SENT rather than hiding it once it has arrived.
/// That distinction is the whole point: a preference the phone enforces does
/// not survive reinstalling the app, does not apply to the operator's other
/// devices, and still wakes the phone up in the night.
///
/// Only the fields this screen owns are listed. The row carries email
/// preferences too, and a `PATCH` that named them would overwrite choices
/// made in the web console — so the encoder sends these and nothing else.
struct NotificationPrefs: Codable, Equatable, Sendable {

    /// Which conversations are worth a notification at all.
    enum Scope: String, Codable, CaseIterable, Identifiable, Sendable {
        /// Everything in the workspace.
        case all
        /// Threads assigned to this operator. An @mention still gets through.
        case assigned
        /// Only an explicit @mention.
        case mentions
        /// Nothing, without turning the master switch off.
        case none

        var id: String { rawValue }
    }

    /// The master switch. Nothing is sent while this is on, whatever the rest
    /// of the row says.
    var disableAll: Bool = false
    var pushScope: Scope = .all
    /// Whether the message itself appears on the lock screen.
    ///
    /// Off means the server composes a bare "new message" banner and the text
    /// never leaves it — rather than the app receiving the text and choosing
    /// not to draw it, which would be theatre on a locked phone.
    var pushPreview: Bool = true
    var pushInternalNotes: Bool = true
    var playSound: Bool = true

    var quietHoursEnabled: Bool = false
    /// "HH:mm", 24-hour. The server's own regex.
    var quietHoursStart: String?
    var quietHoursEnd: String?
    /// IANA identifier. The phone knows it; the server cannot guess it.
    var quietHoursTimezone: String?

    enum CodingKeys: String, CodingKey {
        case disableAll = "disable_all"
        case pushScope = "push_scope"
        case pushPreview = "push_preview"
        case pushInternalNotes = "push_internal_notes"
        case playSound = "play_sound"
        case quietHoursEnabled = "quiet_hours_enabled"
        case quietHoursStart = "quiet_hours_start"
        case quietHoursEnd = "quiet_hours_end"
        case quietHoursTimezone = "quiet_hours_timezone"
    }

    init() {}

    /// Every field optional on the way in.
    ///
    /// The endpoint merges the row over a table of defaults and has always
    /// returned all of these — but a deployment one migration behind returns
    /// a row without `push_scope`, and a settings screen that throws rather
    /// than showing a sensible default would be a worse answer to that than
    /// simply showing the default.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        disableAll = try c.decodeIfPresent(Bool.self, forKey: .disableAll) ?? false
        pushScope = try c.decodeIfPresent(Scope.self, forKey: .pushScope) ?? .all
        pushPreview = try c.decodeIfPresent(Bool.self, forKey: .pushPreview) ?? true
        pushInternalNotes = try c.decodeIfPresent(Bool.self, forKey: .pushInternalNotes) ?? true
        playSound = try c.decodeIfPresent(Bool.self, forKey: .playSound) ?? true
        quietHoursEnabled = try c.decodeIfPresent(Bool.self, forKey: .quietHoursEnabled) ?? false
        quietHoursStart = try c.decodeIfPresent(String.self, forKey: .quietHoursStart)
        quietHoursEnd = try c.decodeIfPresent(String.self, forKey: .quietHoursEnd)
        quietHoursTimezone = try c.decodeIfPresent(String.self, forKey: .quietHoursTimezone)
    }
}

struct NotificationPrefsResponse: Decodable, Sendable {
    let prefs: NotificationPrefs
}

/// What the server says about this device once it has been registered.
struct PushRegistration: Decodable, Sendable {
    /// Whether the platform has credentials for this device's transport at
    /// all. False means nothing will ever arrive, however the operator sets
    /// their preferences — worth saying out loud rather than leaving them to
    /// conclude the app is broken.
    let pushEnabled: Bool
    /// Whether a call can ring this phone.
    let voipEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case pushEnabled = "push_enabled"
        case voipEnabled = "voip_enabled"
    }
}

/// What came back from asking to delete the account.
///
/// Not an error for the blocked case: `workspaces.owner_id` cascades, so
/// deleting an owner would take the company's whole workspace — every
/// conversation, contact and invoice in it — with them. The server refuses,
/// and the operator needs to be told which workspaces to hand over rather
/// than shown a failure.
enum AccountDeletion: Equatable, Sendable {
    case deleted
    case blockedByOwnedWorkspaces([String])
}
