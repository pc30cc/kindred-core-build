import SwiftUI

/// A contact's details.
///
/// The header is a centred identity block; everything factual below it is a
/// grouped `List`, which is the form iOS uses for exactly this and which gives
/// correct label/value alignment, separator insets and RTL mirroring for free.
struct ContactDetailView: View {
    let contact: Contact

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale

    /// Device and location behind this contact. Loaded here rather than
    /// passed in, because this screen is reachable from a deep link as well
    /// as from the list, and the avatar rule cannot depend on how you got
    /// here.
    @State private var visitor: VisitorProfile?

    private var language: Language { appState.language }

    private var displayName: String {
        Format.contactName(
            name: contact.name,
            email: contact.email,
            visitorCode: contact.visitorCode,
            language: language
        )
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: Theme.Space.md) {
                    Avatar(
                        name: displayName,
                        imageURL: contact.avatarURL,
                        size: Theme.Size.avatarLarge,
                        os: visitor?.device?.os,
                        device: visitor?.device?.device,
                        countryCode: visitor?.geo?.countryCode
                    )

                    Text(displayName)
                        .font(.app(.title2, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.Palette.label)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Space.lg)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            if hasDetails {
                Section {
                    if let email = contact.email, !email.isEmpty {
                        DetailRow(label: Str.emailLabel(language), value: email, isLatin: true)
                    }
                    if let phone = contact.phone, !phone.isEmpty {
                        DetailRow(label: phoneLabel, value: phone, isLatin: true)
                    }
                    if let code = contact.visitorCode, !code.isEmpty {
                        DetailRow(label: Str.unknownVisitor(language), value: code, isLatin: true)
                    }
                    if let created = contact.createdAt {
                        DetailRow(
                            label: createdLabel,
                            value: Format.dayHeader(created, locale: locale),
                            isLatin: false
                        )
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(displayName)
        .task {
            guard let workspaceID = appState.selectedWorkspace?.id else { return }
            visitor = try? await Backend.current.visitorIntel(
                workspaceID: workspaceID,
                contactIDs: [contact.id]
            )[contact.id]
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private var hasDetails: Bool {
        !(contact.email ?? "").isEmpty
            || !(contact.phone ?? "").isEmpty
            || !(contact.visitorCode ?? "").isEmpty
            || contact.createdAt != nil
    }

    private var phoneLabel: String {
        switch language {
        case .en: "Phone"
        case .fa: "تلفن"
        case .tr: "Telefon"
        }
    }

    private var createdLabel: String {
        switch language {
        case .en: "First seen"
        case .fa: "نخستین بازدید"
        case .tr: "İlk görülme"
        }
    }
}

/// A label on the leading edge and its value on the trailing edge.
///
/// The emphasis follows the iOS convention — label in the primary colour, value
/// in the secondary one — because that is how every Settings row on the device
/// reads, and inverting it makes the label look disabled.
///
/// The label is never the thing that truncates, and `isLatin` forces LTR on
/// values — addresses, phone numbers, codes — that are the same in every
/// language and would be scrambled by mirroring.
struct DetailRow: View {
    let label: String
    let value: String
    var isLatin: Bool = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.lg) {
            Text(label)
                .font(.app(.body))
                .foregroundStyle(Theme.Palette.label)
                .layoutPriority(1)
                .fixedSize(horizontal: true, vertical: false)

            Spacer(minLength: Theme.Space.sm)

            Text(value)
                .font(.app(.body))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
                .modifier(LatinIfNeeded(isLatin: isLatin))
        }
        .frame(minHeight: Theme.Size.minTouchTarget - 10)
    }
}

