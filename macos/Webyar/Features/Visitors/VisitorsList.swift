import SwiftUI

/// The live list, as in the web console and the Windows app: the online
/// count, search, the Online / Has conversation / country filters, the
/// "include offline" switch, and a row per visitor with where they are and
/// what they are reading.
struct VisitorsList: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let rows = model.visible
        VStack(spacing: 0) {
            header(s)
            SearchField(prompt: s["visitorsSearch"], text: $model.search)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            VisitorFilters(model: model)
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            Divider()
            ZStack {
                list(rows)
                overlay(rows, s)
            }
        }
        .onAppear { model.start() }
        .onDisappear { if app.route != .visitors { model.stop() } }
    }

    private func header(_ s: Strings) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 8) {
                    Text(s["navVisitors"]).appFont(20, .bold).lineLimit(1)
                    onlineChip(s)
                }
                Text(s["visitorsSubtitle"]).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help(s["visitorsRefresh"])
                .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private func onlineChip(_ s: Strings) -> some View {
        HStack(spacing: 5) {
            Circle().fill(Palette.success).frame(width: 7, height: 7)
            Text(s.number(model.onlineCount)).appFont(11, .semibold)
        }
        .foregroundStyle(Palette.success)
        .padding(.horizontal, 8)
        .padding(.vertical, 2.5)
        .background(Palette.successSoft, in: Capsule())
        .help(s["visitorsStatOnline"])
    }

    /// The rows draw their own soft highlight: the system's accent-blue selection
    /// turned the grey place and address lines unreadable.
    private func list(_ rows: [LiveVisitor]) -> some View {
        ScrollViewReader { proxy in
            List {
                ForEach(rows) { v in
                    VisitorRow(visitor: v, now: model.now, selected: v.id == model.selectedId)
                        .onTapGesture { model.select(v.id) }
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
                        .contextMenu { rowMenu(v) }
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
            .animation(.smooth(duration: 0.2), value: rows.map(\.id))
            .focusable()
            .focusEffectDisabled()
            .onKeyPress(.downArrow) { step(1, in: rows, proxy) }
            .onKeyPress(.upArrow) { step(-1, in: rows, proxy) }
            .onKeyPress(.escape) {
                guard model.selectedId != nil else { return .ignored }
                model.closeDetail()
                return .handled
            }
            .onChange(of: model.reveal) { _, r in
                guard let r else { return }
                withAnimation(.smooth) { proxy.scrollTo(r.id, anchor: .center) }
            }
        }
    }

    /// The arrow keys move the pick up and down the list, as they did with the system selection.
    private func step(_ by: Int, in rows: [LiveVisitor], _ proxy: ScrollViewProxy) -> KeyPress.Result {
        guard !rows.isEmpty else { return .ignored }
        let at = rows.firstIndex { $0.id == model.selectedId }
        let next = at.map { min(rows.count - 1, max(0, $0 + by)) } ?? (by > 0 ? 0 : rows.count - 1)
        model.select(rows[next].id)
        proxy.scrollTo(rows[next].id)
        return .handled
    }

    @ViewBuilder private func rowMenu(_ v: LiveVisitor) -> some View {
        let s = app.strings
        Button {
            model.chat(with: v)
        } label: {
            Label(v.conversation == nil ? s["visitorStartChat"] : s["visitorOpenChat"], systemImage: "bubble.left.and.bubble.right")
        }
        .disabled(model.chatBusy)
        Button {
            model.copySession(v.id)
        } label: {
            Label(s["visitorCopySession"], systemImage: "doc.on.doc")
        }
    }

    @ViewBuilder private func overlay(_ rows: [LiveVisitor], _ s: Strings) -> some View {
        if model.loading && model.visitors.isEmpty {
            ProgressView().controlSize(.regular)
        } else if rows.isEmpty {
            if model.failed {
                VStack(spacing: 4) {
                    EmptyState(systemImage: "globe", title: s["visitorsErrorTitle"])
                    Button(s["visitorsRetry"]) { model.refresh() }
                        .glassButton()
                }
            } else if model.visitors.isEmpty {
                EmptyState(systemImage: "globe", title: s["visitorsEmptyTitle"], message: s["visitorsEmptyBody"])
            } else {
                EmptyState(systemImage: "globe", title: s["visitorsNoResults"])
            }
        }
    }
}

/// Online, Has conversation, the country, and "include offline".
struct VisitorFilters: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Toggle(isOn: $model.onlineOnly) { Text(s["visitorsFilterOnline"]).appFont(12.5) }
                    .toggleStyle(.button)
                Toggle(isOn: $model.chatOnly) { Text(s["visitorsFilterChat"]).appFont(12.5) }
                    .toggleStyle(.button)
                countryPicker(s)
                Spacer(minLength: 0)
            }
            Toggle(isOn: Binding(get: { model.includeOffline }, set: { model.setIncludeOffline($0) })) {
                Text(s["visitorsIncludeOffline"]).appFont(12.5)
            }
            .toggleStyle(.switch)
        }
        .controlSize(.small)
    }

    private func countryPicker(_ s: Strings) -> some View {
        @Bindable var model = model
        return Picker(s["visitorsFilterCountry"], selection: $model.country) {
            Text(s["visitorsAllCountries"]).tag(String?.none)
            ForEach(model.countries) { c in
                Text(countryLabel(c)).tag(String?.some(c.code))
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize()
        .help(s["visitorsFilterCountry"])
    }

    private func countryLabel(_ c: VisitorCountry) -> String {
        if let flag = AvatarArt.flag(c.code) { return flag + " " + c.name }
        return c.name
    }
}

/// A visitor in the list: avatar with OS, flag and presence, the name,
/// "In chat" when they have a conversation, where and when, and the page.
struct VisitorRow: View {
    let visitor: LiveVisitor
    let now: Date
    var selected = false
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    var body: some View {
        let v = visitor
        let s = app.strings
        HStack(alignment: .top, spacing: 12) {
            AvatarView(name: v.contact?.name, email: v.contact?.email, os: v.os, countryCode: v.geo?.countryCode,
                       imageURL: v.contact?.avatarUrl, size: 40, presence: VisitorText.status(v))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(VisitorText.name(v, s)).appFont(13.5, .semibold).lineLimit(1)
                    Spacer(minLength: 4)
                    if v.conversation != nil {
                        Chip(text: s["visitorInChat"], foreground: Palette.brand, background: Palette.brandSoft)
                    }
                }
                Text(whereLine(s)).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
                // Addresses read left to right whatever the language, on the reading side of the row.
                Text(VisitorText.shortUrl(v.currentPage))
                    .appFont(12)
                    .foregroundStyle(selected ? Palette.text2 : Palette.text3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .environment(\.layoutDirection, .leftToRight)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
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

    private func whereLine(_ s: Strings) -> String {
        let place = VisitorText.location(visitor.geo) ?? s["visitorsUnknownLocation"]
        guard let at = visitor.lastActivityAt else { return place }
        return place + " · " + VisitorText.ago(at, now: now, s)
    }
}
