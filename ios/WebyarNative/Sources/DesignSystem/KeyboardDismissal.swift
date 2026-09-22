import SwiftUI
import UIKit

extension View {
    /// Tapping anywhere on this screen puts the keyboard away, without taking
    /// the tap away from whatever was tapped.
    ///
    /// `.scrollDismissesKeyboard(.interactively)` is the SwiftUI answer and it
    /// is only half of one: it dismisses on a DRAG. Tapping the empty part of
    /// a screen is what people actually do — it is what Mail, Messages and
    /// Settings all do — and on a screen with only that modifier, nothing
    /// happens. The keyboard sits there over the list until the field is
    /// submitted or the screen is dragged.
    ///
    /// This was written as `simultaneousGesture(TapGesture())`, which is the
    /// obvious way to say it and is wrong in a way that took a bug report to
    /// find. A `TapGesture` attached to a `List` competes with the list's own
    /// cell selection, and on a row whose content is a `NavigationLink` it
    /// wins: the link stops pushing. Every List screen carrying this modifier
    /// lost its rows — Security's way into account deletion, which is how it
    /// was noticed, and the inbox, contacts, colleagues and email lists, whose
    /// rows are `NavigationLink`s in exactly the same shape.
    ///
    /// So the tap is observed rather than competed for: a `UITapGestureRecognizer`
    /// on the window, with `cancelsTouchesInView` off, which by construction
    /// cannot swallow anything — the touches carry on to the view they were
    /// always going to. It is the same reason UIKit apps have written this for
    /// fifteen years.
    func dismissesKeyboardOnTap() -> some View {
        background(KeyboardDismissInstaller().frame(width: 0, height: 0))
    }
}

/// Puts the recognizer on the window for as long as the screen is alive.
///
/// The window rather than a view of our own, because the tap has to be seen
/// wherever it lands — over a list row, over the navigation bar, over the
/// empty half of a form — and a zero-sized probe is only there to find the
/// window and to be told when the screen goes away.
private struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let probe = WindowProbe()
        probe.isUserInteractionEnabled = false
        probe.backgroundColor = .clear
        probe.onWindow = { [weak coordinator = context.coordinator] window in
            coordinator?.attach(to: window)
        }
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.detach()
    }

    /// A view that says when it has a window, which is the only moment the
    /// recognizer can be installed: `makeUIView` runs before the view is in
    /// one, and `updateUIView` is not promised to run after it is.
    final class WindowProbe: UIView {
        var onWindow: ((UIWindow?) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onWindow?(window)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var window: UIWindow?
        private var recognizer: UITapGestureRecognizer?

        func attach(to window: UIWindow?) {
            guard let window else { return detach() }
            guard window !== self.window else { return }
            detach()

            let tap = UITapGestureRecognizer(target: self, action: #selector(dismiss))
            // The whole point. Without it this is the `TapGesture` again,
            // with a different accent.
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false
            tap.delaysTouchesEnded = false
            tap.delegate = self
            window.addGestureRecognizer(tap)

            self.window = window
            self.recognizer = tap
        }

        func detach() {
            if let recognizer { window?.removeGestureRecognizer(recognizer) }
            recognizer = nil
            window = nil
        }

        @objc private func dismiss() {
            // The responder chain rather than a `FocusState` binding, because
            // the screens that need this have between zero and three fields
            // and no single piece of state that means "the keyboard".
            // `sendAction(to: nil)` hands the message to whatever is first
            // responder right now, which is the field with the caret in it by
            // definition. SwiftUI's own `@FocusState` follows the
            // resignation, so a screen that does track focus stays in step
            // without being told.
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil,
                from: nil,
                for: nil
            )
        }

        // Never block another recognizer: this one only watches.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }

        /// Not for a tap that lands in a text input.
        ///
        /// A field becomes first responder as the finger goes DOWN and this
        /// recognizer fires as it comes UP, so without this, tapping a field
        /// would focus it and then immediately put the keyboard away again —
        /// including a tap that moves the caret inside a field already being
        /// typed in.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldReceive touch: UITouch
        ) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || current is UITextView || current is UISearchBar {
                    return false
                }
                view = current.superview
            }
            return true
        }
    }
}
