import Foundation

/// What the workspace's plan lets this operator see — the same snapshot the
/// web console reads (/api/plans/workspace/:id/effective), where the super
/// admin switches features, modules and channels on and off per plan — by the
/// web's one rule (src/lib/planAccess.ts): a capability is available only when
/// the snapshot is in and says exactly true. While it loads, or when it cannot
/// be read, nothing gated shows (the server would refuse it anyway) and the app
/// asks again soon; a key the snapshot does not carry is not available.
/// The composer's tools (files, voice notes, emoji) are not the plan's to hide:
/// the widget_* keys govern the customer-facing website widget, not operators.
struct WorkspacePlan: Sendable, Equatable {
    enum State: Sendable { case loading, loaded, failed }

    var state: State
    var planName: String?
    /// owner, admin, agent… from /api/workspaces/:id/role.
    var role: String?
    /// /api/ai-agent/capabilities: the AI agent is on for this workspace.
    var aiAgentEnabled: Bool?
    /// /api/ai-agent/capabilities: Super Admin shows the AI agent to customers.
    var aiCustomerVisible: Bool?
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

    func with(role: String?, aiAgent: Bool?, aiAuto: Bool?, callCenter: Bool?, aiVisible: Bool? = nil) -> WorkspacePlan {
        var p = self
        p.role = role ?? self.role
        p.aiAgentEnabled = aiAgent ?? aiAgentEnabled
        p.aiCustomerVisible = aiVisible ?? aiCustomerVisible
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

    /// The web's rule: on only when the plan is loaded and says exactly true for the key.
    private func on(_ map: [String: Bool?], _ key: String) -> Bool {
        guard state == .loaded, let v = Self.lookup(map, key) else { return false }
        return v == true
    }

    /// A plan module (contacts, call_center…).
    func moduleInPlan(_ key: String) -> Bool { on(modules, key) }

    /// A plan feature (inbox_team_chat, call_recording…).
    func feature(_ key: String) -> Bool { on(features, key) }

    private func channelInPlan(_ key: String) -> Bool { on(channels, key) }

    /// Calls, as the web's SidebarCallCard: the Voice & Video module and the call's channel.
    private func call(_ channel: String) -> Bool { moduleInPlan("voice_video") && channelInPlan(channel) }

    var voiceCalls: Bool { call("voice") }
    var videoCalls: Bool { call("video") }

    /// Files on outgoing mail go with the mailbox itself.
    var emailAttachments: Bool { emailInbox }

    var contacts: Bool { moduleInPlan("contacts") }
    var visitors: Bool { moduleInPlan("visitor_tracking") }
    /// The call center: in the plan and switched on for this workspace (unknown is off).
    var callCenter: Bool { moduleInPlan("call_center") && callCenterVisible == true }
    /// Recordings of calls, where the plan keeps them.
    var callRecordings: Bool { feature("call_recording") }
    /// The colleagues queue (the web's colleaguesQueueVisible).
    var teamChat: Bool { feature("inbox_team_chat") }
    /// Website analytics, as the web sidebar shows it: owners and admins, when the plan has the module.
    var webAnalytics: Bool { isAdmin && moduleInPlan("web_analytics") }
    /// The mailbox, as the web sidebar shows it: owners and admins, when the plan has it.
    var emailInbox: Bool { isAdmin && moduleInPlan("email_inbox") }

    /// Channel keys the plan itself governs; the others are decided by the plugin's own plan check.
    private static let planChannels: Set<String> = [
        "chat_widget", "email", "whatsapp", "sms", "instagram", "telegram", "bale", "gmail", "yahoomail", "voice", "video",
    ]

    /// A channel's inbox (Telegram, WhatsApp, Bale…), as the web's channelInboxVisible: a channel
    /// the plan governs must be on in the loaded plan; any other one is the plugin catalog's call
    /// (its planAllowed, applied where the catalog is read).
    func channelInbox(_ key: String) -> Bool {
        let k = key.lowercased()
        return !Self.planChannels.contains(k) || channelInPlan(k)
    }

    /// The needs-human queue (the web's needsHumanQueueVisible).
    var needsHumanQueue: Bool { feature("inbox_needs_human") }

    /// The AI queue (the web's aiQueueVisible): in the plan, the AI switched on and shown to
    /// customers (unknown is off), and either answering by itself or already holding threads.
    func aiQueue(automated: Int?) -> Bool {
        feature("inbox_ai_queue") && aiAgentEnabled == true && aiCustomerVisible == true
            && (aiAutoAnswer == true || (automated ?? 0) > 0)
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
