import AppKit
import SwiftUI

extension View {
    /// A text field's text on the language's side. AppKit's field in a popover (a
    /// window of its own) lines up left whatever SwiftUI's direction says, so the
    /// side is pinned outright: under a left-to-right frame, trailing is the right.
    func readingSide(_ rtl: Bool) -> some View {
        multilineTextAlignment(rtl ? .trailing : .leading)
            .environment(\.layoutDirection, .leftToRight)
    }
}

extension View {
    /// A list row's own soft highlight — the brand tint with a thin ring when picked, a
    /// wash under the pointer — in place of the system's accent-blue selection, which
    /// left the rows' grey lines unreadable.
    func selectableRow(_ selected: Bool) -> some View {
        modifier(SelectableRow(selected: selected))
    }

    /// Up and down move the pick through `ids` and keep it in view; Escape lets it go
    /// when `clear` is given. For lists that draw their own selection.
    func arrowKeyPicking(_ ids: [String], selected: String?, proxy: ScrollViewProxy,
                         select: @escaping (String) -> Void, clear: (() -> Void)? = nil) -> some View {
        func step(_ by: Int) -> KeyPress.Result {
            guard !ids.isEmpty else { return .ignored }
            let at = selected.flatMap { ids.firstIndex(of: $0) }
            let next = at.map { min(ids.count - 1, max(0, $0 + by)) } ?? (by > 0 ? 0 : ids.count - 1)
            select(ids[next])
            proxy.scrollTo(ids[next])
            return .handled
        }
        return focusable()
            .focusEffectDisabled()
            .onKeyPress(.downArrow) { step(1) }
            .onKeyPress(.upArrow) { step(-1) }
            .onKeyPress(.escape) {
                guard let clear, selected != nil else { return .ignored }
                clear()
                return .handled
            }
    }
}

