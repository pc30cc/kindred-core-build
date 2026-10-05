import Foundation

/// One capability's resolved state, and where the value came from.
struct EffectiveState<Value: Codable & Sendable>: Codable, Sendable {
    let value: Value?
    let source: String?
    let note: String?
}

/// The plan snapshot for a workspace: what this account is actually entitled to.
///
/// Mirrors `GET /api/plans/workspace/:id/effective`. Only the buckets the app
/// gates on are decoded; the plan and usage objects the admin console needs
/// are left alone.
struct Entitlements: Codable, Sendable {
    let workspaceId: String?
    let features: [String: EffectiveState<Bool>]?
    let modules: [String: EffectiveState<Bool>]?
    let channels: [String: EffectiveState<Bool>]?
    let limits: [String: EffectiveState<Int>]?
    let plan: PlanSummary?

    struct PlanSummary: Codable, Sendable {
        let slug: String?
        let name: String?
        let tier: String?
    }

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case features, modules, channels, limits, plan
    }

    // MARK: - Gates
    //
    // The web console's one rule (src/lib/planAccess.ts): a capability is
    // available only when its value is exactly `true`. A key the snapshot does
    // not carry is not available — the server sends every key it knows and
    // denies the ones it does not.

    /// Whether a top-level section belongs in this plan.
    func moduleInPlan(_ key: String) -> Bool {
        modules?[key]?.value == true
    }

    /// Whether a capability is actually granted. Fail-closed: a missing key or
    /// an unresolved lookup is never treated as enabled.
    func moduleEnabled(_ key: String) -> Bool {
        modules?[key]?.value == true
    }

    /// Fail-closed, for individual features inside a section.
    func featureEnabled(_ key: String) -> Bool {
        features?[key]?.value == true
    }

    func channelEnabled(_ key: String) -> Bool {
        channels?[key]?.value == true
    }

    /// Channel keys the plan itself governs; any other channel inbox is decided
    /// by the plugin's own plan check (the catalog's `planAllowed`).
    static let planChannels: Set<String> = [
        "chat_widget", "email", "whatsapp", "sms", "instagram", "telegram", "bale", "gmail", "yahoomail", "voice", "video",
    ]

    func limit(_ key: String) -> Int? {
        limits?[key]?.value
    }
}

/// How far the plan snapshot has got.
///
/// The distinction between `loading` and `failed` is what stops a plan-gated
/// tab from appearing for a moment and then disappearing: nothing gated is
/// rendered until this resolves either way.
enum EntitlementsState: Sendable {
    case loading
    case loaded(Entitlements)
    case failed

    var value: Entitlements? {
        if case .loaded(let entitlements) = self { return entitlements }
        return nil
    }

    var isResolved: Bool {
        switch self {
        case .loading: false
        case .loaded, .failed: true
        }
    }
}

/// What the operator's role and the platform's switches add to the plan — the
/// web's `SectionContext` (src/hooks/useWorkspaceSections.ts), read alongside
/// the snapshot the way the desktop apps read it.
///
/// Each value is nil until it is read, and stays nil when it cannot be read:
/// both hide what depends on it (fail closed), because every gate asks for
/// exactly `true`.
struct WorkspaceAccess: Sendable, Equatable {
    /// owner, admin, agent… from `GET /api/workspaces/:id/role`.
    var role: String?
    /// `GET /api/ai-agent/capabilities`: the AI agent is on for this workspace.
    var aiAgentEnabled: Bool?
    /// The same: Super Admin shows the AI agent to this workspace's customers.
    var aiCustomerVisible: Bool?
    /// The same: the AI answers visitors by itself.
    var aiAutoAnswer: Bool?
    /// `GET /api/call-center/capabilities`: `workspace_call_center_visible`.
    var callCenterVisible: Bool?

    static let unknown = WorkspaceAccess()

    /// Owners and admins: the web's admin-only sections (the mailbox, the
    /// other inboxes…) are theirs alone.
    var isAdmin: Bool { role == "owner" || role == "admin" }

    /// The web's `aiQueueVisible`, given the plan's `inbox_ai_queue`: the AI
    /// switched on and shown to customers, and either answering by itself or
    /// already holding threads.
    func aiQueueVisible(inPlan: Bool, automated: Int?) -> Bool {
        inPlan && aiAgentEnabled == true && aiCustomerVisible == true
            && (aiAutoAnswer == true || (automated ?? 0) > 0)
    }
}

/// `GET /api/workspaces/:id/role`.
struct WorkspaceRoleResponse: Decodable, Sendable {
    let role: String?
}

/// `GET /api/ai-agent/capabilities` — the flags under `capabilities`, or at the
/// top level on a server that sends them flat. A value of the wrong kind reads
/// as unknown rather than failing the whole answer.
struct AICapabilitiesResponse: Decodable, Sendable {
    let aiAgentEnabled: Bool?
    let customerAIAgentVisible: Bool?
    let autoAnswerEnabled: Bool?

    private enum Keys: String, CodingKey {
        case capabilities
        case aiAgentEnabled = "ai_agent_enabled"
        case customerAIAgentVisible = "customer_ai_agent_visible"
        case autoAnswerEnabled = "auto_answer_enabled"
    }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let flags = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .capabilities)) ?? root
        aiAgentEnabled = try? flags.decodeIfPresent(Bool.self, forKey: .aiAgentEnabled)
        customerAIAgentVisible = try? flags.decodeIfPresent(Bool.self, forKey: .customerAIAgentVisible)
        autoAnswerEnabled = try? flags.decodeIfPresent(Bool.self, forKey: .autoAnswerEnabled)
    }
}

/// `GET /api/call-center/capabilities`.
struct CallCenterCapabilitiesResponse: Decodable, Sendable {
    let workspaceCallCenterVisible: Bool?

    private enum Keys: String, CodingKey {
        case workspaceCallCenterVisible = "workspace_call_center_visible"
    }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        workspaceCallCenterVisible = try? root.decodeIfPresent(Bool.self, forKey: .workspaceCallCenterVisible)
    }
}
