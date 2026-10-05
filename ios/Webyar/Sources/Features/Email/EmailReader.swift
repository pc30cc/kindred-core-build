import Foundation

/// A thread as one page, the way the Android and Windows apps read mail.
///
/// The newest mail first and open, under a header that says who wrote it,
/// when, and to whom; then the earlier ones, newest first, each folded to one
/// line (a face, a name, the first words, a date) and opened with a tap. The
/// same white page and the same measurements as the Android app's
/// `EmailReader`, so a mail looks the same on every screen the operator has.
///
/// The page is always white, dark theme or not: a mail is somebody else's
/// design, drawn for white paper, and most of them are unreadable on anything
/// else.
///
/// Nothing here runs. The web view that shows this has JavaScript off, and the
/// mail's own HTML is cut down to what can be drawn: no scripts, frames,
/// forms, plugins or `<meta>`/`<base>`, and no `javascript:` links. Folding is
/// `<details>`, which the page does by itself. Links are the app's to follow
/// (`attachmentScheme` opens a file; anything else goes to the browser).
enum EmailReader {

    /// A file chip's link: `webyar-attachment:<id>`. The web view never loads it; the app opens the file.
    static let attachmentScheme = "webyar-attachment"

    /// Where an inline picture (`cid:`) is fetched from: a scheme of the
    /// app's own, answered from the signed-in API rather than from anywhere
    /// on the network.
    static let inlineScheme = "webyar-inline"

    static func attachmentLink(_ id: String) -> String { "\(attachmentScheme):\(encode(id))" }

    static func inlineURL(_ id: String) -> String { "\(inlineScheme)://part/\(encode(id))" }

    /// The attachment id a link or an inline URL names, or nil for anything else.
    static func attachmentID(of url: String) -> String? {
        let raw: Substring
        if url.hasPrefix("\(attachmentScheme):") {
            raw = url.dropFirst(attachmentScheme.count + 1)
        } else if url.hasPrefix("\(inlineScheme)://part/") {
            raw = url.dropFirst("\(inlineScheme)://part/".count)
        } else {
            return nil
        }
        guard let decoded = String(raw).removingPercentEncoding, !decoded.trimmingCharacters(in: .whitespaces).isEmpty else {
            return nil
        }
        return decoded
    }

    /// A picture drawn inside a mail is fetched up to this size; a larger
    /// one is a file to open, not something to hold a page up for.
    static let inlinePictureMaxBytes = 10 * 1024 * 1024
    /// How long the page waits for one picture before drawing on without it.
    static let inlinePictureWait: UInt64 = 20_000_000_000

    /// What a mail's file is called on disk, which is all Quick Look goes by:
    /// its name's extension when it has a real one, otherwise its type's.
    static func fileExtension(_ attachment: EmailAttachmentView) -> String? {
        if let name = attachment.filename, let dot = name.lastIndex(of: "."), dot < name.index(before: name.endIndex) {
            let ext = String(name[name.index(after: dot)...])
            if !ext.isEmpty, ext.count <= 8 { return ext }
        }
        switch attachment.contentType?.lowercased().split(separator: ";").first.map(String.init) {
        case "application/pdf": return "pdf"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        case "text/plain": return "txt"
        case "text/csv": return "csv"
        case "text/calendar": return "ics"
        case "application/zip": return "zip"
        case "application/msword": return "doc"
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx"
        case "application/vnd.ms-excel": return "xls"
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx"
        case "application/vnd.ms-powerpoint": return "ppt"
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": return "pptx"
        case "audio/mpeg": return "mp3"
        case "audio/mp4", "audio/m4a", "audio/x-m4a": return "m4a"
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        default: return nil
        }
    }