private struct SelectableRow: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Palette.selected : hovering ? Palette.hover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(selected ? Palette.brand.opacity(0.35) : Color.clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// A person, drawn exactly like the web console's ContactAvatar (and the
/// Windows app's Avatar control) so a visitor looks the same everywhere:
/// their photo; else their operating system's logo on that OS's gradient;
/// else initials on a gradient picked by a hash of the name. Operators show
/// their photo or first letter on the brand tint; the AI its sparkles.
/// With `faceless`, what has neither a photo nor a logo to show is a grey
/// disc with a person in it rather than letters.
struct AvatarView: View {
    enum Kind { case visitor, `operator`, ai }

    /// The person's own name, not a generated "Visitor · 4ZTK" label: the web hashes the raw name.
    var name: String?
    var email: String? = nil
    var os: String? = nil
    var countryCode: String? = nil
    var imageURL: String? = nil
    var size: CGFloat = 40
    var kind: Kind = .visitor
    /// The dot: operator presence, visitor presence or a conversation status.
    var presence: String? = nil
    /// No initials: a grey disc with a person when there is no photo or logo.
    var faceless = false

    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            disc
            if let url = photoURL {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.15))) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        Color.clear
                    }
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
            }
            Circle().strokeBorder(Palette.line, lineWidth: 0.5)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomLeading) { flag }
        .overlay(alignment: .bottomTrailing) { dot }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }

    private var photoURL: URL? {
        guard let imageURL, !imageURL.isEmpty else { return nil }
        return app.client.absolute(imageURL)
    }

    @ViewBuilder private var disc: some View {
        switch kind {
        case .ai:
            Circle().fill(Palette.aiSoft)
                .overlay(Image(systemName: "sparkles").font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(Palette.ai))
        case .operator where faceless:
            Self.skeleton(size: size)
        case .operator:
            let n = (name ?? "").trimmingCharacters(in: .whitespaces)
            Circle().fill(Palette.brandSoft)
                .overlay {
                    if let first = n.first {
                        Text(String(first).uppercased())
                            .font(Typeface.font(initialsSize, .bold))
                            .foregroundStyle(Palette.brand)
                    } else {
                        Image(systemName: "person.fill").font(.system(size: size * 0.42)).foregroundStyle(Palette.brand)
                    }
                }
        case .visitor where faceless && AvatarArt.osOf(os) == .none:
            Self.skeleton(size: size, seed: [name, email].compactMap { $0 }.first { !$0.isEmpty })
        case .visitor:
            let art = AvatarArt.make(name: name, email: email, os: os)
            Circle().fill(gradient(art))
                .overlay {
                    if art.os != .none {
                        Circle().fill(LinearGradient(colors: [.white.opacity(0.28), .clear], startPoint: .top, endPoint: .center)).opacity(0.7)
                        osGlyph(art.os)
                    } else {
                        Text(art.initials)
                            .font(Typeface.font(initialsSize, .semibold))
                            .foregroundStyle(.white)
                            .minimumScaleFactor(0.5)
                    }
                }
        }
    }

    /// The grey disc with a person in the middle, for someone with no face to show yet.
    /// A visitor's disc takes a soft tint of their own, picked by a hash of `seed`.
    static func skeleton(size: CGFloat, seed: String? = nil) -> some View {
        let tint = seed.map { Color(AvatarArt.tint(seed: $0)) }
        return Circle().fill(Palette.elevated)
            .overlay { Circle().fill((tint ?? .clear).opacity(0.24)) }
            .overlay {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.46))
                    .foregroundStyle(tint.map { $0.opacity(0.85) } ?? Palette.text3.opacity(0.8))
            }
    }

    private var initialsSize: CGFloat {
        switch size {
        case ...28: return 10
        case ...36: return 12
        case ...40: return 13
        case ...48: return 15
        default: return (size * 0.32).rounded()
        }
    }

    @ViewBuilder private func osGlyph(_ os: AvatarOs) -> some View {
        let s = size * 0.5
        switch os {
        case .apple: Image(systemName: "apple.logo").font(.system(size: s * 0.9, weight: .medium)).foregroundStyle(.white)
        case .windows: WindowsLogo().fill(.white).frame(width: s * 0.78, height: s * 0.78)
        case .android: Image(systemName: "iphone.gen2").font(.system(size: s * 0.85)).foregroundStyle(.white)
        case .linux: Image(systemName: "terminal.fill").font(.system(size: s * 0.8)).foregroundStyle(.white)
        case .none: EmptyView()
        }
    }

    private func gradient(_ art: AvatarArt) -> LinearGradient {
        // CSS linear-gradient(angle): 0deg points up, clockwise.
        let rad = art.angleDegrees * .pi / 180
        let dx = sin(rad), dy = -cos(rad)
        let len = abs(dx) + abs(dy)
        return LinearGradient(colors: [Color(art.from), Color(art.to)],
                              startPoint: UnitPoint(x: 0.5 - dx * len / 2, y: 0.5 - dy * len / 2),
                              endPoint: UnitPoint(x: 0.5 + dx * len / 2, y: 0.5 + dy * len / 2))
    }

    @ViewBuilder private var flag: some View {
        if size >= 32, let flag = AvatarArt.flag(countryCode) {
            Text(flag)
                .font(.system(size: max(9, size * 0.3)))
                .padding(1.5)
                .background(Palette.surface, in: Circle())
                .offset(x: -3, y: 3)
        }
    }

    @ViewBuilder private var dot: some View {
        if let presence {
            let d: CGFloat = size <= 28 ? 9 : size <= 40 ? 11 : size <= 48 ? 13 : (size * 0.24).rounded()
            let style = Palette.dot(presence)
            ZStack {
                if style.ring { Circle().fill(Palette.success.opacity(0.6)) }
                Circle().fill(style.fill).padding(style.ring ? 1.5 : 0)
                Circle().strokeBorder(Palette.surface, lineWidth: 2)
            }
            .frame(width: d, height: d)
            .offset(x: 1, y: 1)
        }
    }
}

/// The Windows logo, as the web draws it.
struct WindowsLogo: Shape {
    func path(in r: CGRect) -> Path {
        let w = r.width, h = r.height, g = w * 0.06
        var p = Path()
        p.addRect(CGRect(x: 0, y: 0, width: w / 2 - g, height: h / 2 - g))
        p.addRect(CGRect(x: w / 2 + g, y: 0, width: w / 2 - g, height: h / 2 - g))
        p.addRect(CGRect(x: 0, y: h / 2 + g, width: w / 2 - g, height: h / 2 - g))
        p.addRect(CGRect(x: w / 2 + g, y: h / 2 + g, width: w / 2 - g, height: h / 2 - g))
        return p.offsetBy(dx: r.minX, dy: r.minY)
    }
}

/// Small rounded label: status, priority, tag.
struct Chip: View {
    var text: String
    var foreground: Color = Palette.text2
    var background: Color = Palette.elevated
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 9, weight: .bold)) }
            Text(text).appFont(11, .semibold).lineLimit(1)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 8)
        .padding(.vertical, 2.5)
        .background(background, in: Capsule())
    }
}

/// A count on a sidebar row or a list header.
struct CountBadge: View {
    var count: Int
    var color: Color = Palette.brand
    @Environment(AppModel.self) private var app

    var body: some View {
        if count > 0 {
            Text(app.strings.number(min(count, 999)) + (count > 999 ? "+" : ""))
                .appFont(10.5, .bold)
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .frame(minWidth: 18, minHeight: 18)
                .background(color, in: Capsule())
        }
    }
}

/// The Windows app's InfoBar: a coloured strip with a title, a message and an action.
struct Banner: View {
    enum Severity { case info, success, warning, error }

