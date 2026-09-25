// Compiled only into Debug builds.
#if DEBUG
import Foundation

/// A backend that answers from memory, for `WEBYAR_SAMPLE=1`.
///
/// It exists so every screen can be laid out, reviewed and screenshotted
/// without a live server or a real account. The content is deliberately
/// awkward — long names, mixed Persian and Latin in one thread, an empty
/// preview, a three-digit unread count — because a layout only proves itself
/// against the cases that break it.
final class SampleBackend: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var sent: [String: [[String: Any]]] = [:]
    nonisolated(unsafe) private static var notes: [String: [[String: Any]]] = [:]
    nonisolated(unsafe) private static var maintenanceOn = false
    nonisolated(unsafe) private static var callNotes: [String: [[String: Any]]] = [:]
    nonisolated(unsafe) private static var handedOn = false
    nonisolated(unsafe) private static var notesDownOn = false

    /// A visitor's message arriving in a conversation, for DebugTools' `visitor <id>`.
    static func visitorSays(_ conversationId: String, _ body: String) {
        lock.lock()
        sent[conversationId, default: []].append(["id": "visitor-\(UUID().uuidString)", "conversation_id": conversationId, "sender_type": "contact", "body": body, "created_at": ago(0)])
        lock.unlock()
    }

    /// A colleague handing a live call to this operator, for DebugTools' `handed`.
    static var handed: Bool {
        get { lock.lock(); defer { lock.unlock() }; return handedOn }
        set { lock.lock(); handedOn = newValue; lock.unlock() }
    }

    /// Adding a call note failing, for DebugTools' `notesdown on|off`.
    static var notesDown: Bool {
        get { lock.lock(); defer { lock.unlock() }; return notesDownOn }
        set { lock.lock(); notesDownOn = newValue; lock.unlock() }
    }

    /// Super Admin's maintenance switch, for DebugTools' `maintenance on|off`.
    static var maintenance: Bool {
        get { lock.lock(); defer { lock.unlock() }; return maintenanceOn }
        set { lock.lock(); maintenanceOn = newValue; lock.unlock() }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let path = url.path
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        var body: [String: Any] = [:]
        if let data = request.httpBody ?? request.httpBodyStream.flatMap(Self.read), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { body = obj }
        let (status, answer) = Self.answer(request.httpMethod ?? "GET", path, query, body)
        let data: Data
        if let raw = answer as? Data { data = raw } else { data = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{}".utf8) }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        // A little latency, so loading states show for a moment as they do for real.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    // MARK: Content

    private static func ago(_ minutes: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-minutes * 60))
    }

    static let user: [String: Any] = ["id": "u-1", "email": "operator@webyar.app", "fullName": "Sara Karimi", "emailVerified": true]

    private static let visitors: [(id: String, name: String?, email: String?, code: String, os: String, cc: String, country: String, city: String, region: String, lat: Double, lng: Double)] = [
        ("c-1", "مریم احمدی", "maryam@example.com", "4ZTK", "Mac OS X", "IR", "Iran", "Tehran", "Tehran", 35.69, 51.39),
        ("c-2", nil, nil, "Q7PM", "Windows 11", "DE", "Germany", "Berlin", "Berlin", 52.52, 13.40),
        ("c-3", "Alexander Konstantinopoulos-Richardson", "alex.k.richardson@verylongcompanyname-international.com", "HX2D", "Android 14", "GR", "Greece", "Athens", "Attica", 37.98, 23.73),
        ("c-4", "علی رضایی", nil, "B81Q", "iOS 18", "IR", "Iran", "Isfahan", "Isfahan", 32.65, 51.67),
        ("c-5", "Ayşe Yılmaz", "ayse@example.com.tr", "P3LA", "Linux", "TR", "Türkiye", "Istanbul", "Istanbul", 41.01, 28.98),
        ("c-6", nil, nil, "M0NT", "Windows 10", "AE", "UAE", "Dubai", "Dubai", 25.20, 55.27),
    ]

    private static func conversation(_ i: Int) -> [String: Any] {
        let v = visitors[i]
        let statuses = ["open", "open", "pending", "open", "resolved", "open"]
        let previews: [String] = [
            "سلام، سفارشم هنوز نرسیده. کد پیگیری 48213 است، می‌شه بررسی کنید؟",
            "",
            "Can I change the delivery address after I've already paid? It's urgent, I'm moving tomorrow morning.",
            "ممنون از راهنمایی 🙏",
            "Teşekkürler, sorun çözüldü!",
            "Hi, is there anyone there?",
        ]
        let unread = [3, 124, 0, 1, 0, 2]
        var contact: [String: Any] = ["visitor_code": v.code]
        if let n = v.name { contact["name"] = n }
        if let e = v.email { contact["email"] = e }
        var last: [String: Any] = ["body": previews[i], "created_at": ago(Double([2, 9, 45, 180, 3000, 1][i])), "sender_type": i == 3 ? "agent" : "contact"]
        if i == 1 { last["attachment_kind"] = "image"; last["sender_name"] = NSNull() }
        var c: [String: Any] = [
            "id": "conv-\(i + 1)", "workspace_id": "ws-1", "status": statuses[i], "contact_id": v.id,
            "contacts": contact, "last_message": last, "unread_count": unread[i],
            "created_at": ago(5000 - Double(i) * 300), "updated_at": ago(Double([2, 9, 45, 180, 3000, 1][i])),
            "priority": ["normal", "urgent", "high", "normal", "low", "normal"][i],
            "tags": i == 0 ? ["VIP", "ارسال"] : [],
        ]
        if i == 0 { c["assigned_to"] = "u-1" }
        if i == 2 { c["assigned_to"] = "u-2" }
        if i == 5 { c["metadata"] = ["ai_state": "ai_managed", "channel": "telegram"]; c["ai_state"] = "ai_managed" }
        if i == 3 { c["metadata"] = ["channel": "whatsapp"] }
        return c
    }

    private static func messages(_ id: String) -> [[String: Any]] {
        var list: [[String: Any]] = []
        func m(_ sender: String, _ body: String, _ minutes: Double, name: String? = nil, attachments: [[String: Any]]? = nil, meta: [String: Any]? = nil) {
            var x: [String: Any] = ["id": "\(id)-m\(list.count)", "conversation_id": id, "sender_type": sender, "body": body, "created_at": ago(minutes)]
            if sender == "agent" { x["sender_id"] = "u-1"; x["sender_name"] = name ?? "Sara Karimi" }
            if sender == "ai" { x["sender_name"] = name ?? "Webyar AI" }
            if let attachments { x["attachments"] = attachments }
            if let meta { x["metadata"] = meta }
            list.append(x)
        }
        switch id {
        case "conv-1":
            m("system", "Conversation assigned", 3000, meta: ["kind": "routing_agent_joined", "agent_name": "Sara Karimi"])
            m("contact", "سلام وقت بخیر", 2990)
            m("contact", "سفارشم هنوز نرسیده. کد پیگیری 48213 است، می‌شه بررسی کنید؟", 2989)
            m("agent", "سلام مریم جان، وقت شما هم بخیر 🌷 همین الان بررسی می‌کنم.", 2980)
            m("agent", "سفارش شما امروز صبح از انبار خارج شده و تا فردا ظهر به دستتان می‌رسد. Tracking: IR-48213-TH", 2978)
            m("contact", "", 60, attachments: [["id": "11111111-1111-1111-1111-111111111111", "file_name": "invoice-march.pdf", "mime_type": "application/pdf", "size_bytes": 248_331, "kind": "file"]])
            m("contact", "این فاکتور رو هم ببینید لطفاً، مبلغش با چیزی که پرداخت کردم فرق داره.", 59)
            m("system", "call", 30, meta: ["kind": "call_ended", "duration_seconds": 245, "ended_by": "operator"])
            m("contact", "ممنون، خیلی لطف کردید!", 2)
        case "conv-6":
            m("contact", "Hi, is there anyone there?", 12)
            m("ai", "Hello! I'm the Webyar assistant. How can I help you today?", 11)
            m("contact", "I want to know about your enterprise plan pricing", 3)
            m("ai", "Our Enterprise plan starts at $499/month and includes unlimited operators, the AI agent and the call center. Would you like me to connect you with a specialist?", 2)
        case "conv-2":
            for i in 0..<30 {
                m("contact", "Message \(i + 1) from the visitor — checking how a long thread scrolls.", Double(400 - i * 12))
                m("agent", "Reply \(i + 1): thanks, noted. Anything else I can help with?", Double(395 - i * 12))
            }
            m("contact", "Last one: can I change the delivery address after I've already paid?", 5)
        default:
            m("contact", "Hello 👋", 120)
            m("agent", "Hi! How can I help?", 118)
            m("contact", "Can I change the delivery address after I've already paid? It's urgent, I'm moving tomorrow morning.", 45)
        }
        lock.lock(); list += sent[id] ?? []; lock.unlock()
        return list
    }

    private static let members: [[String: Any]] = [
        ["id": "m-1", "user_id": "u-1", "role": "owner", "profile": ["full_name": "Sara Karimi", "email": "operator@webyar.app"]],
        ["id": "m-2", "user_id": "u-2", "role": "admin", "profile": ["full_name": "رضا محمدی", "email": "reza@webyar.app"]],
        ["id": "m-3", "user_id": "u-3", "role": "agent", "profile": ["full_name": "Emre Demir", "email": "emre@webyar.app"]],
        ["id": "m-4", "user_id": "u-4", "role": "agent", "profile": ["full_name": "نگار صالحی", "email": "negar@webyar.app"]],
    ]

    /// Super Admin → macOS app, as toPublicMacosAppConfig writes it: every
    /// switch on, the help links set, and a maintenance notice on demand.
    private static func macosApp() -> [String: Any] {
        let f = ISO8601DateFormatter()
        let until = Date().addingTimeInterval(90 * 60)
        return [
            "update": ["appcastUrl": "https://raw.githubusercontent.com/pc30cc/mac-os/main/appcast.xml",
                       "channel": "stable", "latestVersion": NSNull(), "minimumSupportedVersion": NSNull(), "blockedVersions": [String](),
                       "downloadUrl": NSNull(), "releaseNotes": NSNull(), "autoCheck": true, "autoDownload": true, "checkIntervalMinutes": 240],
            "realtime": ["enabled": false],
            "polling": ["intervalSeconds": 15, "withRealtimeSeconds": 120],
            "features": ["calls": true, "videoCalls": true, "email": true, "visitors": true, "callCenter": true,
                         "colleagues": true, "contacts": true, "voiceNotes": true, "attachments": true],
            "system": ["menuBarExtra": true, "launchAtLogin": true, "dockBadge": true, "notifications": true],
            "defaults": ["language": "system", "appearance": "system", "closeToMenuBar": true, "launchAtLogin": false],
            "maintenance": [
                "enabled": maintenance,
                "message": [
                    "fa": "در حال ارتقای سرورهای وب‌یار هستیم تا سرعت و پایداری بیشتری داشته باشید. پیام‌های بازدیدکنندگان ذخیره می‌شوند و پس از پایان کار نمایش داده خواهند شد.",
                    "en": "We are upgrading Webyar's servers for more speed and stability. Visitor messages are being kept and will appear as soon as we are done.",
                    "tr": "Daha fazla hız ve kararlılık için Webyar sunucularını yükseltiyoruz. Ziyaretçi mesajları saklanıyor ve iş biter bitmez görünecek.",
                ],
                "until": f.string(from: until),
            ],
            "links": ["support": "https://webyar.app/support", "status": "https://status.webyar.app",
                      "privacy": "https://webyar.app/privacy", "terms": "https://webyar.app/terms"],
        ]
    }

    // MARK: Website analytics

    private static func webAnalytics(_ report: String, _ q: [String: String]) -> (Int, Any) {
        func rows(_ list: [(String, Int)]) -> [String: Any] {
            ["rows": list.map { ["key": $0.0, "label": $0.0, "sessions": $0.1, "pageviews": $0.1 * 3] }, "truncated": false]
        }
        switch report {
        case "live-visitors": return (200, ["count": 12])
        case "overview":
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyy-MM-dd"
            let end = q["endDate"].flatMap(f.date) ?? Date()
            let start = q["startDate"].flatMap(f.date) ?? end.addingTimeInterval(-27 * 86_400)
            let days = max(1, Int(end.timeIntervalSince(start) / 86_400) + 1)
            let trend: [[String: Any]] = (0..<days).map { i in
                let d = start.addingTimeInterval(Double(i) * 86_400)
                let weekday = Calendar(identifier: .gregorian).component(.weekday, from: d)
                // Grows with the calendar, so a range reads a little better than the one before it.
                let n = Double(Int(d.timeIntervalSince1970 / 86_400) % 1000)
                let base = 60 + n * 0.9 + 90 * sin(n / 2.3) + (weekday == 6 || weekday == 7 ? -110 : 0)
                let sessions = Int(max(40, base))
                return ["date": f.string(from: d), "sessions": sessions, "pageviews": Int(Double(sessions) * (2.6 + 0.4 * cos(Double(i) / 3)))]
            }
            let sessions = trend.reduce(0) { $0 + ($1["sessions"] as? Int ?? 0) }
            let pageviews = trend.reduce(0) { $0 + ($1["pageviews"] as? Int ?? 0) }
            return (200, [
                "sessions": sessions, "pageviews": pageviews, "uniqueVisitors": Int(Double(sessions) * 0.71),
                "avgPagesPerSession": Double(pageviews) / Double(max(1, sessions)), "bounceRate": 38 + Double(days % 5) + Double(Int(start.timeIntervalSince1970 / 86_400) % 3),
                "avgVisitDurationSeconds": 150 + Int(start.timeIntervalSince1970 / 86_400) % 40,
                "trend": trend,
                "topChannels": [
                    ["key": "organic_search", "label": "Organic Search", "sessions": sessions * 44 / 100, "pageviews": 0],
                    ["key": "direct", "label": "Direct", "sessions": sessions * 27 / 100, "pageviews": 0],
                    ["key": "organic_social", "label": "Organic Social", "sessions": sessions * 13 / 100, "pageviews": 0],
                    ["key": "referral", "label": "Referral", "sessions": sessions * 9 / 100, "pageviews": 0],
                    ["key": "email", "label": "Email", "sessions": sessions * 4 / 100, "pageviews": 0],
                ],
                "topPages": [["path": "/", "views": pageviews * 31 / 100], ["path": "/pricing", "views": pageviews * 18 / 100], ["path": "/blog/ai-support", "views": pageviews * 11 / 100],
                             ["path": "/docs/install", "views": pageviews * 7 / 100], ["path": "/checkout", "views": pageviews * 5 / 100]],
                "truncated": false,
            ])
        case "traffic-sources":
            switch q["dimension"] {
            case "source": return (200, rows([("google", 5120), ("(direct)", 3140), ("instagram.com", 1210), ("t.me", 820), ("linkedin.com", 410), ("bing", 260), ("newsletter", 190)]))
            case "campaign": return (200, rows([("yalda-sale", 1340), ("spring-launch", 880), ("webinar-ai", 420), ("(unknown)", 9120)]))
            default: return (200, rows([("organic_search", 5380), ("direct", 3140), ("organic_social", 1620), ("referral", 1080), ("email", 470), ("paid_search", 310), ("paid_social", 150)]))
            }
        case "geography":
            switch q["dimension"] {
            case "city": return (200, rows([("Tehran", 4210), ("Istanbul", 1530), ("Mashhad", 980), ("Isfahan", 760), ("Berlin", 420), ("Shiraz", 390), ("Tabriz", 310)]))
            case "language": return (200, rows([("fa-IR", 7420), ("tr-TR", 1790), ("en-US", 1310), ("de-DE", 460), ("ar", 180)]))
            default: return (200, rows([("Iran", 7630), ("Turkey", 1790), ("Germany", 610), ("United States", 540), ("United Arab Emirates", 330), ("Canada", 210), ("(unknown)", 140)]))
            }
        case "browsers-systems":
            switch q["dimension"] {
            case "device": return (200, rows([("desktop", 6120), ("mobile", 4880), ("tablet", 250)]))
            case "os": return (200, rows([("Windows", 4730), ("Android", 3210), ("iOS", 1720), ("macOS", 1260), ("Linux", 310)]))
            default: return (200, rows([("Chrome", 7150), ("Safari", 1980), ("Firefox", 830), ("Edge", 790), ("Samsung Internet", 360)]))
            }
        case "pages":
            let list: [(String, Int)]
            switch q["kind"] {
            case "entry": list = [("/", 4820), ("/blog/ai-support", 1730), ("/pricing", 1210), ("/fa/landing/yalda", 940), ("/docs/install", 520)]
            case "exit": list = [("/checkout", 1830), ("/pricing", 1440), ("/", 1320), ("/contact", 610), ("/docs/install", 420)]
            default: list = [("/", 11_240), ("/pricing", 6530), ("/blog/ai-support", 3980), ("/docs/install", 2610), ("/checkout", 1840), ("/contact", 1120), ("/blog/very-long-article-about-customer-support-automation-in-2026", 640)]
            }
            return (200, ["rows": list.map { ["path": $0.0, "views": $0.1] }, "truncated": false])
        case "events":
            return (200, ["rows": [
                ["eventName": "chat_started", "count": 1840, "uniqueSessions": 1610, "conversionRate": 0.142],
                ["eventName": "signup_submit", "count": 612, "uniqueSessions": 598, "conversionRate": 0.053],
                ["eventName": "pricing_cta_click", "count": 1290, "uniqueSessions": 1020, "conversionRate": 0.09],
                ["eventName": "call_requested", "count": 214, "uniqueSessions": 208, "conversionRate": 0.018],
                ["eventName": "purchase", "count": 96, "uniqueSessions": 94, "conversionRate": 0.0083],
            ], "truncated": false])
        default: return (404, ["error": "not found"])
        }
    }

    // MARK: Routing

    private static func answer(_ method: String, _ path: String, _ q: [String: String], _ body: [String: Any]) -> (Int, Any) {
        let parts = path.split(separator: "/").map(String.init) // ["api", ...]
        switch (method, path) {
        case ("GET", "/api/platform/origins"): return (200, [String: Any]())
        case ("GET", "/api/platform/macos-app"): return (200, macosApp())
        case ("GET", "/api/auth/session"): return (200, ["user": user])
        case ("POST", "/api/auth/login"): return (200, ["sessionToken": "sample", "user": user])
        case ("GET", "/api/workspaces"):
            return (200, ["workspaces": [["id": "ws-1", "name": "Webyar Support", "slug": "support"], ["id": "ws-2", "name": "فروشگاه نمونه", "slug": "shop"]]])
        case ("GET", "/api/account/me"): return (200, ["id": "u-1", "email": "operator@webyar.app", "profile": ["full_name": "Sara Karimi"]])
        case ("GET", "/api/availability"), ("PATCH", "/api/availability"):
            let off = body["force_offline"] as? Bool ?? false
            return (200, ["prefs": ["force_offline": off], "status": ["state": off ? "offline" : "online"]])
        case ("GET", "/api/ai-agent/capabilities"): return (200, ["capabilities": ["ai_agent_enabled": true, "auto_answer_enabled": true]])
        case ("GET", "/api/call-center/capabilities"): return (200, ["workspace_call_center_visible": true])
        case ("GET", "/api/conversations/inbox-counts"): return (200, ["main": 5, "automated": 1, "needs_human": 2, "spam": 0])
        case ("GET", "/api/conversations/inbox-tab-counts"): return (200, ["open": 4, "pending": 1, "resolved": 1])
        case ("GET", "/api/plugins/catalog"):
            return (200, ["items": [["slug": "telegram", "installed": true, "supports_inbox": true], ["slug": "whatsapp", "installed": true, "supportsInbox": true]]])
        case ("GET", "/api/workspace-members"): return (200, ["members": members])
        case ("GET", "/api/notifications/prefs"): return (200, ["prefs": ["push_scope": "all"]])
        case ("POST", "/api/realtime/operator-connect"): return (200, ["vendor": "none"])
        case ("GET", "/api/conversations"):
            let all = (0..<visitors.count).map(conversation)
            let list: [[String: Any]]
            switch (q["queue"], q["status"]) {
            case ("automated", _): list = all.filter { ($0["ai_state"] as? String) == "ai_managed" }
            case ("spam", _): list = []
            case (_, let status?): list = all.filter { ($0["status"] as? String) == status && ($0["ai_state"] == nil || status != "open") }
            default: list = all
            }
            return (200, ["conversations": list])
        case ("POST", "/api/visitor-intel/network/batch"):
            var byConversation: [String: Any] = [:], byContact: [String: Any] = [:], bySession: [String: Any] = [:]
            for (i, v) in visitors.enumerated() {
                let p: [String: Any] = ["geo": ["country_code": v.cc, "country": v.country, "city": v.city, "region": v.region], "device": ["os": v.os, "browser": "Chrome"]]
                byConversation["conv-\(i + 1)"] = p
                byContact[v.id] = p
                bySession[String(format: "00000000-0000-4000-8000-%012d", i + 1)] = p
            }
            return (200, ["by_conversation": byConversation, "by_contact": byContact, "by_session": bySession])
        case ("POST", "/api/conversations/spam"), ("POST", "/api/conversations/not-spam"):
            return (200, ["ok": true, "conversation_ids": [body["conversation_id"] ?? ""], "contact_id": NSNull()])
        case ("POST", "/api/conversations/send-message"):
            let id = body["conversation_id"] as? String ?? ""
            lock.lock()
            sent[id, default: []].append(["id": "sent-\(UUID().uuidString)", "conversation_id": id, "sender_type": "agent", "sender_id": "u-1", "sender_name": "Sara Karimi", "body": body["body"] as? String ?? "", "created_at": ago(0)])
            lock.unlock()
            return (200, ["ok": true])
        case ("GET", "/api/canned-responses"):
            return (200, ["items": [
                ["id": "cr-1", "shortcut": "/hi", "title": "خوش‌آمدگویی", "body": "سلام! به وب‌یار خوش آمدید. چطور می‌توانم کمکتان کنم؟"],
                ["id": "cr-2", "shortcut": "/ship", "title": "Shipping times", "body": "Orders ship within 24 hours and arrive in 2–4 business days."],
            ]])
        case ("GET", "/api/contacts"):
            return (200, ["contacts": visitors.map { v -> [String: Any] in
                var c: [String: Any] = ["id": v.id, "workspace_id": "ws-1", "visitor_code": v.code, "created_at": ago(9000), "updated_at": ago(60)]
                if let n = v.name { c["name"] = n }
                if let e = v.email { c["email"] = e }
                if v.id == "c-1" { c["phone"] = "+98 912 345 6789"; c["metadata"] = ["company": "دیجی‌کالا"]; c["tags"] = ["VIP"] }
                return c
            }])
        case ("GET", "/api/team-chat/colleagues"):
            return (200, ["me": "u-1", "total_unread": 3, "colleagues": [
                ["user_id": "u-2", "role": "admin", "full_name": "رضا محمدی", "email": "reza@webyar.app", "unread": 2, "last_message": ["body": "جلسه ساعت ۴ یادت نره", "created_at": ago(15), "outgoing": false]],
                ["user_id": "u-3", "role": "agent", "full_name": "Emre Demir", "email": "emre@webyar.app", "unread": 1, "last_message": ["body": "Can you take the Berlin visitor?", "created_at": ago(40), "outgoing": false]],
                ["user_id": "u-4", "role": "agent", "full_name": "نگار صالحی", "email": "negar@webyar.app", "last_message": ["body": "باشه، ممنون", "created_at": ago(600), "outgoing": true]],
            ]])
        case ("GET", "/api/team-chat/thread"):
            let peer = q["peer_id"] ?? "u-2"
            return (200, ["me": "u-1", "messages": [
                ["id": "t1", "sender_id": peer, "recipient_id": "u-1", "body": "سلام سارا، یک لحظه وقت داری؟", "created_at": ago(20)],
                ["id": "t2", "sender_id": "u-1", "recipient_id": peer, "body": "سلام! بله بفرما", "created_at": ago(18), "read_at": ago(17)],
                ["id": "t3", "sender_id": peer, "recipient_id": "u-1", "body": "جلسه ساعت ۴ یادت نره", "created_at": ago(15)],
            ]])
        case ("GET", "/api/call-center/queue"):
            return (200, ["queue": [
                ["id": "q-1", "call_session_id": "cs-1", "state": "waiting", "channel": "voice", "priority": 1, "created_at": ago(1.5),
                 "visitor_session_id": "00000000-0000-4000-8000-000000000002",
                 "call_session": ["id": "cs-1", "state": "ringing", "call_type": "voice", "visitor_session_id": "00000000-0000-4000-8000-000000000002", "visitor_name": "Ayşe Yılmaz", "visitor_email": "ayse@example.com.tr", "page_title": "Pricing — Webyar", "created_at": ago(1.5)]],
                ["id": "q-2", "call_session_id": "cs-2", "state": "waiting", "channel": "video", "priority": 2, "created_at": ago(4),
                 "visitor_session_id": "00000000-0000-4000-8000-000000000099",
                 "call_session": ["id": "cs-2", "state": "ringing", "call_type": "video", "visitor_session_id": "00000000-0000-4000-8000-000000000099", "visitor_phone": "+49 30 1234567", "page_title": "Checkout", "created_at": ago(4)]],
            ]])
        case ("GET", "/api/call-center/overview"):
            return (200, ["today_calls": 38, "waiting_calls": 2, "active_calls": 1, "missed_today": 3, "callbacks_pending": 1, "provider": ["provider": "livekit", "ready": true]])
        case ("GET", "/api/call-center/agent-status"): return (200, ["agents": [["user_id": "u-1", "status": "available"]]])
        case ("GET", "/api/call-center/calls") where q["status"] == "active":
            guard handed else { return (200, ["calls": [[String: Any]]()]) }
            return (200, ["calls": [["id": "cs-7", "state": "active", "call_type": "video", "visitor_session_id": "00000000-0000-4000-8000-000000000004", "visitor_name": "Deniz Yılmaz", "visitor_email": "deniz@example.com",
                                     "assigned_agent_id": "u-1", "transfer_from_agent_id": "u-2", "transfer_reason": "مشکل پرداخت؛ نیاز به پیگیری مالی", "created_at": ago(3)]]])
        case ("GET", "/api/call-center/agents/presence"):
            return (200, ["presence": [
                ["user_id": "u-2", "status": "available", "active_call_count": 0, "full_name": "رضا محمدی"],
                ["user_id": "u-3", "status": "busy", "active_call_count": 1, "full_name": "Emre Demir"],
                ["user_id": "u-4", "status": "away", "active_call_count": 0, "full_name": "نگار صالحی"],
            ]])
        case ("GET", "/api/call-center/departments"):
            return (200, ["departments": [
                ["id": "d-1", "name": "فروش", "enabled": true, "cc_voice_enabled": true, "cc_video_enabled": true],
                ["id": "d-2", "name": "پشتیبانی فنی", "enabled": true, "cc_voice_enabled": true, "cc_video_enabled": true],
            ]])
        case ("POST", "/api/call-invitations"):
            // As the server does: the invitation also lands in the thread as a system message.
            let id = "inv-\(UUID().uuidString.prefix(8))"
            let conversation = body["conversation_id"] as? String ?? ""
            let channel = body["channel"] as? String ?? "audio"
            lock.lock()
            sent[conversation, default: []].append(["id": "sys-\(id)", "conversation_id": conversation, "sender_type": "system", "body": "You have been invited to a call.",
                                                    "metadata": ["kind": "call_invitation", "status": "pending", "channel": channel, "invitation_id": id, "operator_name": "Sara Karimi"],
                                                    "created_at": ago(0)])
            lock.unlock()
            return (200, ["invitation": ["id": id, "status": "pending", "channel": channel, "conversation_id": conversation, "expires_at": ago(-5)]])
        case ("GET", "/api/call-center/calls"):
            return (200, ["calls": [
                ["id": "cs-9", "state": "ended", "call_type": "voice", "visitor_session_id": "00000000-0000-4000-8000-000000000001", "visitor_name": "مریم احمدی", "created_at": ago(90), "duration_seconds": 312],
                ["id": "cs-8", "state": "missed", "call_type": "video", "visitor_email": "alex.k.richardson@verylongcompanyname-international.com", "created_at": ago(300)],
            ]])
        case ("GET", "/api/visitor-intel/live"):
            return (200, ["items": visitors.enumerated().map { i, v -> [String: Any] in
                var x: [String: Any] = ["id": "vs-\(i + 1)", "status": i % 3 == 2 ? "idle" : "online", "current_page": "https://webyar.ai/\(["pricing", "checkout", "blog/ai-support", "", "docs/install", "contact"][i])",
                                        "last_activity_at": ago(Double(i)), "started_at": ago(Double(i * 7 + 3)), "browser": "Chrome", "os": v.os, "device": i == 2 ? "Mobile" : "Desktop",
                                        "geo": ["country": v.country, "country_code": v.cc, "city": v.city, "region": v.region, "latitude": v.lat, "longitude": v.lng],
                                        "contact": ["id": v.id, "name": v.name.map { $0 as Any } ?? NSNull(), "visitor_code": v.code]]
                if i < 3 { x["conversation"] = ["id": "conv-\(i + 1)", "status": "open"] }
                return x
            }])
        case ("GET", "/api/desktop-app/campaigns"):
            return (200, ["campaigns": [["id": "ad-1", "kind": "ad", "placements": ["inbox_list"], "title": "Webyar AI 2.0", "body": "Let the AI agent answer the easy questions, day and night.", "cta_label": "See what's new", "cta_url": "https://webyar.ai", "dismissible": true]]])
        default:
            break
        }
        if path == "/api/plugins/gmail/connection" {
            return (200, ["connection": ["connected": true, "emailAddress": "support@webyar.ai", "status": "connected"]])
        }
        if parts.count >= 3, parts[1] == "email-inbox" {
            let threads: [[String: Any]] = [
                ["id": "e-1", "provider": "gmail", "subject": "سفارش ۴۸۲۱۳ — درخواست بازگشت وجه", "participants": [["email": "maryam@example.com", "name": "مریم احمدی"], ["email": "support@webyar.ai"]],
                 "lastMessageAt": ago(14), "isRead": false, "isStarred": true, "labels": ["INBOX", "UNREAD", "VIP"], "lastMessageSnippet": "سلام، فاکتور را پیوست کردم. لطفاً مبلغ اضافه را برگردانید."],
                ["id": "e-2", "provider": "gmail", "subject": "Enterprise plan — quote for 40 seats", "participants": [["email": "alex.k.richardson@verylongcompanyname-international.com", "name": "Alexander Konstantinopoulos-Richardson"], ["email": "cfo@verylongcompanyname-international.com", "name": "Dana Wu"], ["email": "support@webyar.ai"]],
                 "lastMessageAt": ago(95), "isRead": false, "isStarred": false, "labels": ["INBOX"], "lastMessageSnippet": "Could you send over a formal quote including the call center add-on and annual billing?"],
                ["id": "e-3", "provider": "gmail", "subject": "Fatura hakkında", "participants": ["ayse@example.com.tr", "support@webyar.ai"],
                 "lastMessageAt": ago(1500), "isRead": true, "isStarred": false, "labels": ["INBOX"], "lastMessageSnippet": "Teşekkürler, her şey yolunda."],
                ["id": "e-4", "provider": "gmail", "subject": "Your weekly Webyar report", "participants": [["email": "reports@webyar.ai", "name": "Webyar Reports"], ["email": "support@webyar.ai"]],
                 "lastMessageAt": ago(4000), "isRead": true, "isStarred": false, "labels": ["INBOX", "CATEGORY_UPDATES"], "lastMessageSnippet": "128 conversations, 94% answered within 2 minutes."],
            ]
            if parts.count == 3 || (parts.count == 4 && parts[3] == "threads") {
                var list = threads
                if q["unread"] == "true" { list = list.filter { ($0["isRead"] as? Bool) == false } }
                if q["starred"] == "true" { list = list.filter { ($0["isStarred"] as? Bool) == true } }
                if let term = q["q"]?.lowercased(), !term.isEmpty { list = list.filter { "\($0["subject"] ?? "") \($0["lastMessageSnippet"] ?? "")".lowercased().contains(term) } }
                return (200, ["threads": list, "nextBefore": NSNull()])
            }
            if parts.count >= 5, parts[3] == "threads" {
                let id = parts[4]
                if parts.count == 6 { return (200, ["ok": true]) }
                let thread = threads.first { ($0["id"] as? String) == id } ?? threads[0]
                var messages: [[String: Any]] = []
                if id == "e-2" {
                    messages = [
                        ["id": "m1", "direction": "inbound", "fromAddress": "Alexander Konstantinopoulos-Richardson <alex.k.richardson@verylongcompanyname-international.com>", "toAddresses": ["support@webyar.ai"], "ccAddresses": ["cfo@verylongcompanyname-international.com"],
                         "htmlBody": "<p>Hi Webyar team,</p><p>We're evaluating <b>Webyar Enterprise</b> for our support desk (40 operators across three time zones). Could you send over a formal quote including the <a href=\"https://webyar.ai/pricing\">call center add-on</a> and annual billing?</p><table style=\"border-collapse:collapse\"><tr><td style=\"border:1px solid #ddd;padding:6px 10px\">Seats</td><td style=\"border:1px solid #ddd;padding:6px 10px\">40</td></tr><tr><td style=\"border:1px solid #ddd;padding:6px 10px\">Channels</td><td style=\"border:1px solid #ddd;padding:6px 10px\">Widget, WhatsApp, Email</td></tr></table><p>Best,<br>Alex</p>",
                         "snippet": "We're evaluating Webyar Enterprise for our support desk", "sentAt": ago(300), "deliveryStatus": "sent",
                         "attachments": [["id": "a1", "filename": "requirements-v3.pdf", "contentType": "application/pdf", "sizeBytes": 482113, "url": "https://example.com/requirements-v3.pdf"]]],
                        ["id": "m2", "direction": "outbound", "fromAddress": "support@webyar.ai", "toAddresses": ["alex.k.richardson@verylongcompanyname-international.com"],
                         "textBody": "Hi Alex,\n\nThanks for reaching out! I've looped in our sales team; you'll have the quote within a business day.\n\nSara", "snippet": "Thanks for reaching out!", "sentAt": ago(200), "deliveryStatus": "sent"],
                        ["id": "m3", "direction": "inbound", "fromAddress": "Dana Wu <cfo@verylongcompanyname-international.com>", "toAddresses": ["support@webyar.ai"], "ccAddresses": ["alex.k.richardson@verylongcompanyname-international.com"],
                         "textBody": "Hello,\n\nCould you send over a formal quote including the call center add-on and annual billing? We'd like to sign before the end of the quarter.\n\nhttps://verylongcompanyname-international.com/procurement\n\nDana Wu\nCFO", "snippet": "Could you send over a formal quote", "sentAt": ago(95), "deliveryStatus": "sent"],
                    ]
                } else if id == "e-3" {
                    messages = [
                        ["id": "m1", "direction": "inbound", "fromAddress": "ayse@example.com.tr", "toAddresses": ["support@webyar.ai"],
                         "textBody": "Merhaba,\n\nFaturamı aldım, teşekkürler. Her şey yolunda.\n\nAyşe", "snippet": "Teşekkürler, her şey yolunda.", "sentAt": ago(1500), "deliveryStatus": "sent"],
                    ]
                } else if id == "e-4" {
                    messages = [
                        ["id": "m1", "direction": "inbound", "fromAddress": "Webyar Reports <reports@webyar.ai>", "toAddresses": ["support@webyar.ai"],
                         "htmlBody": "<div style=\"font-family:-apple-system,sans-serif\"><h2 style=\"margin:0 0 8px;color:#2f6ae0\">Your week on Webyar</h2><p style=\"color:#555\">Sep 15 – Sep 21</p><table style=\"border-collapse:collapse;width:100%\"><tr><td style=\"padding:10px;border-bottom:1px solid #eee\">Conversations</td><td style=\"padding:10px;border-bottom:1px solid #eee;text-align:right\"><b>128</b></td></tr><tr><td style=\"padding:10px;border-bottom:1px solid #eee\">Answered within 2 minutes</td><td style=\"padding:10px;border-bottom:1px solid #eee;text-align:right\"><b>94%</b></td></tr><tr><td style=\"padding:10px\">Customer rating</td><td style=\"padding:10px;text-align:right\"><b>4.8 ★</b></td></tr></table><p><a href=\"https://webyar.ai\">Open the full report</a></p></div>",
                         "snippet": "128 conversations, 94% answered within 2 minutes.", "sentAt": ago(4000), "deliveryStatus": "sent"],
                    ]
                } else {
                    messages = [
                        ["id": "m1", "direction": "inbound", "fromAddress": "مریم احمدی <maryam@example.com>", "toAddresses": ["support@webyar.ai"],
                         "textBody": "سلام وقت بخیر،\n\nسفارش ۴۸۲۱۳ را دیروز تحویل گرفتم ولی مبلغ فاکتور با چیزی که پرداخت کردم فرق دارد. فاکتور را پیوست کردم؛ لطفاً مبلغ اضافه را برگردانید.\n\nممنون\nمریم", "snippet": "سلام، فاکتور را پیوست کردم.", "sentAt": ago(14), "deliveryStatus": "sent",
                         "attachments": [["id": "a2", "filename": "invoice-48213.pdf", "contentType": "application/pdf", "sizeBytes": 124000, "url": "https://example.com/invoice.pdf"]]],
                    ]
                }
                return (200, ["thread": thread, "messages": messages])
            }
            if parts.count == 4, parts[3] == "send" { return (200, ["messageId": UUID().uuidString]) }
            if parts.count == 4, parts[3] == "attachments" { return (200, ["storageKey": UUID().uuidString, "filename": q["filename"] ?? "file", "contentType": q["content_type"] ?? "application/octet-stream", "sizeBytes": 1000]) }
        }
        // Parametrised paths.
        if parts.count == 3, parts[1] == "call-invitations", method == "GET" {
            // The visitor never answers: the call window stays on "calling".
            return (200, ["invitation": ["id": parts[2], "status": "pending"]])
        }
        if parts.count >= 5, parts[1] == "call-center", parts[2] == "calls" {
            let id = parts[3]
            switch (method, parts[4]) {
            case ("GET", "notes"):
                lock.lock(); defer { lock.unlock() }
                return (200, ["notes": [["id": "cn-1", "note": "مشتری دربارهٔ تمدید اشتراک سؤال دارد؛ فاکتور قبلی را دیده.", "author_name": "رضا محمدی", "created_at": ago(6)]] + (callNotes[id] ?? [])])
            case ("POST", "notes"):
                if notesDown { return (503, ["error": "unavailable"]) }
                lock.lock(); callNotes[id, default: []].append(["id": UUID().uuidString, "note": body["note"] as? String ?? "", "author_name": "Sara Karimi", "created_at": ago(0)]); lock.unlock()
                return (200, ["ok": true])
            case ("POST", "spam"), ("POST", "not-spam"):
                return (200, ["ok": true, "call_id": id, "spam": parts[4] == "spam"])
            case ("POST", "transfer"):
                return (200, ["ok": true, "assigned_agent_id": body["to_agent_id"] ?? NSNull(), "handoff": "manual"])
            default: break
            }
        }
        if parts.count >= 4, parts[1] == "conversations" {
            let id = parts[2]
            switch (method, parts[3]) {
            case ("GET", "messages"): return (200, ["messages": messages(id)])
            case ("GET", "notes"):
                lock.lock(); defer { lock.unlock() }
                return (200, ["notes": [["id": "n-1", "body": "مشتری VIP است؛ ارسال رایگان داده شود.", "author_id": "u-2", "author": ["full_name": "رضا محمدی"], "created_at": ago(1500)]] + (notes[id] ?? [])])
            case ("POST", "notes"):
                lock.lock(); notes[id, default: []].append(["id": UUID().uuidString, "body": body["body"] as? String ?? "", "author_id": "u-1", "author": ["full_name": "Sara Karimi"], "created_at": ago(0)]); lock.unlock()
                return (200, ["ok": true])
            default: return (200, ["ok": true])
            }
        }
        if parts.count >= 3, parts[1] == "availability", parts[2] == "team" {
            return (200, ["presence": [
                ["user_id": "u-1", "presence_state": "active"], ["user_id": "u-2", "presence_state": "active"],
                ["user_id": "u-3", "presence_state": "away"], ["user_id": "u-4", "presence_state": "disconnected"],
            ]])
        }
        if parts.count >= 4, parts[1] == "web-analytics" { return webAnalytics(parts[3], q) }
        if parts.count >= 4, parts[1] == "plans" { return (200, ["plan": ["name": "Business"], "features": [String: Any](), "modules": [String: Any](), "channels": [String: Any]()]) }
        if parts.count >= 4, parts[1] == "workspaces", parts[3] == "role" { return (200, ["role": "owner"]) }
        if parts.count >= 3, parts[1] == "contacts" {
            let id = parts[2]
            if parts.count >= 4, parts[3] == "conversations" {
                return (200, ["conversations": [["id": "conv-1", "status": "open", "last_message_body": "ممنون، خیلی لطف کردید!", "operator_name": "Sara Karimi", "message_count": 9, "created_at": ago(3000), "updated_at": ago(2)]]])
            }
            if let v = visitors.first(where: { $0.id == id }) {
                return (200, ["contact": ["id": v.id, "name": v.name.map { $0 as Any } ?? NSNull(), "email": v.email.map { $0 as Any } ?? NSNull(), "visitor_code": v.code, "created_at": ago(9000), "updated_at": ago(60)]])
            }
        }
        if parts.count >= 4, parts[1] == "visitor-intel", parts.last == "page-history" {
            return (200, ["items": [["id": 1, "url": "https://webyar.ai/", "title": "Webyar — AI support", "viewed_at": ago(12)], ["id": 2, "url": "https://webyar.ai/pricing", "title": "Pricing", "viewed_at": ago(4)]],
                          "entry": ["landing_url": "https://webyar.ai/", "landed_at": ago(12), "referrer": "https://google.com"]])
        }
        if parts.count >= 4, parts[1] == "conversation-attachments", parts.last == "file" {
            return (200, Data("%PDF-1.4 sample".utf8))
        }
        return (200, ["ok": true])
    }
}
#endif
