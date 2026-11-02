import CoreGraphics
import Foundation
import XCTest
@testable import Webyar

/// The small picture on a video call (CallPicture.swift, drawn by
/// `VideoStage`): which corner a drag settles in and where that corner is in
/// the room the header and the controls leave, when a touch is a tap and when
/// it is a drag, which picture is the large one — and the corner the phone
/// remembers. The Android app's `SelfView` follows the same rules.
final class CallPictureTests: XCTestCase {
    private let topLeft = CallPictureCorner(left: true, top: true)
    private let topRight = CallPictureCorner(left: false, top: true)
    private let bottomLeft = CallPictureCorner(left: true, top: false)
    private let bottomRight = CallPictureCorner(left: false, top: false)

    /// An iPhone's stage, edge to edge: 393 × 852 points.
    private let stage = CGRect(x: 0, y: 0, width: 393, height: 852)
    /// The room a typical call screen leaves: below the header (150 points
    /// down, safe area included), above the controls, less the margin.
    private let room = CGRect(x: 12, y: 162, width: 369, height: 476)

    // MARK: - Corners

    func testACallOpensWithThePictureBottomRightAsOnAndroid() {
        XCTAssertEqual(CallPictureCorner.standard, bottomRight)
    }

    func testNextGoesRoundTheScreenClockwise() {
        let order = Array(sequence(first: topRight) { $0.next }.prefix(5))
        XCTAssertEqual(order, [topRight, bottomRight, bottomLeft, topLeft, topRight])
    }

    func testTheNearestCornerIsTheQuarterOfTheRoomThePointIsIn() {
        XCTAssertEqual(CallPictureCorner.nearest(to: CGPoint(x: 40, y: 200), in: room), topLeft)
        XCTAssertEqual(CallPictureCorner.nearest(to: CGPoint(x: 350, y: 200), in: room), topRight)
        XCTAssertEqual(CallPictureCorner.nearest(to: CGPoint(x: 40, y: 600), in: room), bottomLeft)
        XCTAssertEqual(CallPictureCorner.nearest(to: CGPoint(x: 350, y: 600), in: room), bottomRight)
        // The room's own middle (y 400), not the screen's (426): the header
        // pushes the room down, and its quarters with it.
        XCTAssertTrue(CallPictureCorner.nearest(to: CGPoint(x: 350, y: 390), in: room).top)
        XCTAssertFalse(CallPictureCorner.nearest(to: CGPoint(x: 350, y: 410), in: room).top)
    }

    // MARK: - The room and the corners in it

    func testTheRoomIsTheFreeAreaLessTheMargin() {
        let free = CGRect(x: 0, y: 150, width: 393, height: 500)
        XCTAssertEqual(CallPictureLayout.room(free: free, fallback: stage), room)
    }

    func testBeforeTheScreenIsMeasuredTheStagesSafeAreaStandsIn() {
        let safeArea = CGRect(x: 0, y: 59, width: 393, height: 759)
        XCTAssertEqual(
            CallPictureLayout.room(free: nil, fallback: safeArea),
            CGRect(x: 12, y: 71, width: 369, height: 735)
        )
    }

    func testEachCornerSitsAgainstItsEdgesOfTheRoomAndInsideIt() {
        let size = CallPictureLayout.fittedSize(in: room)
        XCTAssertEqual(size, CallPictureLayout.size)
        XCTAssertEqual(CallPictureLayout.center(at: bottomRight, size: size, in: room), CGPoint(x: 381 - 52, y: 638 - 72))
        XCTAssertEqual(CallPictureLayout.center(at: topLeft, size: size, in: room), CGPoint(x: 12 + 52, y: 162 + 72))
        XCTAssertEqual(CallPictureLayout.center(at: topRight, size: size, in: room), CGPoint(x: 381 - 52, y: 162 + 72))
        XCTAssertEqual(CallPictureLayout.center(at: bottomLeft, size: size, in: room), CGPoint(x: 12 + 52, y: 638 - 72))
        // Never over the header above the room or the controls below it.
        for corner in [topLeft, topRight, bottomLeft, bottomRight] {
            let center = CallPictureLayout.center(at: corner, size: size, in: room)
            let frame = CGRect(
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height
            )
            XCTAssertTrue(room.contains(frame), "\(corner)")
        }
    }

