import SwiftUI
import Observation

@MainActor
@Observable
final class ContactsViewModel {
    private(set) var state: LoadState<[Contact]> = .loading
    /// Device and location per contact id, for the avatar's OS mark and flag.
    private(set) var visitors: [String: VisitorProfile] = [:]
    var searchText = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var visible: [Contact] {
        guard let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { contact in
            [contact.name, contact.email, contact.phone, contact.visitorCode]
                .contains { $0?.lowercased().contains(query) == true }
        }
    }

    func load(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            state = .loaded(try await api.contacts(workspaceID: workspaceID))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    func refresh(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else { return }
        do {
            let contacts = try await api.contacts(workspaceID: workspaceID)
            state = .loaded(contacts)
            await loadVisitors(contacts, workspaceID: workspaceID)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep the list we have.
        }
    }

    /// The device and country behind each contact.
    ///
    /// One request for the whole page, never one per row — the same rule the
    /// inbox follows, and the same endpoint, so a visitor cannot appear as an
    /// Android phone from Türkiye on one screen and as bare initials on the
    /// next. Decorative: a failure leaves the list rendering exactly as it is.
    private func loadVisitors(_ contacts: [Contact], workspaceID: String) async {
        visitors = (try? await api.visitorIntel(
            workspaceID: workspaceID,
            contactIDs: contacts.map(\.id)
        )) ?? [:]
    }
}

struct ContactsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = ContactsViewModel()
    @State private var isSearching = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            // Same chrome as the inbox: a small inline title and a magnifier
            // that brings the in-list field down.
            .navigationTitle(Str.tabContacts(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isSearching = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel(Str.search(language))
                }
            }
            .floatingTabBarInset()
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: workspaceID) {
                await model.load(workspaceID: workspaceID, appState: appState)
            }
    }

    @ViewBuilder
    private var content: some View {
        // Same arrangement as the inbox: one list for every state, with search
        // inside it and the list resting just below it.
        SearchRestingList(
            text: $model.searchText,
            prompt: Str.search(language),
            anchorID: Self.restAnchor,
            resetToken: workspaceID ?? "-",
            isReady: model.state.isLoaded,
            isSearching: $isSearching
        ) {
            switch model.state {
            case .loading:
                ForEach(0..<10, id: \.self) { _ in
                    ContactRowSkeleton()
                        .measuredListRow()
                }

            case .failed:
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load(workspaceID: workspaceID, appState: appState) } }
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .measuredListRow()

            case .loaded:
                if model.visible.isEmpty {
                    EmptyStateView(
                        systemImage: model.searchText.isEmpty ? "person.2" : "magnifyingglass",
                        title: model.searchText.isEmpty
                            ? Str.contactsEmptyTitle(language)
                            : Str.noResults(language),
                        message: model.searchText.isEmpty ? Str.contactsEmptyBody(language) : ""
                    )
                    .id(Self.restAnchor)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .measuredListRow()
                } else {
                    ForEach(Array(model.visible.enumerated()), id: \.element.id) { index, contact in
                        NavigationLink(value: contact) {
                            ContactRow(
                                contact: contact,
                                language: language,
                                visitor: model.visitors[contact.id]
                            )
                        }
                        // The first row is what the list rests on.
                        .id(index == 0 ? Self.restAnchor : contact.id)
                        .measuredListRow()
                    }
                }
            }
        }
        .navigationDestination(for: Contact.self) { contact in
            ContactDetailView(contact: contact)
        }
    }

    /// The row the list rests on, leaving the search field just above the fold.
    private static let restAnchor = "contacts.top"
}

/// A contact in the list: avatar, name, and the best secondary identifier we
/// have. The secondary line is omitted entirely rather than shown blank, so a
/// row never carries an empty second line.
struct ContactRow: View {
    let contact: Contact
    let language: Language
    /// Device and country behind this contact, when the server knew them.
    var visitor: VisitorProfile?

    private var displayName: String {
        Format.contactName(
            name: contact.name,
            email: contact.email,
            visitorCode: contact.visitorCode,
            language: language
        )
    }

    private var secondary: String? {
        if let email = contact.email, !email.isEmpty { return email }
        if let phone = contact.phone, !phone.isEmpty { return phone }
        return nil
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            // Same size and same rule as an inbox row, deliberately: a
            // visitor is the same person on both screens and has to look it.
            Avatar(
                name: displayName,
                imageURL: contact.avatarURL,
                size: Theme.Size.avatarMedium,
                os: visitor?.device?.os,
                device: visitor?.device?.device,
                countryCode: visitor?.geo?.countryCode
            )

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(displayName)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)

                if let secondary {
                    Text(secondary)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                        // An address or a phone number is an LTR string in
                        // every language.
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, Theme.Space.xs)
    }
}

struct ContactRowSkeleton: View {
    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Circle()
                .fill(Theme.Palette.surfaceElevated)
                .frame(width: Theme.Size.avatarMedium, height: Theme.Size.avatarMedium)

            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 130, height: 13)
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 180, height: 11)
            }
        }
        .padding(.vertical, Theme.Space.xs)
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}