    private static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    }

    // MARK: - The page

    static func document(
        subject: String?,
        messages: [EmailMessageView],
        mailbox: String?,
        language: Language,
        snippet: String? = nil
    ) -> String {
        var out = ""
        out.reserveCapacity(4096 + messages.reduce(0) { $0 + ($1.htmlBody?.count ?? 0) + ($1.textBody?.count ?? 0) })
        // Left to right in every language of the app, as mail is laid out:
        // the sender's face and the subject on the left. A mail's own text
        // keeps its direction — a Persian mail still reads right to left.
        out += "<!doctype html><html dir=\"ltr\"><head><meta charset=\"utf-8\">"
        out += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        out += "<style>" + css + side + fit + "</style></head><body>"

        let title = subject.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? Str.emailNoSubject(language)
        out += "<h1 class=\"w-s\">" + escape(title) + "</h1>"
        if messages.count > 1 {
            out += "<div class=\"w-cnt\">" + escape(EmailStr.messagesCount(language, messages.count)) + "</div>"
        }

        if let latest = messages.last {
            header(&out, latest, mailbox: mailbox, language: language)
            body(&out, latest, language: language, scope: scopeOf(messages.count - 1))
        } else {
            out += "<div class=\"w-b\" dir=\"auto\"><pre class=\"w-t\">"
                + escape(EmailBody.plainText(from: snippet ?? ""))
                + "</pre></div>"
        }

        if messages.count > 1 {
            out += "<div class=\"w-earlier\"><div class=\"w-et\">"
                + escape(EmailStr.earlierMessages(language, messages.count - 1))
                + "</div>"
            for index in stride(from: messages.count - 2, through: 0, by: -1) {
                let m = messages[index]
                let from = MailName.parse(m.fromAddress)
                // A mail still unread is opened for the operator.
                out += m.isRead == false ? "<details class=\"w-card\" open><summary>" : "<details class=\"w-card\"><summary>"
                out += avatar(from, px: 30)
                out += "<span class=\"w-who\">" + escape(who(from, mailbox: mailbox, language: language)) + "</span>"
                if m.deliveryStatus == "draft" { out += "<span class=\"w-draft\">" + escape(EmailStr.draft(language)) + "</span>" }
                out += "<span class=\"w-sn\">" + escape(snippetOf(m)) + "</span>"
                out += "<span class=\"w-dt\">" + escape(Format.listTimestamp(m.sentAt, locale: language.locale)) + "</span>"
                out += "</summary><div class=\"w-in\"><div class=\"w-meta\">"
                out += escape("\(EmailStr.from(language)): \(m.fromAddress ?? "")")
                out += "<br>" + escape("\(EmailStr.to(language)): \(joinEmails(m.toAddresses))")
                if let cc = m.ccAddresses, !cc.isEmpty {
                    out += "<br>" + escape("\(EmailStr.cc(language)): \(joinEmails(cc))")
                }
                if m.sentAt != nil {
                    out += "<br>" + escape("\(EmailStr.date(language)): \(fullDate(m, language: language))")
                }
                out += "</div>"
                body(&out, m, language: language, scope: scopeOf(index))
                out += "</div></details>"
            }
            out += "</div>"
        }
        out += "</body></html>"
        return out
    }

    private static func header(_ out: inout String, _ m: EmailMessageView, mailbox: String?, language: Language) {
        let from = MailName.parse(m.fromAddress)
        out += "<div class=\"w-hd\">" + avatar(from, px: 40) + "<div class=\"w-hw\"><div class=\"w-hl\">"
        out += "<span class=\"w-hn\">" + escape(who(from, mailbox: mailbox, language: language)) + "</span>"
        if m.deliveryStatus == "draft" { out += "<span class=\"w-draft\">" + escape(EmailStr.draft(language)) + "</span>" }
        out += "<span class=\"w-hdt\">" + escape(fullDate(m, language: language)) + "</span></div>"
        // The address beside a name, never twice: a bare address is its own name.
        if from.name != nil {
            out += "<div class=\"w-ha\" dir=\"ltr\">" + escape(from.email) + "</div>"
        }
        let to = (m.toAddresses ?? []).map { recipient($0, mailbox: mailbox, language: language) }
        let cc = (m.ccAddresses ?? []).map { recipient($0, mailbox: mailbox, language: language) }
        if !to.isEmpty || !cc.isEmpty {
            var parts: [String] = []
            if !to.isEmpty { parts.append("\(EmailStr.to(language)): \(to.joined(separator: ", "))") }
            if !cc.isEmpty { parts.append("\(EmailStr.cc(language)): \(cc.joined(separator: ", "))") }
            out += "<div class=\"w-hr\">" + escape(parts.joined(separator: " · ")) + "</div>"
        }
        out += "</div></div>"
    }

    /// The class that confines message `index`'s own stylesheet (`MailCss`).
    private static func scopeOf(_ index: Int) -> String { "m\(index)" }

    private static func body(_ out: inout String, _ m: EmailMessageView, language: Language, scope: String) {
        out += "<div class=\"w-b \(scope)\" dir=\"auto\">"
        let html = m.htmlBody.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        if let html {
            out += sanitize(html, attachments: m.attachments ?? [], scope: scope)
        } else {
            let text = m.textBody.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                ?? EmailBody.plainText(from: m.snippet ?? "")
            let split = EmailBody.splitQuoted(text)
            out += "<pre class=\"w-t\">" + escape(split.fresh) + "</pre>"
            if let quoted = split.quoted {
                // Plain-text mail carries its trail as "> " lines; folded, as
                // every mail client folds it.
                out += "<details class=\"w-q\"><summary>" + escape(EmailStr.showQuoted(language))
                    + "</summary><pre class=\"w-t\">" + escape(quoted) + "</pre></details>"
            }
        }
        out += "</div>"
        // Inline pictures are part of the body, not files to open.
        let files = (m.attachments ?? []).filter { !isInline($0, html: html) }
        if !files.isEmpty {
            out += "<div class=\"w-files\">"
            for file in files {
                let name = file.filename.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? Str.file(language)
                out += "<a class=\"w-file\" dir=\"auto\" href=\"" + escape(attachmentLink(file.id)) + "\">📎 " + escape(name)
                if let size = file.sizeBytes {
                    out += "<span class=\"w-fs\">" + escape(Format.fileSize(size, language: language)) + "</span>"
                }
                out += "</a>"
            }
            out += "</div>"
        }
        if m.deliveryStatus == "failed" || !(m.deliveryError ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            let reason = m.deliveryError.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
            let line = [EmailStr.notDelivered(language), reason].compactMap { $0 }.joined(separator: " — ")
            out += "<div class=\"w-err\" dir=\"auto\">" + escape(line) + "</div>"
        }
    }

    /// The content id an inline picture is referred to by, without its brackets.
    static func contentID(_ attachment: EmailAttachmentView) -> String? {
        guard var cid = attachment.contentId?.trimmingCharacters(in: .whitespaces), !cid.isEmpty else { return nil }
        if cid.hasPrefix("<") { cid.removeFirst() }
        if cid.hasSuffix(">") { cid.removeLast() }
        return cid.isEmpty ? nil : cid
    }

    /// A picture the HTML draws where it stands (`cid:`), which is not also a file to list.
    private static func isInline(_ attachment: EmailAttachmentView, html: String?) -> Bool {
        guard let cid = contentID(attachment), let html else { return false }
        return html.range(of: "cid:\(cid)", options: .caseInsensitive) != nil
    }

    private static func who(_ from: MailName, mailbox: String?, language: Language) -> String {
        let mine = mailbox.map { EmailAddressing.same(from.email, $0) } ?? false
        return mine && from.name == nil ? EmailStr.me(language) : from.display
    }

    private static func recipient(_ address: EmailAddress, mailbox: String?, language: Language) -> String {
        let parsed = MailName.parse(address.email)
        if let mailbox, EmailAddressing.same(parsed.email, mailbox) { return EmailStr.me(language) }
        return parsed.display
    }

    private static func joinEmails(_ list: [EmailAddress]?) -> String {
        (list ?? []).map(\.email).joined(separator: ", ")
    }

    private static func fullDate(_ m: EmailMessageView, language: Language) -> String {
        guard let at = m.sentAt else { return "" }
        return "\(Format.dayHeader(at, locale: language.locale)) · \(Format.bubbleTime(at, locale: language.locale))"
    }

    /// The first words, on one line. Gmail's snippets arrive HTML-escaped ("We&#39;re").
    private static func snippetOf(_ m: EmailMessageView) -> String {
        let raw = [m.snippet, m.textBody].compactMap { $0 }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            ?? m.htmlBody.map(EmailBody.plainText(from:))
            ?? ""
        let flat = EmailBody.plainText(from: raw)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return String(flat.prefix(200))
    }

    /// The sender's face as the app draws one: no initials, a person on a
    /// pastel disc whose hue is the address's — the same hue `MailAvatar`
    /// gives the same sender in the list, and the Android app gives them too.
    private static func avatar(_ from: MailName, px: Int) -> String {
        let hue = MailHue.of(from.email)
        return "<span class=\"w-av\" style=\"width:\(px)px;height:\(px)px;background:hsl(\(hue),55%,88%)\">"
            + "<svg viewBox=\"0 0 24 24\"><path fill=\"hsl(\(hue),55%,32%)\" d=\"\(person)\"/></svg></span>"
    }

    // MARK: - The mail's own HTML

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static let dropWithContent = regex(
        "<(script|iframe|frameset|frame|object|applet|noembed|textarea|select|template|title)\\b[^>]*>.*?</\\1\\s*>",
        [.caseInsensitive, .dotMatchesLineSeparators]
    )
    private static let dropTag = regex(
        "</?(script|iframe|frameset|frame|object|applet|embed|meta|base|link|form|input|button|textarea|select|option|html|head|body|title|xmp|plaintext)\\b[^>]*>",
        .caseInsensitive
    )
    private static let doctype = regex("<!doctype[^>]*>", .caseInsensitive)
    private static let eventAttribute = regex("\\s+on[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", .caseInsensitive)
    private static let scriptURL = regex(
        "(href|src|action|formaction|xlink:href)\\s*=\\s*([\"']?)\\s*(javascript|vbscript|data:text/html)[^\"'\\s>]*\\2",
        .caseInsensitive
    )
    private static let cidSource = regex("(src\\s*=\\s*)([\"']?)cid:([^\"'\\s>]+)\\2", .caseInsensitive)
    private static let styleBlock = regex("(<style\\b[^>]*>)(.*?)(</style\\s*>)", [.caseInsensitive, .dotMatchesLineSeparators])
    private static let styleOpen = regex("<style\\b", .caseInsensitive)
    /// A start tag with its attributes (quoted values may hold `>`).
    private static let startTag = regex("<([a-zA-Z][a-zA-Z0-9]*)(\\s(?:[^<>\"']|\"[^\"]*\"|'[^']*')*)?>")
    private static let widthAttribute = regex(
        "(\\s)width\\s*=\\s*([\"']?)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:px)?\\s*\\2(?=[\\s/]|$)",
        .caseInsensitive
    )
    private static let styleAttribute = regex("(\\sstyle\\s*=\\s*)(\"[^\"]*\"|'[^']*')", .caseInsensitive)
    private static let fixedWidth = regex(
        "(^|;)\\s*(min-width|width)\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*(!\\s*important)?\\s*(?=;|$)",
        .caseInsensitive
    )

    /// The mail's HTML with everything that is not drawing taken out, and its
    /// stylesheet held inside the mail's own box (`scope`, see `MailCss`).
    ///
    /// JavaScript is off in the web view, so this is the second fence, not the
    /// first: it keeps a mail from bringing a form, a frame onto some other
    /// page, or a `<meta refresh>` that would navigate on its own. Styles and
    /// pictures stay — they are what makes a mail look like itself.
    ///
    /// A mail cut off mid-way does not take the rest of the page with it: an
    /// unclosed `<style>` would read everything after it as CSS, and an
    /// unclosed comment would hide it, so the first is cut and the second
    /// closed.
    static func sanitize(_ html: String, attachments: [EmailAttachmentView], scope: String = "m0") -> String {
        var out = dropWithContent.replace(in: html) { _ in "" }
        // A style element's text ends at its first `</style`, for the web
        // view as for this; scoping only rearranges what is inside, so it can
        // never make one either.
        out = styleBlock.replace(in: out) { match in "<style>" + MailCss.scope(match[2], scope: scope) + "</style>" }
        // Every closed one was just rewritten; a `<style` with no end after it
        // can only be the last, and the mail is cut there.
        let ns = out as NSString
        if let lastOpen = styleOpen.matches(in: out, range: NSRange(location: 0, length: ns.length)).last {
            let after = NSRange(location: lastOpen.range.location, length: ns.length - lastOpen.range.location)
            if ns.range(of: "</style>", options: .caseInsensitive, range: after).location == NSNotFound {
                out = ns.substring(to: lastOpen.range.location)
            }
        }
        if let open = out.range(of: "<!--", options: .backwards) {
            let close = out.range(of: "-->", options: .backwards)
            if close == nil || close!.lowerBound < open.lowerBound { out += "-->" }
        }
        out = fluid(out)
        out = doctype.replace(in: out) { _ in "" }
        out = dropTag.replace(in: out) { _ in "" }
        out = eventAttribute.replace(in: out) { _ in "" }
        out = scriptURL.replace(in: out) { match in "\(match[1])=\"#\"" }
        // Inline pictures: `cid:<content id>` → the app's own URL for that part.
        var byCid: [String: String] = [:]
        for attachment in attachments {
            if let cid = contentID(attachment) { byCid[cid.lowercased()] = attachment.id }
        }
        if !byCid.isEmpty {
            out = cidSource.replace(in: out) { match in
                guard let id = byCid[match[3].lowercased()] else { return match[0] }
                return "\(match[1])\"\(inlineURL(id))\""
            }
        }
        return out
    }

    /// Elements whose fixed width is a desktop column's, not something drawn at a size (pictures keep theirs).
    private static let fluidElements: Set<String> = [
        "table", "tbody", "thead", "tfoot", "tr", "td", "th", "col", "colgroup", "div", "p", "span", "center", "a",
        "font", "section", "article", "header", "footer", "main", "nav", "aside", "blockquote", "ul", "ol", "li",
        "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "address", "pre",
    ]
    private static let cells: Set<String> = ["td", "th", "col", "colgroup"]

    /// A table this wide is a page column: it becomes the phone's.
    static let widePixels = 300.0
    /// A box this wide has a desktop width; narrower is a spacer or an icon.
    private static let boxPixels = 100.0

    /// A mail's desktop widths let go of, so it reflows to the phone.
    ///
    /// A 600-pixel mail is fixed widths all the way down: the wrapper table,
    /// each column's cell, the boxes inside them. `max-width` cannot undo them
    /// — a table is never narrower than its fixed-width contents — so they are
    /// rewritten where they stand: a wide table becomes the column's full
    /// width, a cell's width is left to the table, and a box of a hundred
    /// pixels or more takes the width it is given. `min-width` goes. Pictures,
    /// and the small fixed things (spacers, icons), keep their sizes.
    private static func fluid(_ html: String) -> String {
        startTag.replace(in: html) { tag in
            let name = tag[1].lowercased()
            let attributes = tag[2]
            guard fluidElements.contains(name), !attributes.isEmpty else { return tag[0] }
            var rewritten = widthAttribute.replace(in: attributes) { width in
                let px = Double(width[3]) ?? 0
                if name == "table", px >= widePixels { return "\(width[1])width=\"100%\"" }
                if name == "table" || cells.contains(name) || px >= boxPixels { return width[1] }
                return width[0]
            }
            rewritten = styleAttribute.replace(in: rewritten) { style in
                let quoted = style[2]
                guard let quote = quoted.first, quoted.count >= 2 else { return style[0] }
                let inner = String(quoted.dropFirst().dropLast())
                let declarations = fixedWidth.replace(in: inner) { d in
                    let separator = d[1]
                    let px = Double(d[3]) ?? 0
                    if d[2].lowercased() == "min-width" { return separator }
                    if name == "table", px >= widePixels { return "\(separator)width:100%" }
                    if name == "table" || cells.contains(name) || px >= boxPixels { return "\(separator)width:auto" }
                    return d[0]
                }
                return "\(style[1])\(quote)\(declarations)\(quote)"
            }
            return "<\(tag[1])\(rewritten)>"
        }
    }

    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count + 16)
        for c in text {
            switch c {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(c)
            }
        }
        return out
    }

    private static let person = "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5z"

    /// The reader's stylesheet — the Android and Windows readers' own, with
    /// the app's Persian face first. Every class is the reader's own (`w-…`)
    /// and no rule names a bare element, so a mail's markup never picks up the
    /// reader's look. The header is drawn above the mail (`z-index`) on white,
    /// so nothing a mail positions can cover who sent it.
    private static let css = [
        "html,body{background:#ffffff}",
        "body{margin:0;padding:14px 16px 24px;font-family:IRANSansX,IRANSans,Vazirmatn,-apple-system,'SF Pro Text',Tahoma,sans-serif;font-size:15px;line-height:1.6;color:#1f2633;-webkit-text-size-adjust:100%;overflow-wrap:break-word}",
        "a{color:#2f6ae0}",
        ".w-s{font-size:19px;line-height:1.4;font-weight:700;color:#0f1729;margin:2px 0 4px;overflow-wrap:anywhere}",
        ".w-s,.w-cnt,.w-hd{position:relative;z-index:1;background:#ffffff}",
        ".w-cnt{font-size:12px;color:#6b7485;margin-bottom:4px}",
        ".w-hd{display:flex;align-items:flex-start;gap:12px;margin:12px 0 14px;padding-bottom:12px;border-bottom:1px solid #eef0f4}",
        ".w-hw{flex:1;min-width:0}",
        ".w-hl{display:flex;align-items:baseline;gap:8px}",
        ".w-hn{flex:1;min-width:0;font-weight:600;font-size:14.5px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-hdt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".w-draft{flex:none;font-size:12.5px;font-weight:600;color:#c62f35;white-space:nowrap}",
        ".w-ha{font-size:12.5px;color:#6b7485;overflow-wrap:anywhere}",
        ".w-hr{font-size:12.5px;color:#6b7485;margin-top:2px;overflow-wrap:anywhere}",
        ".w-t{white-space:pre-wrap;font-family:inherit;font-size:inherit;margin:0;unicode-bidi:plaintext;text-align:start}",
        ".w-q{margin-top:10px}",
        ".w-q>summary{display:inline-block;list-style:none;cursor:pointer;padding:2px 10px;border-radius:8px;background:#f1f4f9;color:#3b4252;font-size:12.5px}",
        ".w-q>summary::-webkit-details-marker{display:none}",
        ".w-q[open]>summary{margin-bottom:8px}",
        ".w-q .w-t{color:#6b7485;border-inline-start:3px solid #e3e7ee;padding-inline-start:10px}",
        ".w-err{margin-top:12px;padding:8px 12px;border-radius:8px;background:#fdecec;color:#c62f35;font-size:12.5px}",
        ".w-earlier{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}",
        ".w-et{font-size:12px;font-weight:600;color:#6b7485;margin:0 2px 10px}",
        ".w-card{border:1px solid #e3e7ee;border-radius:12px;margin-bottom:10px;background:#f8f9fb;overflow:hidden}",
        ".w-card[open]{background:#ffffff}",
        ".w-card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 14px}",
        ".w-card>summary::-webkit-details-marker{display:none}",
        ".w-av{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:hidden}",
        ".w-av svg{width:55%;height:55%}",
        ".w-who{flex:none;max-width:40%;font-weight:600;font-size:13px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-sn{flex:1;min-width:0;font-size:12.5px;color:#6b7485;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-card[open]>summary .w-sn{visibility:hidden}",
        ".w-dt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".w-in{padding:4px 14px 14px;border-top:1px solid #eef0f4}",
        ".w-meta{font-size:12px;color:#6b7485;margin:8px 0 12px;overflow-wrap:anywhere}",
        ".w-files{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px}",
        ".w-file{font-size:12.5px;color:#3b4252;background:#f1f4f9;border-radius:8px;padding:6px 10px;text-decoration:none;max-width:100%;overflow-wrap:anywhere}",
        ".w-fs{color:#98a2b3;margin-inline-start:6px}",
    ].joined()

    /// The page's own lines — subject, sender, recipients, the folded mails'
    /// names and first words — on the left: each keeps its own word order
    /// (`plaintext`) but not its own alignment.
    private static let side = ".w-s,.w-cnt,.w-hn,.w-ha,.w-hr,.w-who,.w-sn,.w-meta,.w-et{unicode-bidi:plaintext;text-align:left}"

    /// A mail held to the phone's width: nothing wider than the column it is
    /// in, nothing insisting on a minimum width, pictures scaling with their
    /// width, and a long word or link breaking rather than overflowing.
    /// `:not(#w):not(#w)` lifts these above anything a mail's own stylesheet
    /// says. What is still wider scrolls sideways inside the mail's own box.
    private static let fit = [
        ".w-b{position:relative;z-index:0;transform:translateZ(0);overflow-wrap:anywhere;overflow-x:auto;overflow-y:hidden}",
        ".w-b:not(#w):not(#w),.w-b:not(#w):not(#w) *{max-width:100%!important;min-width:0!important;box-sizing:border-box!important}",
        ".w-b:not(#w):not(#w) img{height:auto!important}",
        ".w-b:not(#w):not(#w) table{table-layout:auto!important}",
        ".w-b:not(#w):not(#w) [nowrap],.w-b:not(#w):not(#w) [style*=nowrap i]{white-space:normal!important}",
        ".w-b:not(#w):not(#w) pre,.w-b:not(#w):not(#w) [style*=\"white-space:pre\" i]{white-space:pre-wrap!important}",
    ].joined()
}

/// The hue of an address's face, the same number the Android app computes
/// (`String.hashCode`), so one sender has one colour on every phone.
enum MailHue {
    static func of(_ address: String) -> Int {
        var hash: Int32 = 0
        for unit in address.lowercased().utf16 {
            hash = hash &* 31 &+ Int32(unit)
        }
        return Int(UInt32(bitPattern: hash) % 360)
    }
}

/// A mail's own stylesheet, confined to the mail.
///
/// A mail's `<style>` was written for a page of its own: `body{min-width:600px}`,
/// `table{width:600px}`, `h1{font-size:32px}`. Dropped into the reader as they
/// are, those rules reach the whole page. Here every selector is put under the
/// mail's own box (`.m0 table`), and what was aimed at the page itself
/// (`html`, `body`, `:root`) is aimed at that box instead, the way web mail
/// clients have always embedded mail. `@media` and `@supports` blocks are kept
/// and scoped in turn; `@font-face`, `@keyframes` and `@page` are kept as they
/// are; `@import` and any other at-rule are dropped. The Android app's
/// `MailCss`, rule for rule.
enum MailCss {
    /// At-rules whose blocks hold more rules, which are scoped in turn.
    private static let grouping: Set<String> = ["media", "supports", "container", "layer", "document", "-moz-document"]

    /// At-rules kept as written: their blocks are descriptors, not selectors.
    private static let verbatim: Set<String> = [
        "font-face", "keyframes", "-webkit-keyframes", "-moz-keyframes", "page",
        "font-feature-values", "counter-style", "property",
    ]

    private static let comment = try! NSRegularExpression(pattern: "/\\*.*?\\*/", options: .dotMatchesLineSeparators)
    private static let cdoCdc = try! NSRegularExpression(pattern: "<!--|-->")
    private static let root = try! NSRegularExpression(
        pattern: "^(?:html|:root)(?=$|[\\s>+~.#\\[:])[^\\s>+~]*\\s*(?:>\\s*)?", options: .caseInsensitive
    )
    private static let body = try! NSRegularExpression(pattern: "^body(?=$|[\\s>+~.#\\[:])[^\\s>+~]*", options: .caseInsensitive)
    private static let fixedWidth = try! NSRegularExpression(
        pattern: "(^|[;\\s])(min-width|width)\\s*:\\s*(\\d+(?:\\.\\d+)?)px(\\s*!\\s*important)?", options: .caseInsensitive
    )

    /// A rule's declarations with a desktop column's width let go of.
    private static func fluid(_ declarations: String) -> String {
        fixedWidth.replace(in: declarations) { d in
            if d[2].lowercased() == "min-width" { return d[1] }
            if (Double(d[3]) ?? 0) >= EmailReader.widePixels { return "\(d[1])width:100%\(d[4])" }
            return d[0]
        }
    }

    /// `css` with every rule applying inside `.scope` only.
    static func scope(_ css: String, scope: String) -> String {
        let text = Array(cdoCdc.replace(in: comment.replace(in: css) { _ in " " }) { _ in " " })
        var out = ""
        rules(text, 0, text.count, ".\(scope)", &out)
        return out
    }

    private static func rules(_ css: [Character], _ from: Int, _ to: Int, _ scope: String, _ out: inout String) {
        var i = from
        while i < to {
            let c = css[i]
            if c.isWhitespace || c == ";" || c == "}" {
                i += 1
                continue
            }
            guard let stop = find(css, i, to) else { return }
            let prelude = String(css[i..<stop]).trimmingCharacters(in: .whitespacesAndNewlines)
            if css[stop] == ";" {
                // A statement: @import, @charset, @namespace — none kept.
                i = stop + 1
                continue
            }
            let close = matching(css, stop, to)
            if prelude.hasPrefix("@") {
                let name = String(prelude.dropFirst().prefix { $0.isLetter || $0.isNumber || $0 == "-" }).lowercased()
                if grouping.contains(name) {
                    out += prelude + "{"
                    rules(css, stop + 1, close, scope, &out)
                    out += "}"
                } else if verbatim.contains(name) {
                    out += prelude + "{" + String(css[(stop + 1)..<close]) + "}"
                }
            } else if !prelude.isEmpty {
                out += selectors(prelude, scope: scope) + "{" + fluid(String(css[(stop + 1)..<close])) + "}"
            }
            i = close + 1
        }
    }

    /// Every selector of a list, scoped.
    static func selectors(_ list: String, scope: String) -> String {
        split(Array(list)).map { one($0.trimmingCharacters(in: .whitespacesAndNewlines), scope: scope) }.joined(separator: ",")
    }

    private static func one(_ selector: String, scope: String) -> String {
        let rest = root.replace(in: selector, firstOnly: true) { _ in "" }
        if rest.isEmpty { return scope }
        let ns = rest as NSString
        guard let match = body.firstMatch(in: rest, range: NSRange(location: 0, length: ns.length)) else {
            return "\(scope) \(rest)"
        }
        return scope + ns.substring(from: match.range.location + match.range.length)
    }

    /// The next `{` or `;` at the top level from `from`: not inside a string, brackets or parentheses.
    private static func find(_ css: [Character], _ from: Int, _ to: Int) -> Int? {
        var depth = 0
        var i = from
        while i < to {
            let c = css[i]
            switch c {
            case "\"", "'": i = skipString(css, i, to, c)
            case "(", "[": depth += 1
            case ")", "]": if depth > 0 { depth -= 1 }
            case "{", ";": if depth == 0 { return i }
            default: break
            }
            i += 1
        }
        return nil
    }

    /// The `}` that closes the block opened at `open`; `to` when the sheet ends first.
    private static func matching(_ css: [Character], _ open: Int, _ to: Int) -> Int {
        var depth = 0
        var i = open
        while i < to {
            let c = css[i]
            switch c {
            case "\"", "'": i = skipString(css, i, to, c)
            case "{": depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return i }
            default: break
            }
            i += 1
        }
        return to
    }

    /// The index of the quote that ends the string starting at `start`.
    private static func skipString(_ css: [Character], _ start: Int, _ to: Int, _ quote: Character) -> Int {
        var i = start + 1
        while i < to {
            let c = css[i]
            if c == "\\" {
                i += 1
            } else if c == quote || c == "\n" {
                return i
            }
            i += 1
        }
        return to - 1
    }

    /// A selector list split on its top-level commas.
    private static func split(_ list: [Character]) -> [String] {
        var parts: [String] = []
        var depth = 0
        var start = 0
        var i = 0
        while i < list.count {
            let c = list[i]
            switch c {
            case "\"", "'": i = skipString(list, i, list.count, c)
            case "(", "[": depth += 1
            case ")", "]": if depth > 0 { depth -= 1 }
            case ",":
                if depth == 0 {
                    parts.append(String(list[start..<i]))
                    start = i + 1
                }
            default: break
            }
            i += 1
        }
        parts.append(String(list[start...]))
        return parts.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

extension NSRegularExpression {
    /// Every match (or the first) replaced by what `transform` makes of its
    /// groups — `groups[0]` the whole match, an absent group the empty string.
    func replace(in text: String, firstOnly: Bool = false, _ transform: ([String]) -> String) -> String {
        let ns = text as NSString
        let matches = self.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return text }
        var out = ""
        var last = 0
        for match in firstOnly ? Array(matches.prefix(1)) : matches {
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let groups = (0..<match.numberOfRanges).map { index -> String in
                let range = match.range(at: index)
                return range.location == NSNotFound ? "" : ns.substring(with: range)
            }
            out += transform(groups)
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}
