import CoreGraphics
import Foundation

// The small picture on a video call: the member's own camera floating over
// the other side's video — or, after a tap on it, the other way round.
//
// What follows is its arithmetic and its state, kept out of the views so it
// can be tested without a call (CallPictureTests): which corner a drag lands
// in, where a corner is in the room the screen leaves, when a touch is a tap,
// and which picture is the large one. `VideoStage` (CallScreen.swift) draws
// it, on a visitor's call and a colleague's alike. The Android app's
// `SelfView.kt` is the same design, so the two phones feel the same: drag it
// anywhere, let go and it settles into the nearest corner, bottom right to
// begin with, remembered on the phone.

/// The corner of the call the small picture sits in.
///
/// Absolute — left and right of the glass, not leading and trailing — because
/// it is a place the member put it with a finger, and a Persian or Arabic
/// screen must not move it across. (Android: `SelfViewCorner`.)
struct CallPictureCorner: Hashable, Sendable {
    var left: Bool
    var top: Bool

    /// Bottom right, just above the buttons: out of the name's way, and where
    /// the Android app opens it too.
    static let standard = CallPictureCorner(left: false, top: false)

    /// The next corner round the screen, clockwise — top right, bottom right,
    /// bottom left, top left — for VoiceOver's "move" action, in the order
    /// Android's `SelfViewCorner.next()` goes.
    var next: CallPictureCorner {
        switch (left, top) {
        case (false, true): CallPictureCorner(left: false, top: false)
        case (false, false): CallPictureCorner(left: true, top: false)
        case (true, false): CallPictureCorner(left: true, top: true)
        case (true, true): CallPictureCorner(left: false, top: true)
        }
    }

    /// The corner whose quarter of `area` a point is in.
    static func nearest(to point: CGPoint, in area: CGRect) -> CallPictureCorner {
        CallPictureCorner(left: point.x < area.midX, top: point.y < area.midY)
    }
}

/// Where the small picture goes, in numbers.
///
/// Everything is in the stage's own coordinates, with x from the LEFT edge:
/// `VideoStage` lays the picture out left to right whatever the app's
/// language, so a corner is the same corner on every screen.
enum CallPictureLayout {
    /// The picture as designed — the size it has always had on the iPhone.
    static let size = CGSize(width: 104, height: 144)
    /// Between the picture and the edges of its room: the sides of the glass,
    /// the header above it and the buttons below it.
    static let margin: CGFloat = 12
    /// How far a finger may wander and still be tapping — about UIKit's own
    /// allowance for a tap. Past it the touch is a drag, for good.
    static let tapSlop: CGFloat = 10
    /// A flick is aimed where it would be this many seconds on at the speed it
    /// was let go with, as on Android: thrown at a corner, it goes there.
    static let flingLookahead: CGFloat = 0.2
    /// The smallest a short room may make the picture before it gives up
    /// shrinking and overlaps the buttons instead.
    static let minimumScale: CGFloat = 0.5

    /// The room the picture settles in: `free` — the part of the stage the
    /// call screen leaves it (`CallScreenFrames.free`) — or `fallback` while
    /// the screen has not been measured yet, less the margin all round.
    static func room(free: CGRect?, fallback: CGRect) -> CGRect {
        let base = free ?? fallback
        let width = max(0, base.width - 2 * margin)
        let height = max(0, base.height - 2 * margin)
        return CGRect(x: base.midX - width / 2, y: base.midY - height / 2, width: width, height: height)
    }

    /// The picture's size in `room`: as designed, or smaller when the room is
    /// shorter (or narrower) than that, down to `minimumScale`.
    static func fittedSize(in room: CGRect) -> CGSize {
        let scale = min(1, room.width / Self.size.width, room.height / Self.size.height)
        let fitted = max(minimumScale, scale)
        return CGSize(width: Self.size.width * fitted, height: Self.size.height * fitted)
    }

    /// The centre of a picture of `size` settled in `corner` of `room`.
    ///
    /// A room too short for it keeps it at the top — under the header's line
    /// rather than over the status bar — and one too narrow at the left: it
    /// may then reach over the buttons, never off the screen.
    static func center(at corner: CallPictureCorner, size: CGSize, in room: CGRect) -> CGPoint {
        let left = corner.left || room.width < size.width
        let top = corner.top || room.height < size.height
        return CGPoint(
            x: left ? room.minX + size.width / 2 : room.maxX - size.width / 2,
            y: top ? room.minY + size.height / 2 : room.maxY - size.height / 2
        )
    }

    /// Where the picture is while a finger drags it: under the finger, but
    /// never past the edges of the stage. The corners are for letting go.
    static func clamped(_ center: CGPoint, size: CGSize, in bounds: CGRect) -> CGPoint {
        let minX = bounds.minX + size.width / 2
        let minY = bounds.minY + size.height / 2
        let maxX = max(minX, bounds.maxX - size.width / 2)
        let maxY = max(minY, bounds.maxY - size.height / 2)
        return CGPoint(x: min(max(center.x, minX), maxX), y: min(max(center.y, minY), maxY))
    }

