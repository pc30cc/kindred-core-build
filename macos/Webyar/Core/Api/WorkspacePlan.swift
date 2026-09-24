import Foundation

/// What the workspace's plan lets this operator see — the same snapshot the
/// web console reads (/api/plans/workspace/:id/effective), where the super
/// admin switches features, modules and channels on and off per plan. The
/// rules copy the web sidebar and the other native apps: while it loads
/// nothing gated shows; if it cannot be fetched at all, nothing is hidden.
/// Super Admin → macOS app's switches are ANDed on top (`limited(to:)`):
/// they only ever take away.
struct WorkspacePlan: Sendable, Equatable {
    enum State: Sendable { case loading, loaded, failed }

    var state: State
    var planName: String?
    /// owner, admin, agent… from /api/workspaces/:id/role.
    var role: String?
    /// /api/ai-agent/capabilities: the AI agent is on for this workspace.
    var aiAgentEnabled: Bool?
    /// /api/ai-agent/capabilities: the AI answers visitors by itself.
    var aiAutoAnswer: Bool?
    /// /api/call-center/capabilities: workspace_call_center_visible.
    var callCenterVisible: Bool?

    private var features: [String: Bool?] = [:]
    private var modules: [String: Bool?] = [:]
    private var channels: [String: Bool?] = [:]
    /// The platform's switches for the Mac app.
    private(set) var platform = MacAppConfig.Features.all

    static let loading = WorkspacePlan(state: .loading)
    static let failed = WorkspacePlan(state: .failed)

    init(state: State) { self.state = state }

    var isAdmin: Bool { role == "owner" || role == "admin" }

    static func parse(_ root: JSONValue) -> WorkspacePlan {
        var p = WorkspacePlan(state: .loaded)
        p.features = flags(root["features"])
        p.modules = flags(root["modules"])
        p.channels = flags(root["channels"])
        if let plan = root["plan"], plan.object != nil { p.planName = plan["name"]?.string ?? plan["slug"]?.string }
        return p
    }

    /// This plan with the Mac app's platform switches applied.
    func limited(to features: MacAppConfig.Features) -> WorkspacePlan {
        var p = self
        p.platform = features
        return p
    }

    func with(role: String?, aiAgent: Bool?, aiAuto: Bool?, callCenter: Bool?) -> WorkspacePlan {
        var p = self
        p.role = role ?? self.role
        p.aiAgentEnabled = aiAgent ?? aiAgentEnabled
        p.aiAutoAnswer = aiAuto ?? aiAutoAnswer
        p.callCenterVisible = callCenter ?? callCenterVisible
        return p
    }

    /// Flag lookup by the server's own key; the decoder may have camel-cased it.
    private static func lookup(_ map: [String: Bool?], _ key: String) -> Bool?? {
        if let v = map[key] { return .some(v) }
        if let v = map[JSONValue.camel(key)] { return .some(v) }
        return .none
    }

    /// The web's moduleInPlan: hidden while loading; shown when the key is absent or on.
    func moduleInPlan(_ key: String) -> Bool {
        switch state {
        case .failed: return true
        case .loading: return false
        case .loaded:
            guard let v = Self.lookup(modules, key) else { return true }
            return v == true
        }
    }

    /// A plan feature (widget_attachments, inbox_team_chat…).
    func feature(_ key: String) -> Bool {
        switch state {
        case .failed: return true
        case .loading: return false
        case .loaded:
            guard let v = Self.lookup(features, key) else { return true }
            return v == true
        }
    }

    /// The inbox's inboxCapAllowed: features[key] ?? modules[key], allowed unless false.
    func inboxCap(_ key: String) -> Bool {
        switch state {
        case .failed: return true
        case .loading: return false
        case .loaded:
            let f = Self.lookup(features, key)
            let v: Bool? = f != nil ? f! : (Self.lookup(modules, key) ?? nil)
            return v != false
        }
    }

    /// Calls, as the web's SidebarCallCard: voice_video not off, and the channel not off.
    private func call(_ channel: String) -> Bool {
        switch state {
        case .failed: return true
        case .loading: return false
        case .loaded:
            let vv = Self.lookup(modules, "voice_video") ?? nil
            let c = Self.lookup(channels, channel) ?? nil
            return vv != false && c != false
        }
    }

    var voiceCalls: Bool { platform.calls && call("voice") }
    var videoCalls: Bool { platform.calls && platform.videoCalls && call("video") }

    var attachments: Bool { platform.attachments && feature("widget_attachments") }
    var voiceNotes: Bool { platform.voiceNotes && feature("widget_voice_notes") }
    /// Files on outgoing mail: the platform's switch alone — widget_attachments is the chat widget's.
    var emailAttachments: Bool { platform.attachments }
    var emoji: Bool { feature("widget_emoji") }

    var contacts: Bool { platform.contacts && moduleInPlan("contacts") }
    var visitors: Bool { platform.visitors && moduleInPlan("visitor_tracking") }
    /// The desk answers calls, so it goes with them.
    var callCenter: Bool { platform.callCenter && platform.calls && moduleInPlan("call_center") && callCenterVisible != false }
    var teamChat: Bool { platform.colleagues && inboxCap("inbox_team_chat") }
    /// The mailbox, as the web sidebar shows it: owners and admins, when the plan has it.
    var emailInbox: Bool { platform.email && isAdmin && moduleInPlan("email_inbox") }
    var needsHumanQueue: Bool { inboxCap("inbox_needs_human") }

    /// The AI queue: the plan's AI surface, and the AI answering (or something already in it).
    func aiQueue(automated: Int?) -> Bool {
        inboxCap("inbox_ai_queue") && aiAgentEnabled != false && (aiAutoAnswer != false || (automated ?? 0) > 0)
    }

    private static func flags(_ group: JSONValue?) -> [String: Bool?] {
        var map: [String: Bool?] = [:]
        guard let obj = group?.object else { return map }
        for (name, raw) in obj {
            var v = raw
            if v.object != nil { v = v["value"] ?? .null }
            map[name] = v.bool
        }
        return map
    }
}
