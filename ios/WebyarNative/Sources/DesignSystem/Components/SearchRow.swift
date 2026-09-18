import SwiftUI
import Observation

/// A search field that lives inside the list rather than in the navigation bar.
///
/// `.searchable` was the obvious choice and it is the wrong one here. UIKit
/// only hides a search bar on scroll when it has a large-title area to hide
/// in, and a large title is exactly the 52 points of empty chrome this screen
/// is trying not to spend. So the field goes into the list instead, as its
/// first row, and `SearchRestingList` keeps the list resting just below it.
struct SearchRow: View {
    @Binding var text: String
    let prompt: String

    /// The room this row takes in a list, its padding included.
    ///
    /// `SearchRestingList` scrolls by exactly this much, so the two numbers
    /// have to come from one place.
    static let blockHeight = Theme.Size.minTouchTarget + Theme.Space.xs + Theme.Space.sm

    static let rowInsets = EdgeInsets(
        top: Theme.Space.xs,
        leading: Theme.screenInset,
        bottom: Theme.Space.sm,
        trailing: Theme.screenInset
    )

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

// MARK: - Measuring the list

/// The summed height of the list rows that are currently laid out.
private struct ListContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value += nextValue()
    }
}

extension View {
    /// Report this row's height to the enclosing `SearchRestingList`.
    ///
    /// Every row inside one has to do this, because the list can only park its
    /// search field out of sight if it knows whether it is long enough to
    /// scroll at all.
    ///
    /// - Parameter insets: the row's vertical `listRowInsets`, which sit
    ///   outside the measured view and so have to be added by hand.
    func measuredListRow(insets: CGFloat = 0) -> some View {
        background(
            GeometryReader { geo in
                Color.clear.preference(
                    key: ListContentHeight.self,
                    value: geo.size.height + insets
                )
            }
        )
    }
}

/// What the list has measured about itself.
///
/// A reference type rather than plain `@State` because `onPreferenceChange`
/// hands its value to a `@Sendable` closure, which cannot reach into a view's
/// storage. Main-actor isolated, so it is `Sendable` and the closure can
/// capture it.
@MainActor
@Observable
final class ListMetrics {
    /// The visible height of the list, safe areas excluded.
    var viewport: CGFloat = 0
    /// The height of everything in it.
    var content: CGFloat = 0

    nonisolated init() {}
}

// MARK: - The list

/// A list whose first row is a search field that rests just out of sight.
///
/// Pulling the list down brings the field in and leaves it there; scrolling
/// back up puts it away again. That is how Mail behaves, and getting it takes
/// two things that SwiftUI does not give for free:
///
/// * The list has to be *able* to scroll by the field's height. A queue with
///   three conversations in it is shorter than the screen and cannot scroll at
///   all, which would strand the field on screen — so a spacer makes up the
///   shortfall, and exactly the shortfall, so scrolling to the bottom never
///   lands in a void.
/// * It then has to actually rest there, once, after the rows have been laid
///   out and without an animation the operator has to sit through.
struct SearchRestingList<Rows: View>: View {
    @Binding var text: String
    let prompt: String
    /// The row the list rests on. The caller tags it with `.id(_:)`.
    let anchorID: String
    /// Changing this puts the list back at its resting position — a different
    /// queue or a different workspace starts the list over.
    let resetToken: String
    /// False while the rows below are placeholders. Resting on a skeleton is
    /// pointless: the real rows replace it and take the fold with them.
    let isReady: Bool
    @ViewBuilder let rows: Rows

    @State private var metrics = ListMetrics()
    @State private var restedFor: String?

    private var spacer: CGFloat {
        guard metrics.viewport > 0, metrics.content > 0 else { return 0 }
        return max(0, metrics.viewport + SearchRow.blockHeight - metrics.content)
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                SearchRow(text: $text, prompt: prompt)
                    .listRowInsets(SearchRow.rowInsets)
                    .listRowSeparator(.hidden)
                    .measuredListRow(insets: Theme.Space.xs + Theme.Space.sm)

                rows

                if spacer > 0 {
                    Color.clear
                        .frame(height: spacer)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .accessibilityHidden(true)
                }
            }
            .listStyle(.plain)
            // The spacer is often shorter than a row, and a list that enforces
            // its own minimum on it would overshoot the resting position.
            .environment(\.defaultMinListRowHeight, 0)
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { metrics.viewport = visible(geo) }
                        .onChange(of: visible(geo)) { _, height in
                            metrics.viewport = height
                        }
                }
            )
            .onPreferenceChange(ListContentHeight.self) { [metrics] height in
                Task { @MainActor in metrics.content = height }
            }
            .onChange(of: restKey, initial: true) { _, _ in
                rest(with: proxy)
            }
        }
    }

    private func visible(_ geo: GeometryProxy) -> CGFloat {
        geo.size.height - geo.safeAreaInsets.top - geo.safeAreaInsets.bottom
    }

    /// Everything the resting position depends on, in one value.
    private var restKey: String {
        "\(resetToken)|\(isReady)|\(Int(metrics.viewport))|\(Int(metrics.content))"
    }

    private func rest(with proxy: ScrollViewProxy) {
        guard isReady, restedFor != resetToken,
              metrics.viewport > 0, metrics.content > 0
        else { return }
        restedFor = resetToken
        Task { @MainActor in
            // One turn of the run loop so the spacer row that makes this
            // scroll possible is laid out before it is asked for.
            await Task.yield()
            proxy.scrollTo(anchorID, anchor: .top)
        }
    }
}