    /// The corner a drag ends in: the quarter of `room` its picture was over
    /// when the finger lifted — or was heading for, when it was flicked.
    static func corner(releasedAt center: CGPoint, velocity: CGSize, in room: CGRect) -> CallPictureCorner {
        let aimed = CGPoint(
            x: center.x + velocity.width * flingLookahead,
            y: center.y + velocity.height * flingLookahead
        )
        return .nearest(to: aimed, in: room)
    }
}

/// One touch on the small picture, from the finger landing to it lifting.
///
/// A tap until the finger travels past `CallPictureLayout.tapSlop`, a drag
/// from then on — and a drag never turns back into a tap, not even when the
/// finger comes back to where it started: a picture moved and put back is
/// not a request to swap the pictures.
struct CallPictureTouch: Equatable, Sendable {
    /// Where the finger landed. A different one is a different touch.
    private(set) var start: CGPoint?
    /// Where the picture's centre was when it did.
    private(set) var origin: CGPoint = .zero
    /// Whether this touch has become a drag.
    private(set) var isDrag = false

    /// The finger, `translation` away from where it landed at `start`; a new
    /// `start` begins a new touch, with the picture at `origin`.
    mutating func track(start: CGPoint, translation: CGSize, origin: CGPoint) {
        if self.start != start {
            self.start = start
            self.origin = origin
            isDrag = false
        }
        let travelled = (translation.width * translation.width + translation.height * translation.height).squareRoot()
        if !isDrag, travelled > CallPictureLayout.tapSlop {
            isDrag = true
        }
    }

    /// Where the picture's centre is with the finger `translation` away from
    /// where it landed.
    func center(translation: CGSize) -> CGPoint {
        CGPoint(x: origin.x + translation.width, y: origin.y + translation.height)
    }
}

/// Which picture is the large one: the other side's, as every call opens, or
/// — after a tap on the small picture — the member's own camera, with theirs
/// small (their video, or their face when their camera is off).
///
/// The swap belongs to one own-camera track. When that camera goes off, or
/// its track goes away or is replaced, the other side is large again and the
/// small picture goes; when the camera comes back the call starts over the
/// way it opened, unswapped.
struct CallPictureSwap: Equatable, Sendable {
    /// The own-camera track the pictures were swapped with; nil while the
    /// other side's picture is the large one.
    private(set) var swappedWith: ObjectIdentifier?

    /// Whether the member's own camera is the large picture, `local` being
    /// the own track on screen now (nil while the camera is off).
    func isSwapped(local: ObjectIdentifier?) -> Bool {
        local != nil && swappedWith == local
    }

    /// A tap on the small picture (or VoiceOver's action): swaps, or swaps
    /// back. Nothing happens without an own camera — there is no small
    /// picture to tap.
    mutating func toggle(local: ObjectIdentifier?) {
        swappedWith = isSwapped(local: local) ? nil : local
    }

    /// The own track on screen changed: off, gone, or a different one.
    mutating func localChanged(to local: ObjectIdentifier?) {
        if swappedWith != local {
            swappedWith = nil
        }
    }
}

/// Where the member left the small picture, so the next call opens it there.
///
/// Kept on the phone only — it is how this member likes their screen, not an
/// account setting, and nothing in it is private (Android:
/// `SelfViewPlacement`). Never set: bottom right.
enum CallPicturePlacement {
    private static let leftKey = "call.picture.left"
    private static let topKey = "call.picture.top"

    static func corner(defaults: UserDefaults = .standard) -> CallPictureCorner {
        CallPictureCorner(left: defaults.bool(forKey: leftKey), top: defaults.bool(forKey: topKey))
    }

    static func remember(_ corner: CallPictureCorner, defaults: UserDefaults = .standard) {
        defaults.set(corner.left, forKey: leftKey)
        defaults.set(corner.top, forKey: topKey)
    }
}

/// Where a call screen's own pieces are, for the small picture to keep out of
/// their way: the stage (edge to edge), the safe area, and the header and
/// controls floating over the picture — each measured in the screen's
/// coordinate space (`space`, named on the screen's outermost stack).
///
/// Measured rather than assumed, because every one of them moves: the name's
/// line wraps, a warning appears under it, the buttons change, the status bar
/// hides with the controls and a phone without a notch gives its top back.
struct CallScreenFrames: Equatable, Sendable {
    /// The coordinate space the frames are measured in.
    static let space = "call.screen"

    var stage: CGRect = .zero
    var safeArea: CGRect = .zero
    var header: CGRect = .zero
    var controls: CGRect = .zero

    /// The part of the stage the small picture may settle in, in the stage's
    /// own coordinates: inside the safe area — below the status bar or the
    /// notch, above the home indicator — and, while the header and controls
    /// are on screen (`chromeVisible`), below the one and above the other.
    /// Nil until the screen has been measured.
    func free(chromeVisible: Bool) -> CGRect? {
        guard stage.width > 0, stage.height > 0, safeArea.width > 0, safeArea.height > 0 else { return nil }
        var top = safeArea.minY
        var bottom = safeArea.maxY
        if chromeVisible {
            if header.height > 0 { top = max(top, header.maxY) }
            if controls.height > 0 { bottom = min(bottom, controls.minY) }
        }
        return CGRect(
            x: safeArea.minX - stage.minX,
            y: top - stage.minY,
            width: safeArea.width,
            height: max(0, bottom - top)
        )
    }
}
