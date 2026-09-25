import Foundation

/// What the workspace's plan lets this operator see — the same snapshot the
/// web console reads (/api/plans/workspace/:id/effective), where the super
/// admin switches features, modules and channels on and off per plan. The
/// rules copy the web sidebar and the other native apps: while it loads
/// nothing gated shows; if it cannot be fetched at all, nothing is hidden.
/// The plan is the one source of what the app offers: Super Admin's plans
/// switch it, the same as on the web; nothing else takes away from it.
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

    var voiceCalls: Bool { call("voice") }
    var videoCalls: Bool { call("video") }

    var attachments: Bool { feature("widget_attachments") }
    var voiceNotes: Bool { feature("widget_voice_notes") }
    /// Files on outgoing mail go with the mailbox itself.
    var emailAttachments: Bool { emailInbox }
    var emoji: Bool { feature("widget_emoji") }

    var contacts: Bool { moduleInPlan("contacts") }
    var visitors: Bool { moduleInPlan("visitor_tracking") }
    var callCenter: Bool { moduleInPlan("call_center") && callCenterVisible != false }
    /// Recordings of calls, where the plan keeps them.
    var callRecordings: Bool { feature("call_recording") }
    var teamChat: Bool { inboxCap("inbox_team_chat") }
    /// Website analytics, as the web sidebar shows it: owners and admins, when the plan has the module.
    var webAnalytics: Bool { isAdmin && moduleInPlan("web_analytics") }
    /// The mailbox, as the web sidebar shows it: owners and admins, when the plan has it.
    var emailInbox: Bool { isAdmin && moduleInPlan("email_inbox") }

    /// A channel's inbox (Telegram, WhatsApp, Bale…): the plan's omnichannel module, and that channel not off.
    func channelInbox(_ key: String) -> Bool {
        switch state {
        case .failed: return true
        case .loading: return false
        case .loaded:
            return moduleInPlan("omnichannel") && (Self.lookup(channels, key.lowercased()) ?? nil) != false
        }
    }
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
