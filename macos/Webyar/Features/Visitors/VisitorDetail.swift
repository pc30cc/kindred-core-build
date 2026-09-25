import MapKit
import SwiftUI

/// Beside the list: the map with the live numbers over it and, for the
/// visitor picked in the list or on the map, an inspector with who they are,
/// start / open chat, their device and location, and their page history.
struct VisitorDetail: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        // A panel at the end edge, not `.inspector`: in a right-to-left window
        // that reserves the space on one side and draws on the other.
        HStack(spacing: 0) {
            VisitorsMap(model: model)
            if model.selectedId != nil {
                Divider()
                VisitorPanel(model: model)
                    .frame(width: 340)
                    .background(Palette.surface2.opacity(0.6))
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.smooth(duration: 0.22), value: model.selectedId != nil)
            .onAppear { model.start() }
            .onDisappear { if app.route != .visitors { model.stop() } }
            .alert(s["visitorStartChat"], isPresented: Binding(get: { model.chatError != nil }, set: { if !$0 { model.chatError = nil } })) {
                Button(s["ok"]) { model.chatError = nil }
            } message: {
                Text(model.chatError ?? "")
            }
    }
}

// MARK: - The selected visitor

struct VisitorPanel: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(s["visitorDetails"]).appFont(13, .semibold).lineLimit(1)
                Spacer(minLength: 4)
                Button { model.closeDetail() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Palette.text2)
                    .help(s["close"])
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            if let v = model.selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        identity(v, s)
                        actions(v, s)
                        facts(v, s)
                        historySection(s)
                    }
                    .padding(EdgeInsets(top: 18, leading: 18, bottom: 24, trailing: 18))
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Spacer()
            }
        }
    }

    private func identity(_ v: LiveVisitor, _ s: Strings) -> some View {
        let status = VisitorText.status(v)
        return VStack(spacing: 8) {
            AvatarView(name: v.contact?.name, email: v.contact?.email, os: v.os, countryCode: v.geo?.countryCode,
                       imageURL: v.contact?.avatarUrl, size: 72, presence: status)
            Text(VisitorText.name(v, s))
                .appFont(17, .bold)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            statusChip(status, s)
        }
        .frame(maxWidth: .infinity)
    }

    private func statusChip(_ status: String, _ s: Strings) -> some View {
        let style: (fore: Color, back: Color, key: String)
        switch status {
        case "online": style = (Palette.success, Palette.successSoft, "visitorOnline")
        case "idle": style = (Palette.warning, Palette.warningSoft, "visitorIdle")
        default: style = (Palette.text2, Palette.elevated, "visitorOffline")
        }
        return Chip(text: s[style.key], foreground: style.fore, background: style.back)
    }

    private func actions(_ v: LiveVisitor, _ s: Strings) -> some View {
        HStack(spacing: 8) {
            Button {
                model.chat(with: v)
            } label: {
                Label {
                    Text(v.conversation == nil ? s["visitorStartChat"] : s["visitorOpenChat"]).appFont(13, .semibold)
                } icon: {
                    if model.chatBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .prominentButton()
            .controlSize(.large)
            .disabled(model.chatBusy)
            Button {
                model.copySession()
            } label: {
                Image(systemName: model.copied ? "checkmark" : "doc.on.doc")
                    .frame(width: 18)
            }
            .glassButton()
            .controlSize(.large)
            .help(model.copied ? s["visitorCopied"] : s["visitorCopySession"])
        }
    }

    private func facts(_ v: LiveVisitor, _ s: Strings) -> some View {
        let browserOs = [v.browser, v.os].compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: " · ")
        let referrer = v.referrer.flatMap { $0.isEmpty ? nil : $0 }
        return VStack(alignment: .leading, spacing: 12) {
            VisitorFact(systemImage: "doc.text", label: s["visitorCurrentPage"], value: v.currentPage ?? "—", ltr: true)
            VisitorFact(systemImage: "mappin.and.ellipse", label: s["visitorLocation"], value: VisitorText.location(v.geo) ?? s["visitorsUnknownLocation"])
            if let ip = v.ipDisplay, !ip.isEmpty {
                VisitorFact(systemImage: "network", label: s["visitorIp"], value: ip, ltr: true)
            }
            if !browserOs.isEmpty {
                VisitorFact(systemImage: "macwindow", label: s["visitorBrowserOs"], value: browserOs, ltr: true)
            }
            if let device = v.device, !device.isEmpty {
                VisitorFact(systemImage: "desktopcomputer", label: s["visitorDeviceLabel"], value: device)
            }
            VisitorFact(systemImage: "arrow.uturn.left", label: s["visitorReferrer"], value: referrer ?? s["visitorCameFromDirect"], ltr: referrer != nil)
            if let at = v.lastActivityAt {
                VisitorFact(systemImage: "clock", label: s["visitorLastActivity"], value: VisitorText.ago(at, now: model.now, s))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel(12)
    }

    private func historySection(_ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: s["visitorPageHistory"])
            if model.historyLoading {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            } else if let steps = model.history {
                if steps.isEmpty {
                    Text(s["visitorPageHistoryEmpty"]).appFont(12.5).foregroundStyle(Palette.text2)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(steps) { step in
                            VisitStepRow(step: step, last: step.id == steps.last?.id, now: model.now)
                        }
                    }
                }
            }
        }
    }
}

