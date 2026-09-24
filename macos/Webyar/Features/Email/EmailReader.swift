import AppKit
import SwiftUI
import WebKit

/// The thread as one page: each message a card, older ones folded to a line
/// (pure HTML `<details>`, no script), the newest open. HTML bodies are shown
/// as sent on a paper card; text bodies escaped. Scripts are off and every
/// link opens in the browser, so a message can look like itself but not act.
enum EmailHTML {
    static let attachmentScheme = "webyar-attachment"

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// Tags stripped and entities undone, for quoting a message that only came as HTML.
    static func plainText(_ html: String) -> String {
        guard let data = html.data(using: .utf8),
              let a = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil)
        else { return html }
        return a.string
    }

    @MainActor
    static func page(_ detail: EmailThreadDetail, dark: Bool, s: Strings) -> String {
        let dir = s.isRightToLeft ? "rtl" : "ltr"
        let fg = dark ? "#e8ecf4" : "#0f1729"
        let fg2 = dark ? "#98a2b3" : "#5b6577"
        let line = dark ? "#2a303d" : "#e3e7ee"
        let card = dark ? "#171b24" : "#ffffff"
        let chip = dark ? "#1d222d" : "#f1f4f9"
        // Palette.chatBackground, painted by the page itself: an opaque page composites the same everywhere.
        let bg = dark ? "#0f1218" : "#f5f7fa"
        var html = """
        <!doctype html><html dir="\(dir)"><head><meta charset="utf-8">
        <meta name="color-scheme" content="\(dark ? "dark" : "light")">
        <style>
        html,body{margin:0;padding:0;background:\(bg)}
        body{padding:14px 18px 28px;font:14px/1.55 -apple-system,"SF Pro Text","Geeza Pro",sans-serif;color:\(fg);-webkit-font-smoothing:antialiased}
        details{background:\(card);border:1px solid \(line);border-radius:14px;margin:0 0 10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,\(dark ? "0.3" : "0.04"))}
        summary{list-style:none;cursor:pointer;padding:12px 16px;display:flex;gap:12px;align-items:center}
        summary::-webkit-details-marker{display:none}
        .av{flex:none;width:34px;height:34px;border-radius:50%;color:#fff;font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:center}
        .who{flex:1;min-width:0;text-align:\(s.isRightToLeft ? "right" : "left")}
        .from{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .sub{color:\(fg2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        details[open] .snip{display:none}
        details:not([open]) .full{display:none}
        .when{flex:none;color:\(fg2);font-size:12px}
        .body{padding:4px 16px 16px;overflow-wrap:anywhere}
        .paper{background:#fff;color:#111;border-radius:10px;padding:14px 16px;\(dark ? "" : "padding:0;")overflow-x:auto}
        .paper img{max-width:100%;height:auto}
        pre{white-space:pre-wrap;font:inherit;margin:0}
        a{color:\(dark ? "#7fb0ff" : "#2f6ae0")}
        .atts{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px}
        .att{display:flex;gap:8px;align-items:center;text-decoration:none;color:\(fg);background:\(chip);border:1px solid \(line);border-radius:10px;padding:7px 11px;font-size:12.5px;max-width:260px}
        .att b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .att span{color:\(fg2);white-space:nowrap}
        .err{margin:0 16px 12px;color:#e5484d;font-size:12.5px}
        .pending{margin:0 16px 12px;color:\(fg2);font-size:12px}
        blockquote{margin:0 0 0 .6em;padding-inline-start:.8em;border-inline-start:3px solid \(line);color:\(fg2)}
        </style></head><body>
        """
        let messages = (detail.messages ?? []).sorted { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
        for (i, m) in messages.enumerated() {
            let open = i == messages.count - 1 || m.deliveryStatus == "failed"
            let from = m.from
            let art = AvatarArt.make(name: from.name ?? from.email, email: from.email, os: nil)
            let c1 = hex(art.from), c2 = hex(art.to)
            let when = m.sentAt.map { Display.dateTime($0, s) } ?? ""
            let to = m.to.map(\.display).joined(separator: ", ")
            let cc = m.cc.map(\.display).joined(separator: ", ")
            var recipients = "\(s["emailTo"]): \(to)"
            if !cc.isEmpty { recipients += " · Cc: \(cc)" }
            let snippet = Display.oneLine(m.snippet ?? m.textBody ?? "")
            html += "<details\(open ? " open" : "")><summary>"
            html += "<div class=\"av\" style=\"background:linear-gradient(135deg,\(c1),\(c2))\">\(escape(art.initials))</div>"
            html += "<div class=\"who\"><div class=\"from\" dir=\"auto\">\(escape(from.display))"
            if from.name != nil { html += " <span class=\"sub\" dir=\"ltr\">&lt;\(escape(from.email))&gt;</span>" }
            html += "</div><div class=\"sub full\" dir=\"auto\">\(escape(recipients))</div>"
            html += "<div class=\"sub snip\" dir=\"auto\">\(escape(snippet))</div></div>"
            html += "<div class=\"when\">\(escape(when))</div></summary>"
            html += "<div class=\"body\" dir=\"auto\">"
            if let h = m.htmlBody, !h.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                html += "<div class=\"paper\">\(inline(h, m.attachments ?? []))</div>"
            } else {
                html += "<pre dir=\"auto\">\(linkify(escape(m.textBody ?? m.snippet ?? "")))</pre>"
            }
            html += "</div>"
            let files = (m.attachments ?? []).filter { !($0.contentId != nil && (m.htmlBody ?? "").contains("cid:\($0.contentId ?? "")")) }
            if !files.isEmpty {
                html += "<div class=\"atts\">"
                for a in files {
                    let size = a.sizeBytes.map { Display.fileSize($0, s) } ?? ""
                    html += "<a class=\"att\" href=\"\(attachmentScheme)://\(a.id)\" title=\"\(escape(a.filename ?? ""))\">📎 <b>\(escape(a.filename ?? s["file"]))</b> <span>\(escape(size))</span></a>"
                }
                html += "</div>"
            }
            if m.deliveryStatus == "queued" { html += "<div class=\"pending\">⏳ \(escape(s["emailSending"]))</div>" }
            if let err = m.deliveryError, !err.isEmpty { html += "<div class=\"err\">⚠︎ \(escape(err))</div>" }
            html += "</details>"
        }
        html += "</body></html>"
        return html
    }

    /// Inline images (`cid:`) pointed at their stored copies.
    private static func inline(_ html: String, _ attachments: [EmailAttachmentView]) -> String {
        var out = html
        for a in attachments {
            guard let cid = a.contentId?.trimmingCharacters(in: CharacterSet(charactersIn: "<> ")), !cid.isEmpty,
                  let url = a.url, url.hasPrefix("https://") else { continue }
            out = out.replacingOccurrences(of: "cid:\(cid)", with: url)
        }
        return out
    }

    /// Plain-text links made clickable.
    private static func linkify(_ escaped: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"(https?://[^\s<]+)"#) else { return escaped }
        let range = NSRange(escaped.startIndex..., in: escaped)
        return re.stringByReplacingMatches(in: escaped, range: range, withTemplate: "<a href=\"$1\">$1</a>")
    }

    private static func hex(_ h: Hsl) -> String {
        let c = h.rgb
        return String(format: "#%02X%02X%02X", Int(c.r * 255), Int(c.g * 255), Int(c.b * 255))
    }
}

/// A WebKit view for one mail thread: no script, no navigation — links and
/// attachments are handed to the Mac.
struct MailWebView: NSViewRepresentable {
    let html: String
    let onAttachment: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onAttachment: onAttachment) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        // No white flash before the page (which paints its own background) arrives.
        view.setValue(false, forKey: "drawsBackground")
        view.allowsMagnification = true
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onAttachment = onAttachment
        guard context.coordinator.shown != html else { return }
        context.coordinator.shown = html
        view.loadHTMLString(html, baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var shown: String?
        var onAttachment: (String) -> Void

        init(onAttachment: @escaping (String) -> Void) { self.onAttachment = onAttachment }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            // The page itself, loaded from a string.
            if url.scheme == "about" || url.scheme == nil { return .allow }
            // Anything else only ever leaves the app, and only when clicked.
            guard action.navigationType == .linkActivated else { return .cancel }
            if url.scheme == EmailHTML.attachmentScheme, let id = url.host {
                onAttachment(id)
            } else if ["https", "http", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            return .cancel
        }
    }
}