    func testAShortRoomShrinksThePictureAndKeepsItUnderTheHeader() {
        let short = CGRect(x: 12, y: 300, width: 369, height: 100)
        let fitted = CallPictureLayout.fittedSize(in: short)
        XCTAssertEqual(fitted.height, 100, accuracy: 0.001)
        XCTAssertEqual(fitted.width / fitted.height, 104.0 / 144.0, accuracy: 0.001)
        let center = CallPictureLayout.center(at: bottomRight, size: fitted, in: short)
        XCTAssertEqual(center.y - fitted.height / 2, short.minY, accuracy: 0.001)

        // Shorter than half the picture: it stops shrinking, and keeps to the
        // top of the room — over the buttons, never over the status bar.
        let tiny = CGRect(x: 12, y: 300, width: 369, height: 40)
        let floor = CallPictureLayout.fittedSize(in: tiny)
        XCTAssertEqual(floor, CGSize(width: 52, height: 72))
        let pinned = CallPictureLayout.center(at: bottomRight, size: floor, in: tiny)
        XCTAssertEqual(pinned.y - floor.height / 2, tiny.minY)
    }

    func testADraggedPictureStaysOnTheStage() {
        let size = CallPictureLayout.size
        XCTAssertEqual(CallPictureLayout.clamped(CGPoint(x: -100, y: -100), size: size, in: stage), CGPoint(x: 52, y: 72))
        XCTAssertEqual(
            CallPictureLayout.clamped(CGPoint(x: 1000, y: 1000), size: size, in: stage),
            CGPoint(x: 393 - 52, y: 852 - 72)
        )
        XCTAssertEqual(CallPictureLayout.clamped(CGPoint(x: 200, y: 400), size: size, in: stage), CGPoint(x: 200, y: 400))
    }

    func testLettingGoSettlesInTheQuarterThePictureIsOver() {
        XCTAssertEqual(CallPictureLayout.corner(releasedAt: CGPoint(x: 300, y: 250), velocity: .zero, in: room), topRight)
        XCTAssertEqual(CallPictureLayout.corner(releasedAt: CGPoint(x: 60, y: 560), velocity: .zero, in: room), bottomLeft)
    }

    func testAFlickCarriesItTowardsTheCornerItWasThrownAt() {
        let released = CGPoint(x: 220, y: 380)
        XCTAssertEqual(CallPictureLayout.corner(releasedAt: released, velocity: .zero, in: room), topRight)
        XCTAssertEqual(
            CallPictureLayout.corner(releasedAt: released, velocity: CGSize(width: -1500, height: 800), in: room),
            bottomLeft
        )
        // A slow finger is not a flick: where it was let go decides.
        XCTAssertEqual(
            CallPictureLayout.corner(releasedAt: released, velocity: CGSize(width: -40, height: 40), in: room),
            topRight
        )
    }

    // MARK: - The free area a call screen leaves

    /// Measured in the call screen's space, whose origin is the safe area's
    /// top left: the stage reaches 59 points above it, under the status bar.
    private let measured = CallScreenFrames(
        stage: CGRect(x: 0, y: -59, width: 393, height: 852),
        safeArea: CGRect(x: 0, y: 0, width: 393, height: 759),
        header: CGRect(x: 100, y: 0, width: 193, height: 90),
        controls: CGRect(x: 20, y: 600, width: 353, height: 159)
    )

    func testWhileTheControlsShowTheAreaIsBetweenTheHeaderAndTheControls() {
        XCTAssertEqual(measured.free(chromeVisible: true), CGRect(x: 0, y: 149, width: 393, height: 510))
    }

    func testWithTheControlsAwayTheAreaIsTheSafeArea() {
        XCTAssertEqual(measured.free(chromeVisible: false), CGRect(x: 0, y: 59, width: 393, height: 759))
    }

    func testAHeaderThatGrowsALinePushesTheAreaDown() {
        var frames = measured
        frames.header.size.height = 120
        XCTAssertEqual(frames.free(chromeVisible: true)?.minY, 179)
        XCTAssertEqual(frames.free(chromeVisible: true)?.maxY, 659)
    }

    func testHeaderAndControlsThatMeetLeaveNoRoomRatherThanANegativeOne() {
        var frames = measured
        frames.header.size.height = 700
        XCTAssertEqual(frames.free(chromeVisible: true)?.height, 0)
    }

    func testNothingIsFreeUntilTheScreenHasBeenMeasured() {
        XCTAssertNil(CallScreenFrames().free(chromeVisible: true))
        var frames = CallScreenFrames()
        frames.stage = measured.stage
        XCTAssertNil(frames.free(chromeVisible: true))
        // Header and controls not measured yet: the safe area alone.
        frames.safeArea = measured.safeArea
        XCTAssertEqual(frames.free(chromeVisible: true), CGRect(x: 0, y: 59, width: 393, height: 759))
    }

    // MARK: - A touch: tap or drag

    private let landed = CGPoint(x: 330, y: 560)
    private let pictureAt = CGPoint(x: 329, y: 566)

    func testATouchThatStaysPutIsATap() {
        var touch = CallPictureTouch()
        touch.track(start: landed, translation: .zero, origin: pictureAt)
        touch.track(start: landed, translation: CGSize(width: 4, height: -6), origin: pictureAt)
        XCTAssertFalse(touch.isDrag)
    }

