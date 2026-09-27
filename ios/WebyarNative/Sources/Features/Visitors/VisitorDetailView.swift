import SwiftUI
import UIKit

/// One visitor: who they are, whether they are still here, what they are
/// running, where they came from and the pages they have been through — and
/// the one thing an operator came here to do, start a chat.
///
/// Reads the visitor from the live list by session id, so the status and the
/// page keep up while it is open. Somebody who drops off the list is still
/// shown as they were last seen, with a line saying they have gone, rather
/// than the page emptying under the operator.
struct VisitorDetailView: View {
    let sessionID: String
    let model: VisitorsViewModel

    @Environment(AppState.self) private var appState
    @State private var push = PushController.shared
    @State private var copied = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        Group {
            if let visitor = model.visitor(id: sessionID) {
                content(visitor)
            } else {
                // Only reachable if the workspace changed under the page.
                EmptyStateView(
                    systemImage: "person.crop.circle.badge.questionmark",
                    title: Str.visitorsEmptyTitle(language),
                    message: ""
                )
            }
        }
        .navigationTitle(Str.visitorDetails(language))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sessionID) {
            await model.loadHistory(sessionID: sessionID, workspaceID: workspaceID, appState: appState)
        }
        .alert(
            Str.visitorStartChat(language),
            isPresented: Binding(get: { model.chatFailed }, set: { if !$0 { model.chatFailed = false } })
        ) {
            Button(Str.ok(language), role: .cancel) { model.chatFailed = false }
        } message: {
            Text(Str.visitorChatFailed(language))
        }
    }

    private func content(_ visitor: LiveVisitor) -> some View {
        List {
            Section {
                identity(visitor)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: Theme.Space.md, leading: 0, bottom: Theme.Space.sm, trailing: 0))
            }

            if !model.isListed(sessionID) {
                Section {
                    Label(Str.visitorLeft(language), systemImage: "figure.walk.departure")
                        .font(.subheadline)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
            }

            Section {
                actions(visitor)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }

            Section {
                facts(visitor)
            }

            Section(Str.visitorPageHistory(language)) {
                history
            }
        }
        .listStyle(.insetGrouped)
        .animation(Theme.Motion.standard, value: model.isListed(sessionID))
    }

    // MARK: - Who

    private func identity(_ visitor: LiveVisitor) -> some View {
        let name = VisitorFormat.name(visitor, language: language)
        return VStack(spacing: Theme.Space.sm) {
            Avatar(
                name: name,
                imageURL: visitor.contact?.avatarURL,
                size: Theme.Size.avatarLarge,
                os: visitor.os,
                device: visitor.device,
                countryCode: visitor.geo?.countryCode
            )
            .overlay(alignment: .topTrailing) {
                PresenceDot(presence: visitor.presence, size: 18)
                    .offset(x: -2, y: 2)
            }

            Text(name)
                .font(.title3.weight(.bold))
                .foregroundStyle(Theme.Palette.label)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)

            if let email = visitor.contact?.email, !email.isEmpty, email != name {
                Text(email)
                    .font(.subheadline)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .latin()
                    .textSelection(.enabled)
            }

            HStack(spacing: Theme.Space.xs) {
                StatusPill(
                    text: VisitorFormat.presence(visitor.presence, language: language),
                    tint: PresenceDot.color(visitor.presence)
                )
                if visitor.conversation != nil {
                    StatusPill(text: Str.visitorInChat(language), tint: Theme.Palette.brand)
                }
            }
            .animation(Theme.Motion.standard, value: visitor.presence)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    // MARK: - What to do

    private func actions(_ visitor: LiveVisitor) -> some View {
        HStack(spacing: Theme.Space.sm) {
            PrimaryButton(
                title: visitor.conversation == nil ? Str.visitorStartChat(language) : Str.visitorOpenChat(language),
                isLoading: model.chatBusy
            ) {
                Task { await openChat(visitor) }
            }

            Button {
                UIPasteboard.general.string = visitor.id
                Haptics.success()
                withAnimation(Theme.Motion.standard) { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    withAnimation(Theme.Motion.standard) { copied = false }
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.body.weight(.semibold))
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: Theme.Size.minTouchTarget + 6, height: Theme.Size.minTouchTarget + 6)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .fill(Theme.Palette.surface)
                    )
            }
            .buttonStyle(.plain)
            .foregroundStyle(copied ? Theme.Palette.success : Theme.Palette.brand)
            .accessibilityLabel(copied ? Str.visitorCopied(language) : Str.visitorCopySession(language))
        }
    }

    /// Opens the conversation in the inbox — the same route a tapped
    /// notification takes, so the thread arrives exactly as it would from a
    /// banner, and the inbox comes forward on its own.
    private func openChat(_ visitor: LiveVisitor) async {
        guard let workspaceID,
              let conversationID = await model.conversationID(for: visitor, workspaceID: workspaceID, appState: appState)
        else { return }
        Haptics.selection()
        push.pendingOpen = PushController.PendingConversation(workspaceID: workspaceID, conversationID: conversationID)
    }

    // MARK: - Facts

    @ViewBuilder
    private func facts(_ visitor: LiveVisitor) -> some View {
        let page = visitor.currentPage.flatMap { $0.isEmpty ? nil : $0 }
        VisitorFactRow(systemImage: "doc.text", label: Str.visitorCurrentPage(language),
                       value: page.map { VisitorText.shortURL($0) } ?? "—", latin: page != nil)

        VisitorFactRow(systemImage: "mappin.and.ellipse", label: Str.visitorLocation(language),
                       value: VisitorFormat.location(visitor.geo, language: language),
                       leading: VisitorText.flag(visitor.geo?.countryCode))

        if let ip = visitor.ipDisplay, !ip.isEmpty {
            VisitorFactRow(systemImage: visitor.ipLocked ? "lock" : "network",
                           label: Str.visitorIPAddress(language), value: ip, latin: true)
        }

        let browserOS = [visitor.browser, visitor.os]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        if !browserOS.isEmpty {
            VisitorFactRow(systemImage: "safari", label: Str.visitorBrowserOS(language), value: browserOS, latin: true)
        }

        if let device = visitor.device, !device.isEmpty {
            VisitorFactRow(systemImage: VisitorFormat.deviceIcon(device), label: Str.visitorDevice(language),
                           value: VisitorFormat.device(device, language: language))
        }

        let referrer = visitor.referrer.flatMap { $0.isEmpty ? nil : $0 }
        VisitorFactRow(systemImage: "arrow.uturn.left", label: Str.visitorReferrer(language),
                       value: referrer.map { VisitorText.shortURL($0) } ?? Str.visitorDirect(language),
                       latin: referrer != nil)

        if let at = visitor.lastActivityAt {
            VisitorFactRow(systemImage: "clock", label: Str.visitorLastActivity(language),
                           value: VisitorFormat.ago(at, now: model.now, language: language))
        }
    }

    // MARK: - History

    @ViewBuilder
    private var history: some View {
        if model.historyLoading, model.history == nil {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .padding(.vertical, Theme.Space.sm)
        } else if let steps = model.history, !steps.isEmpty {
            ForEach(steps) { step in
                VisitStepRow(step: step, isLast: step.id == steps.last?.id, now: model.now, language: language)
                    .listRowSeparator(.hidden)
            }
        } else {
            QuietRow(text: Str.visitorPageHistoryEmpty(language))
        }
    }
}

