import SwiftUI

/// The foot of Settings, where apps say what they are: the name, the version
/// and the build, and the pages a reader may want — the platform's site, the
/// privacy policy, the terms.
///
/// Small, grey and centred on the page's own background rather than rows in a
/// card: none of it is a setting, and set as rows it read as though it were.
/// The name is `BrandFooter`, the same signature the launch and sign-in
/// screens end on.
struct SettingsFooter: View {
    /// A page the footer opens in the browser.
    struct Link: Identifiable {
        let title: String
        let url: URL
        /// Also what tells the links apart, since two may share a title.
        let identifier: String
        var id: String { identifier }
    }

    let language: Language
    let version: String
    let build: String
    let links: [Link]

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            BrandFooter()

            HStack(spacing: Theme.Space.xs) {
                Text(verbatim: "\(Str.version(language)) \(version)")
                    .accessibilityIdentifier(A11y.settingsVersion)
                dot
                Text(verbatim: "\(SettingsStr.build(language)) \(build)")
                    .accessibilityIdentifier(A11y.settingsBuild)
            }
            .font(.app(.caption))
            .foregroundStyle(Theme.Palette.labelTertiary)

            if !links.isEmpty {
                // On one line when they fit; a long site name or a narrow
                // phone puts the site on its own line above the other two.
                ViewThatFits(in: .horizontal) {
                    row(links)
                    VStack(spacing: 0) {
                        row(Array(links.prefix(1)))
                        if links.count > 1 {
                            row(Array(links.dropFirst()))
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Space.md)
        .padding(.horizontal, Theme.Space.lg)
    }

    /// Links side by side with a dot between each two.
    private func row(_ links: [Link]) -> some View {
        HStack(spacing: Theme.Space.xs) {
            ForEach(Array(links.enumerated()), id: \.element.id) { index, link in
                if index > 0 {
                    dot
                }
                Button {
                    openURL(link.url)
                } label: {
                    Text(link.title)
                        .font(.app(.footnote))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .underline()
                        .lineLimit(1)
                        .fixedSize()
                        .frame(minHeight: Theme.Size.minTouchTarget)
                }
                // Each link its own target: a list row's buttons otherwise
                // all fire together, on a tap anywhere in the row.
                .buttonStyle(.borderless)
                .accessibilityIdentifier(link.identifier)
            }
        }
    }

    private var dot: some View {
        Text(verbatim: "·")
            .font(.app(.footnote))
            .foregroundStyle(Theme.Palette.labelTertiary)
            .accessibilityHidden(true)
    }
}
