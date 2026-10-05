import SwiftUI
import Observation

@MainActor
@Observable
final class CannedResponsesModel {
    private(set) var state: LoadState<[CannedResponse]> = .loading
    var search = ""

    private let api: any WebyarAPI
    /// The query the current request was made for, so a stale answer arriving
    /// after a newer one cannot overwrite it.
    private var inFlight: String?

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    func load(workspaceID: String?, locale: String) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        let query = search
        inFlight = query
        do {
            let items = try await api.cannedResponses(
                workspaceID: workspaceID, locale: locale, query: query
            )
            guard inFlight == query else { return }
            state = .loaded(items)
        } catch let error as APIError {
            guard inFlight == query else { return }
            state = .failed(error)
        } catch {
            guard inFlight == query else { return }
            state = .failed(.transport)
        }
    }

    /// Advisory, and deliberately unawaited by the caller: the list is ordered
    /// partly by how often each reply is used, and a network hiccup recording
    /// that must never keep a message from going out.
    func trackUse(_ id: String, workspaceID: String?) {
        guard let workspaceID else { return }
        Task { [api] in try? await api.trackCannedResponseUse(id: id, workspaceID: workspaceID) }
    }
}

/// The saved replies, as a sheet.
///
/// The console shows these as a popover above the composer and drives them
/// from the keyboard — arrows to move, Enter to insert. Neither exists on a
/// phone, so this is a sheet with a search field and rows big enough to hit,
/// which is the same idea in the shape this device has.
struct CannedResponsePicker: View {
    let language: Language
    let workspaceID: String?
    let context: CannedText.Context
    /// Hands back the text with its placeholders already filled in, and the
    /// row's id so the use can be recorded once the message actually goes.
    let onPick: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var model = CannedResponsesModel()

    var body: some View {
        @Bindable var model = model

        NavigationStack {
            content
                .navigationTitle(Str.shortcuts(language))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(Str.cancel(language)) { dismiss() }
                    }
                }
                .searchable(
                    text: $model.search,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Str.searchShortcuts(language)
                )
                .task(id: model.search) {
                    // A beat, so typing does not fire a request per keystroke.
                    try? await Task.sleep(for: .milliseconds(220))
                    guard !Task.isCancelled else { return }
                    await model.load(workspaceID: workspaceID, locale: language.rawValue)
                }
        }
        .presentationDetents([.medium, .large])
        .environment(\.layoutDirection, language.layoutDirection)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            List {
                ForEach(0..<5, id: \.self) { _ in ShortcutRowSkeleton() }
            }
            .listStyle(.plain)

        case .failed(let error) where error.isFeatureMissing:
            // Not a failure to retry. This deployment's database was built
            // from the self-host chain before it carried the saved-replies
            // table, so there is nothing here and asking again will not
            // change that. An offline banner with a Try again button would
            // send the operator round a loop that has no exit.
            EmptyStateView(
                systemImage: "bolt.slash",
                title: Str.shortcutsUnavailableTitle(language),
                message: Str.shortcutsUnavailableBody(language)
            )

        case .failed:
            ErrorStateView(
                title: Str.offlineTitle(language),
                message: Str.offlineBody(language),
                retryTitle: Str.retry(language),
                onRetry: {
                    Task { await model.load(workspaceID: workspaceID, locale: language.rawValue) }
                }
            )

        case .loaded(let items):
            if items.isEmpty {
                // Two different emptinesses, and conflating them would send an
                // operator looking for a typo in a workspace that has no saved
                // replies at all.
                EmptyStateView(
                    systemImage: model.search.isEmpty ? "bolt" : "magnifyingglass",
                    title: model.search.isEmpty
                        ? Str.shortcutsEmptyTitle(language)
                        : Str.noResults(language),
                    message: model.search.isEmpty ? Str.shortcutsEmptyBody(language) : ""
                )
            } else {
                List(items) { item in
                    Button {
                        onPick(CannedText.interpolate(item.body, context), item.id)
                        dismiss()
                    } label: {
                        CannedResponseRow(item: item, language: language)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(A11y.shortcutRow(item.id))
                }
                .listStyle(.plain)
            }
        }
    }
}

private struct CannedResponseRow: View {
    let item: CannedResponse
    let language: Language

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            HStack(spacing: Theme.Space.sm) {
                // The shortcut is typed, not read: it stays Latin and
                // left-to-right in every language, like a command.
                Text(verbatim: "/\(item.shortcut)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Theme.Palette.brand)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(Theme.Palette.brand.opacity(0.12))
                    )
                    .environment(\.layoutDirection, .leftToRight)

                Text(item.title)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)

                Spacer(minLength: 0)
            }

            Text(item.body)
                .font(Theme.Typo.rowSubtitle)
                .foregroundStyle(Theme.Palette.labelSecondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.Space.xxs)
        .contentShape(Rectangle())
    }
}

private struct ShortcutRowSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .fill(Theme.Palette.surfaceElevated)
                .frame(width: 140, height: 13)
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .fill(Theme.Palette.surfaceElevated)
                .frame(maxWidth: .infinity)
                .frame(height: 11)
        }
        .padding(.vertical, Theme.Space.xxs)
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

/// What a composer needs in order to offer saved replies.
///
/// Bundled into one value rather than three parameters because the whole thing
/// is optional together: a composer either can reach the workspace's replies
/// and knows what to fill their placeholders from, or it offers no button.
struct ShortcutSource {
    let workspaceID: String?
    let context: CannedText.Context
    /// Called once a message containing this reply has actually been sent.
    let onUsed: (String) -> Void
}
