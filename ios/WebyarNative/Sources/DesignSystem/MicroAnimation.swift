import Pow
import SwiftUI

/// The two micro-animations this app borrows, and the only file that imports
/// the library they come from.
///
/// SwiftUI's springs and SF Symbols' `symbolEffect` already cover most of
/// what moves here, and where they do they are used — the tab bar's icon, the
/// send arrow, the rolling digits on a queue count are all system effects.
/// What the system does not give you is a view that reacts to being *wrong*
/// or to a number going *up*: both come out as a cross-fade, which says
/// nothing.
///
/// Keeping the import here means two things. The library is used where it was
/// chosen to be used rather than sprinkled across forty files, and if it is
/// ever dropped, this file is the whole of the work — every call site asks
/// for "shake when this changes", not for a particular vendor's effect.
///
/// Both are suppressed under Reduce Motion. An effect whose entire content is
/// movement has nothing left to say when movement is what the reader has
/// asked not to see.

// MARK: - Shake

private struct ShakeOnChange<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.changeEffect(.shake(rate: .fast), value: value, isEnabled: !reduceMotion)
    }
}

// MARK: - Jump

private struct JumpOnChange<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.changeEffect(.jump(height: 5), value: value, isEnabled: !reduceMotion)
    }
}

extension View {
    /// Shakes when `value` changes: a form that has just been told no.
    ///
    /// Pass a counter rather than the error text itself. Two failed sign-ins
    /// with the same message are two rejections, and comparing the strings
    /// would animate only the first.
    func shakesOnChange(_ value: some Equatable) -> some View {
        modifier(ShakeOnChange(value: value))
    }

    /// Jumps when `value` changes: a counter that has just gone up.
    func jumpsOnChange(_ value: some Equatable) -> some View {
        modifier(JumpOnChange(value: value))
    }
}
