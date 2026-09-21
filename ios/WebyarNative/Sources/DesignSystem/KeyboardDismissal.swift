import SwiftUI
import UIKit

extension View {
    /// Tapping anywhere on this view puts the keyboard away.
    ///
    /// `.scrollDismissesKeyboard(.interactively)` is the SwiftUI answer and it
    /// is only half of one: it dismisses on a DRAG. Tapping the empty part of
    /// a screen is what people actually do — it is what Mail, Messages and
    /// Settings all do — and on a screen with only that modifier, nothing
    /// happens. The keyboard sits there over the list until the field is
    /// submitted or the screen is dragged.
    ///
    /// `simultaneousGesture` rather than `onTapGesture`, because this rides
    /// alongside a row's own tap instead of replacing it: a tap on a
    /// conversation still opens the conversation, and puts the keyboard away
    /// on the way, which is what tapping a row means anyway.
    ///
    /// The responder chain rather than a `FocusState` binding, because the
    /// screens that need this have between zero and three fields and no
    /// single piece of state that means "the keyboard". `sendAction(to: nil)`
    /// hands the message to whatever is first responder right now, which is
    /// the field with the caret in it by definition. SwiftUI's own
    /// `@FocusState` follows the resignation, so a screen that does track
    /// focus stays in step without being told.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(
            TapGesture().onEnded {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil,
                    from: nil,
                    for: nil
                )
            }
        )
    }
}