/// A label over a value, beside an icon on a soft tile.
struct VisitorFact: View {
    var systemImage: String
    var label: String
    var value: String
    /// Addresses, IPs and browsers read left to right when they are Latin.
    var ltr = false
    @Environment(\.layoutDirection) private var direction

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Palette.brand)
                .frame(width: 30, height: 30)
                .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(label).appFont(11.5).foregroundStyle(Palette.text3)
                // Set out in its own direction, but kept on the reading side of the panel.
                Text(value)
                    .appFont(13)
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(valueDirection == direction ? .leading : .trailing)
                    .environment(\.layoutDirection, valueDirection)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var valueDirection: LayoutDirection {
        guard ltr else { return direction }
        return Display.isRightToLeft(value) ? .rightToLeft : .leftToRight
    }
}

/// A step of the visit on a vertical line: a dot, the title, the address and when.
struct VisitStepRow: View {
    let step: VisitStep
    let last: Bool
    let now: Date
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        HStack(alignment: .top, spacing: 12) {
            rail
            VStack(alignment: .leading, spacing: 1) {
                Text(step.label).appFont(11, .semibold).foregroundStyle(step.current ? Palette.success : Palette.text3)
                if let title = step.title, !title.isEmpty {
                    Text(title).appFont(13, .semibold).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
                }
                Text(VisitorText.shortUrl(step.url))
                    .appFont(12)
                    .foregroundStyle(Palette.text2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .environment(\.layoutDirection, .leftToRight)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(step.url ?? "")
                if let when = step.when {
                    Text(VisitorText.ago(when, now: now, s)).appFont(11).foregroundStyle(Palette.text3)
                }
            }
            .padding(.bottom, 14)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var rail: some View {
        ZStack(alignment: .top) {
            if !last {
                Rectangle().fill(Palette.line).frame(width: 2).padding(.top, 14)
            }
            Circle()
                .fill(step.current ? Palette.success : Palette.brand)
                .frame(width: 10, height: 10)
                .padding(.top, 4)
        }
        .frame(width: 14)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - The map

/// Where the visitors are, with the live numbers over it — the Windows app's
/// Leaflet map (Assets/Visitors/map.html) as a native MapKit map: a dot per
/// visitor coloured by presence, click a dot to open that visitor, picking a
/// visitor flies to them.
struct VisitorsMap: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app
    @State private var position: MapCameraPosition = .region(VisitorsMap.region(lat: 32, lng: 53, zoom: 3))
    @State private var span: MKCoordinateSpan?
    @State private var fitted = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            if model.mapDisabled {
                fallback
            } else {
                map
            }
            VisitorStats(model: model)
                .padding(12)
        }
        .onAppear {
            if let c = model.mapCenter { position = .region(Self.region(lat: c.lat, lng: c.lng, zoom: c.zoom)) }
            fit(model.mapPins)
        }
        .onChange(of: model.mapCenter) { _, c in
            guard let c, !fitted else { return }
            position = .region(Self.region(lat: c.lat, lng: c.lng, zoom: c.zoom))
        }
        .onChange(of: model.mapPins) { _, pins in fit(pins) }
        .onChange(of: model.focus) { _, f in
            guard let f else { return }
            fly(to: f)
        }
    }

    private var map: some View {
        let pins = model.mapPins
        let selected = model.selectedId
        return Map(position: $position) {
            ForEach(pins) { pin in
                Annotation(pin.place, coordinate: CLLocationCoordinate2D(latitude: pin.lat, longitude: pin.lng), anchor: .center) {
                    VisitorPinDot(status: pin.status, selected: pin.id == selected)
                        .help(pin.tooltip)
                        .onTapGesture { model.selectFromMap(pin.id) }
                }
                .annotationTitles(.hidden)
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls {
            MapZoomStepper()
            MapCompass()
        }
        .onMapCameraChange(frequency: .onEnd) { context in
            span = context.region.span
        }
    }

    private var fallback: some View {
        VStack(spacing: 8) {
            Image(systemName: "globe").font(.system(size: 34)).foregroundStyle(Palette.text3)
            Text(app.strings["visitorsMapHint"]).appFont(12.5).foregroundStyle(Palette.text2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.surface)
    }

    /// The first markers: frame them all, no closer than a country.
    private func fit(_ pins: [VisitorPin]) {
        guard !fitted, !pins.isEmpty else { return }
        fitted = true
        let lats = pins.map(\.lat), lngs = pins.map(\.lng)
        guard let minLat = lats.min(), let maxLat = lats.max(), let minLng = lngs.min(), let maxLng = lngs.max() else { return }
        let closest = Self.span(zoom: 6)
        let latDelta = min(170, max(closest.latitudeDelta, (maxLat - minLat) * 1.4))
        let lngDelta = min(360, max(closest.longitudeDelta, (maxLng - minLng) * 1.4))
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        position = .region(MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: latDelta, longitudeDelta: lngDelta)))
    }

    /// To the selected visitor, zooming in to at least country level.
    private func fly(to f: VisitorMapFocus) {
        let target = Self.span(zoom: 6)
        let current = span ?? target
        let next = MKCoordinateSpan(latitudeDelta: min(current.latitudeDelta, target.latitudeDelta),
                                    longitudeDelta: min(current.longitudeDelta, target.longitudeDelta))
        withAnimation(.easeInOut(duration: 0.6)) {
            position = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lng), span: next))
        }
    }

    /// Roughly what a Leaflet zoom level shows in a window-sized map.
    nonisolated static func span(zoom: Double) -> MKCoordinateSpan {
        let lng = min(360, 1200 / pow(2, max(0, zoom)))
        return MKCoordinateSpan(latitudeDelta: min(170, lng * 0.6), longitudeDelta: lng)
    }

    nonisolated static func region(lat: Double, lng: Double, zoom: Double) -> MKCoordinateRegion {
        MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), span: span(zoom: zoom))
    }
}

