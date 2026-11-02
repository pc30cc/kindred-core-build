import Foundation

/// Something in the app that plays or records on its own audio session — a
/// voice note — and has to stop the moment a colleague call takes the audio.
@MainActor
protocol CallAudioYielding: AnyObject {
    /// Stop now: a call is starting. What was recorded is the yielder's to
    /// keep or drop, exactly as when iOS itself interrupts it.
    func yieldToCall()
}

/// Who holds the audio while a colleague call is on.
///
/// CallKit owns the audio session for the length of a call: it activates it,
/// it deactivates it, and the call's engine starts only when it says so
/// (`CallManager`). A voice note playing or recording at that moment would
/// still be holding the same shared session with its own category —
/// `.playback`, or `.playAndRecord` in `.spokenAudio` — and setting it active
/// or inactive behind CallKit's back is what leaves a call silent. So the
/// call stops every voice note when it starts, and none can start until it
/// is over.
///
/// The voice notes register themselves here while they hold the session and
/// leave when they let go; held weakly, so a bubble scrolled away is simply
/// gone from the list.
@MainActor
final class CallAudioFocus {
    static let shared = CallAudioFocus()

    /// A colleague call holds the audio: voice notes neither play nor record.
    private(set) var isHeldByCall = false

    private var holders: [Holder] = []

    private struct Holder {
        weak var value: (any CallAudioYielding)?
    }

    /// A voice note took the audio session. Refused while a call holds it —
    /// the caller then does not start.
    func claim(_ holder: any CallAudioYielding) -> Bool {
        guard !isHeldByCall else { return false }
        holders.removeAll { $0.value == nil || $0.value === holder }
        holders.append(Holder(value: holder))
        return true
    }

    /// The voice note let the session go.
    func release(_ holder: any CallAudioYielding) {
        holders.removeAll { $0.value == nil || $0.value === holder }
    }

    /// A colleague call is starting: every voice note stops, and none starts
    /// until `callEnded()`.
    func callBegan() {
        isHeldByCall = true
        let stopping = holders.compactMap(\.value)
        holders = []
        for holder in stopping { holder.yieldToCall() }
    }

    func callEnded() {
        isHeldByCall = false
    }
}