    var severity: Severity = .info
    var title: String? = nil
    var message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var onClose: (() -> Void)? = nil

    private var color: Color {
        switch severity {
        case .info: return Palette.brand
        case .success: return Palette.success
        case .warning: return Palette.warning
        case .error: return Palette.danger
        }
    }

    private var icon: String {
        switch severity {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color).font(.system(size: 15))
            VStack(alignment: .leading, spacing: 2) {
                if let title, !title.isEmpty { Text(title).appFont(12.5, .semibold) }
                // Wraps, but never asks for its full height: `fixedSize(vertical:)` here made a
                // strip, measured at the window's narrowest, taller than the window — and the
                // whole window slid up under its title bar while the strip was shown.
                if !message.isEmpty { Text(message).appFont(12).foregroundStyle(Palette.text2).lineLimit(4) }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action).controlSize(.small).glassButton()
            }
            if let onClose {
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Palette.text3)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassCard(12, tint: color.opacity(0.18))
    }
}

/// Nothing to show yet: an icon on a soft tile, a title and a line of text.
struct EmptyState: View {
    var systemImage: String
    var title: String
    var message: String? = nil
    var tint: Color = Palette.brand

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 64, height: 64)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(title).appFont(15, .semibold).multilineTextAlignment(.center)
            if let message { Text(message).appFont(12.5).foregroundStyle(Palette.text2).multilineTextAlignment(.center) }
        }
        .padding(24)
        .frame(maxWidth: 360)
    }
}

/// A label over a section, small caps style.
struct SectionLabel: View {
    var text: String
    var body: some View {
        Text(text.uppercased(with: nil)).appFont(10.5, .semibold).foregroundStyle(Palette.text3).tracking(0.4)
    }
}

/// A label/value row in an info panel.
struct InfoRow: View {
    var label: String
    var value: String
    var valueColor: Color = Palette.text

    var body: some View {
        HStack {
            Text(label).appFont(12).foregroundStyle(Palette.text2)
            Spacer(minLength: 8)
            Text(value).appFont(12.5, .semibold).foregroundStyle(valueColor).lineLimit(1).truncationMode(.tail)
        }
    }
}

/// An icon beside a line of text, for visitor facts.
struct FactRow: View {
    var systemImage: String
    var text: String
    var selectable = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage).font(.system(size: 12)).foregroundStyle(Palette.text3).frame(width: 16)
            if selectable {
                Text(text).appFont(12.5).textSelection(.enabled)
            } else {
                Text(text).appFont(12.5)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Wraps its children onto new lines, for tags.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 300
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            line = max(line, s.height)
        }
        return CGSize(width: min(width, maxX), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// Super Admin's ad for one placement (inbox_list, colleagues_list,
/// contacts_list, chat_empty, settings); nothing when there is none.
struct CampaignCard: View {
    var placement: String
    @Environment(AppModel.self) private var app

    var body: some View {
        if let ad = app.engagement.ad(for: placement) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle().fill(Palette.brandSoft)
                        Image(systemName: "megaphone.fill").foregroundStyle(Palette.brand)
                        if let url = ad.imageUrl.flatMap(URL.init(string:)) {
                            AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { Color.clear }
                                .clipShape(Circle())
                        }
                    }
                    .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Chip(text: app.strings["adTag"], foreground: Palette.brand, background: Palette.brandSoft)
                            if let t = ad.title, !t.isEmpty { Text(t).appFont(13, .semibold).lineLimit(1) }
                        }
                        if let b = ad.body, !b.isEmpty { Text(b).appFont(12).foregroundStyle(Palette.text2).lineLimit(3) }
                    }
                    Spacer(minLength: 0)
                    if ad.dismissible {
                        Button { app.engagement.dismiss(ad) } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                            .buttonStyle(.borderless)
                            .foregroundStyle(Palette.text3)
                            .help(app.strings["close"])
                    }
                }
                if let cta = ad.ctaUrl, !cta.isEmpty {
                    Button {
                        NSWorkspace.shared.openHttps(cta)
                    } label: {
                        Label(ad.ctaLabel.flatMap { $0.isEmpty ? nil : $0 } ?? app.strings["adLearnMore"], systemImage: "arrow.up.forward")
                            .frame(maxWidth: .infinity)
                    }
                    .prominentButton()
                    .controlSize(.regular)
                }
            }
            .padding(12)
            .glassCard(16, tint: Palette.brand.opacity(0.08))
        }
    }
}

/// A search field in the app's style.
struct SearchField: View {
    var prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.text3).font(.system(size: 12))
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .appFont(13)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.text3) }
                    .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .glassCapsule()
    }
}

extension Text {
    /// Mixed Persian/English text lays out by its own first strong character.
    static func natural(_ s: String) -> Text { Text(verbatim: s) }
}