/// A visitor on the map: green with a halo when online, amber when idle,
/// grey when offline; the selected one larger with a brand ring.
struct VisitorPinDot: View {
    let status: String
    let selected: Bool

    private var color: Color {
        switch status {
        case "online": return Palette.success
        case "idle": return Color(hex: 0xF5A524)
        default: return Color(hex: 0x98A2B3)
        }
    }

    var body: some View {
        ZStack {
            if status == "online" {
                Circle().fill(Palette.success.opacity(0.22)).frame(width: 26, height: 26)
            }
            Circle()
                .fill(color)
                .frame(width: 14, height: 14)
                .overlay(Circle().strokeBorder(selected ? Palette.brand : Color.white, lineWidth: 2))
                .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
        }
        .scaleEffect(selected ? 1.35 : 1)
        .animation(.smooth(duration: 0.2), value: selected)
        .frame(width: 30, height: 30)
        .contentShape(Circle())
    }
}

/// Online, active now, countries and pages, over the map.
struct VisitorStats: View {
    let model: VisitorsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        GlassGroup(spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    online(s)
                    active(s)
                    countries(s)
                    pages(s)
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        online(s)
                        active(s)
                    }
                    HStack(spacing: 8) {
                        countries(s)
                        pages(s)
                    }
                }
            }
        }
    }

    private func online(_ s: Strings) -> some View { card(s["visitorsStatOnline"], s.number(model.onlineCount), Palette.success) }
    private func active(_ s: Strings) -> some View { card(s["visitorsStatActive"], s.number(model.activeCount), Palette.text) }
    private func countries(_ s: Strings) -> some View { card(s["visitorsStatCountries"], s.number(model.countryCount), Palette.text) }
    private func pages(_ s: Strings) -> some View { card(s["visitorsStatPages"], s.number(model.pageCount), Palette.text) }

    private func card(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            SectionLabel(text: label)
            Text(value).appFont(22, .bold).foregroundStyle(color).contentTransition(.numericText())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minWidth: 120, alignment: .leading)
        .glassCard(14)
    }
}
