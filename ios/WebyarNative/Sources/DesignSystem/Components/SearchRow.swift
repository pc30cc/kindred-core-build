import SwiftUI

/// A search field that lives inside the list rather than in the navigation bar.
///
/// `.searchable` was the obvious choice and it is the wrong one here. With an
/// inline title there is no large-title area above the first row for the field
/// to hide in, so `.automatic` leaves it permanently on screen — 52pt spent on
/// a control most sessions never touch. Putting it in the list instead lets the
/// list start below it, so it is out of the way until the list is pulled down,
/// which is the behaviour Mail has and the one that was asked for.
struct SearchRow: View {
    @Binding var text: String
    let prompt: String

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 16))
                .foregroundStyle(Theme.Palette.labelSecondary)

            TextField(prompt, text: $text)
                .font(.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($isFocused)
                .frame(maxWidth: .infinity)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
                .buttonStyle(.plain)
                // Clearing is a correction, not a destination: it must not
                // steal focus away from the field being corrected.
                .accessibilityLabel(Text(verbatim: "×"))
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .frame(height: Theme.Size.minTouchTarget)
        .background(
            Capsule().fill(Theme.Palette.surfaceElevated)
        )
        .animation(Theme.Motion.standard, value: text.isEmpty)
    }
}

/// Scrolls a list so its search row sits just above the fold on first
/// appearance.
///
/// Done once and without animation: the operator should find the list already
/// showing conversations, not watch it slide into place.
struct RestingBelowSearch: ViewModifier {
    let proxy: ScrollViewProxy
    let anchorID: String
    @State private var hasSettled = false

    func body(content: Content) -> some View {
        content.onAppear {
            guard !hasSettled else { return }
            hasSettled = true
            // A yield lets the list lay its rows out first; scrolling to an id
            // that has not been measured yet does nothing.
            Task { @MainActor in
                await Task.yield()
                proxy.scrollTo(anchorID, anchor: .top)
            }
        }
    }
}

extension View {
    func restingBelowSearch(proxy: ScrollViewProxy, anchorID: String) -> some View {
        modifier(RestingBelowSearch(proxy: proxy, anchorID: anchorID))
    }
}
