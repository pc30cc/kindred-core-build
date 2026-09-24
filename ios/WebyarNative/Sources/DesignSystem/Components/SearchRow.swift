import SwiftUI

/// A search field that lives inside the list rather than in the navigation bar.
///
/// `.searchable` was the obvious choice and it is the wrong one here. UIKit
/// only hides a search bar on scroll when it has a large-title area to hide
/// in, and a large title is exactly the 52 points of empty chrome this screen
/// is trying not to spend. So the field goes into the list instead, as its
/// first row.
struct SearchRow: View {
    @Binding var text: String
    let prompt: String
    /// Owned by the enclosing list so the toolbar's magnifier can put the
    /// caret straight into the field.
    var focus: FocusState<Bool>.Binding

    static let rowInsets = EdgeInsets(
        top: Theme.Space.xs,
        leading: Theme.screenInset,
        bottom: Theme.Space.sm,
        trailing: Theme.screenInset
    )

    @Environment(\.layoutDirection) private var direction

    /// The magnifier sits on the far side from where the words start.
    ///
    /// An `HStack` mirrors under a right-to-left layout, so leaving the glyph
    /// first put it hard against the right edge in Persian -- on the same
    /// side the typing starts, with the caret pushed in behind it. Listing it
    /// last in Persian mirrors it to the left, which leaves the whole right
    /// edge to the text.
    private var magnifier: some View {
        Image(systemName: "magnifyingglass")
            .font(.system(size: 16))
            .foregroundStyle(Theme.Palette.labelSecondary)
    }

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            if direction == .leftToRight { magnifier }

            TextField(prompt, text: $text)
                .font(.app(.body))
                // Leading, which is the right edge in Persian and the left in
                // English -- the side the language starts its words on.
                .multilineTextAlignment(.leading)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused(focus)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(A11y.searchField)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: "×"))
            }

            if direction == .rightToLeft { magnifier }
        }
        .padding(.horizontal, Theme.Space.md)
        .frame(height: Theme.Size.minTouchTarget)
        // Inline in the list, so a surface rather than glass -- the same
        // rule the queue chips follow. What it gains over the old tertiary
        // grey is an edge, which is what made it hard to see as a field.
        .background {
            Capsule(style: .continuous)
                .fill(Theme.Palette.surface)
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Theme.Palette.separator.opacity(0.7), lineWidth: 0.5)
                )
                .elevated(.resting)
        }
        .animation(Theme.Motion.standard, value: text.isEmpty)
    }
}

// MARK: - The list

/// A list whose search field the toolbar's magnifier opens and closes.
///
/// This used to park the field just above the fold and ask the operator to
/// pull the list down for it, the way Mail does. Three things were wrong with
/// that, and they were all the same thing: a row that is present but scrolled
/// out of sight is still *there*.
///
///   * It showed through. The navigation bar is translucent, so the field sat
///     under the toolbar buttons as a grey ghost whenever the list was at
///     rest — the first thing anyone noticed about the screen.
///   * The magnifier could only open it. Tapping it again did nothing,
///     because "scroll to a row that is already visible" is a no-op, so there
///     was no way to put the field away except to scroll by hand.
///   * Keeping it parked took real machinery: measuring every row's height,
///     padding the list with a spacer when the content was shorter than the
///     screen, and re-scrolling on a timer while the rows settled.
///
/// The field is simply absent now until it is asked for. The magnifier
/// toggles it, closing it clears it, and a list with nothing to hide needs no
/// spacer and no measuring.
struct SearchableList<Rows: View>: View {
    @Binding var text: String
    let prompt: String
    /// Changing this closes the search: a different queue or a different
    /// workspace is a different question, and carrying the old terms across
    /// would silently filter the new list.
    let resetToken: String
    /// Raised and lowered by the toolbar's magnifier.
    @Binding var isSearching: Bool
    @ViewBuilder let rows: Rows

    @FocusState private var focused: Bool
    /// Whether the caret has actually landed in the field yet.
    ///
    /// This was written to fix a search field that opened and shut again in
    /// one frame. It does not deserve that credit: the field was never opening
    /// at all in the run that was being watched — the taps were landing in a
    /// dead strip of the screen, because the tool driving them had the
    /// simulator's window geometry wrong. `SearchFieldTests` cannot reproduce
    /// the self-closing on iOS 26 with this guard or without it.
    ///
    /// It stays because the rule it states is right on its own terms: `focused`
    /// is false for the moment between the row being inserted and the system
    /// installing the responder, and reading that first false as "the operator
    /// dismissed the keyboard" would close the thing it had just opened. A
    /// blur only means anything after a focus. It is a guard against a
    /// mistake, not a fix for a sighting.
    @State private var didFocus = false

    /// Text outlives the toggle: a field with something in it stays on screen
    /// even after the keyboard goes away, because its terms are still
    /// filtering the list below and hiding that would be a lie.
    private var showsField: Bool { isSearching || !text.isEmpty }

    var body: some View {
        List {
            if showsField {
                SearchRow(text: $text, prompt: prompt, focus: $focused)
                    .listRowInsets(SearchRow.rowInsets)
                    .listRowSeparator(.hidden)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            rows
        }
        .listStyle(.plain)
        // One place, and it covers the inbox, contacts, colleagues and the
        // email list — every screen in the app whose keyboard is opened by
        // the magnifier. With an empty field this also closes the search, via
        // the `focused` handler below, which is the same thing the operator
        // meant by tapping away from it.
        .dismissesKeyboardOnTap()
        .animation(Theme.Motion.standard, value: showsField)
        .onChange(of: isSearching) { _, wanted in
            guard wanted else {
                focused = false
                text = ""
                didFocus = false
                return
            }
            // One turn of the run loop: the row has to be in the hierarchy
            // before the caret can be put in it.
            Task { @MainActor in
                await Task.yield()
                focused = true
            }
        }
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                didFocus = true
                return
            }
            // Dismissing the keyboard over an empty field is the operator
            // saying they are done looking. A field with text in it stays,
            // and so does one the caret never reached.
            guard didFocus, text.isEmpty else { return }
            isSearching = false
        }
        .onChange(of: resetToken) { _, _ in
            isSearching = false
            text = ""
        }
    }
}