/// A label over a value, beside an icon on a soft tile — the rows of a
/// visitor's page.
private struct VisitorFactRow: View {
    let systemImage: String
    let label: String
    let value: String
    /// Addresses, IPs and browser names read left to right in every language.
    var latin = false
    /// A flag before the value.
    var leading: String?

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.Palette.brand)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .fill(Theme.Palette.brand.opacity(0.12))
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(label)
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                HStack(spacing: Theme.Space.xs) {
                    if let leading { Text(leading).accessibilityHidden(true) }
                    Text(value)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Palette.label)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .latin(latin)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .combine)
    }
}

/// A step of the visit on a vertical rail: a dot, what kind of step it was,
/// the page's title, its address and when.
private struct VisitStepRow: View {
    let step: VisitStep
    let isLast: Bool
    let now: Date
    let language: Language

    private var kindTitle: String {
        switch step.kind {
        case .entry: Str.visitorEntryPoint(language)
        case .journey: Str.visitorJourney(language)
        case .current: Str.visitorCurrentlyOn(language)
        }
    }

    private var tint: Color {
        step.kind == .current ? Theme.Palette.success : Theme.Palette.brand
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            rail
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(kindTitle)
                    .font(Theme.Typo.metaEmphasis)
                    .foregroundStyle(step.kind == .current ? Theme.Palette.success : Theme.Palette.labelSecondary)
                if let title = step.title, !title.isEmpty {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.Palette.label)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let address = VisitorText.shortURL(step.url)
                if !address.isEmpty {
                    Text(address)
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let at = step.at {
                    Text(VisitorFormat.ago(at, now: now, language: language))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
            }
            .padding(.bottom, isLast ? 0 : Theme.Space.md)
        }
        // The row takes its content's height, and the rail fills exactly that.
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    /// The dot, and the line on to the next step. Drawn in the row's own
    /// height, so it grows with Dynamic Type instead of breaking between rows.
    private var rail: some View {
        ZStack(alignment: .top) {
            if !isLast {
                Rectangle()
                    .fill(Theme.Palette.separator)
                    .frame(width: 2)
                    .padding(.top, 14)
                    .frame(maxHeight: .infinity)
            }
            Circle()
                .fill(tint)
                .frame(width: 10, height: 10)
                .overlay {
                    if step.kind == .current {
                        Circle().stroke(tint.opacity(0.3), lineWidth: 4)
                    }
                }
                .padding(.top, 4)
        }
        .frame(width: 14)
        .frame(maxHeight: .infinity, alignment: .top)
        .accessibilityHidden(true)
    }
}