    func testPastTheSlopItIsADragAndNeverATapAgain() {
        var touch = CallPictureTouch()
        touch.track(start: landed, translation: .zero, origin: pictureAt)
        touch.track(start: landed, translation: CGSize(width: -30, height: 0), origin: pictureAt)
        XCTAssertTrue(touch.isDrag)
        // Back where it started: still the drag it was.
        touch.track(start: landed, translation: CGSize(width: 1, height: 1), origin: pictureAt)
        XCTAssertTrue(touch.isDrag)
    }

    func testADragMovesThePictureFromWhereItWasWhenTheFingerLanded() {
        var touch = CallPictureTouch()
        touch.track(start: landed, translation: .zero, origin: pictureAt)
        // The room moving mid-drag (the controls fading) does not move the
        // picture under the finger.
        touch.track(start: landed, translation: CGSize(width: -200, height: -300), origin: CGPoint(x: 329, y: 700))
        XCTAssertEqual(touch.center(translation: CGSize(width: -200, height: -300)), CGPoint(x: 129, y: 266))
    }

    func testANewTouchStartsAsATap() {
        var touch = CallPictureTouch()
        touch.track(start: landed, translation: .zero, origin: pictureAt)
        touch.track(start: landed, translation: CGSize(width: 0, height: 80), origin: pictureAt)
        XCTAssertTrue(touch.isDrag)
        let elsewhere = CGPoint(x: 64, y: 234)
        touch.track(start: elsewhere, translation: .zero, origin: CGPoint(x: 64, y: 234))
        XCTAssertFalse(touch.isDrag)
        XCTAssertEqual(touch.origin, CGPoint(x: 64, y: 234))
    }

    // MARK: - Which picture is large

    private final class Track {}

    func testATapSwapsThePicturesAndAnotherSwapsThemBack() {
        let camera = Track()
        let own = ObjectIdentifier(camera)
        var swap = CallPictureSwap()
        XCTAssertFalse(swap.isSwapped(local: own), "a call opens with the other side large")
        swap.toggle(local: own)
        XCTAssertTrue(swap.isSwapped(local: own))
        swap.toggle(local: own)
        XCTAssertFalse(swap.isSwapped(local: own))
        withExtendedLifetime(camera) {}
    }

    func testWithoutAnOwnCameraThereIsNothingToSwap() {
        let camera = Track()
        var swap = CallPictureSwap()
        swap.toggle(local: nil)
        XCTAssertFalse(swap.isSwapped(local: nil))
        XCTAssertFalse(swap.isSwapped(local: ObjectIdentifier(camera)))
        withExtendedLifetime(camera) {}
    }

    func testTheOwnCameraGoingOffPutsTheirsBackAndItComesBackUnswapped() {
        let camera = Track()
        let own = ObjectIdentifier(camera)
        var swap = CallPictureSwap()
        swap.toggle(local: own)
        // At once, before anything is told: no own picture, nothing swapped.
        XCTAssertFalse(swap.isSwapped(local: nil))
        swap.localChanged(to: nil)
        // The same track unmuted again: the call as it opened.
        XCTAssertFalse(swap.isSwapped(local: own))
        withExtendedLifetime(camera) {}
    }

    func testAReplacedTrackStartsUnswapped() {
        let first = Track()
        let second = Track()
        var swap = CallPictureSwap()
        swap.toggle(local: ObjectIdentifier(first))
        XCTAssertFalse(swap.isSwapped(local: ObjectIdentifier(second)))
        swap.localChanged(to: ObjectIdentifier(second))
        XCTAssertFalse(swap.isSwapped(local: ObjectIdentifier(second)))
        XCTAssertFalse(swap.isSwapped(local: ObjectIdentifier(first)))
        withExtendedLifetime((first, second)) {}
    }

    func testTheSameTrackReportedAgainKeepsTheSwap() {
        // Switching between the front and the back camera keeps the track.
        let camera = Track()
        let own = ObjectIdentifier(camera)
        var swap = CallPictureSwap()
        swap.toggle(local: own)
        swap.localChanged(to: own)
        XCTAssertTrue(swap.isSwapped(local: own))
        withExtendedLifetime(camera) {}
    }

    // MARK: - Remembered on the phone

    func testTheCornerIsRememberedForTheNextCall() throws {
        let name = "CallPictureTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        defer { defaults.removePersistentDomain(forName: name) }

        XCTAssertEqual(CallPicturePlacement.corner(defaults: defaults), .standard)
        CallPicturePlacement.remember(topLeft, defaults: defaults)
        XCTAssertEqual(CallPicturePlacement.corner(defaults: defaults), topLeft)
        CallPicturePlacement.remember(bottomRight, defaults: defaults)
        XCTAssertEqual(CallPicturePlacement.corner(defaults: defaults), bottomRight)
    }
}
