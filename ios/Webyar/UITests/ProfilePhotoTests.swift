import XCTest

/// The operator's photograph changes only when they choose one, or ask for it
/// to be removed.
///
/// The photo, "Change photo" and "Remove photo" share one List row, and two
/// default-style buttons in a row make the whole row one tap target that
/// fires both: tapping the photo or "Change photo" opened the gallery AND
/// deleted the photograph on the server, before anything had been chosen.
/// The sample operator has a photo on this run, and removing it really takes
/// it away — so "Remove photo" disappearing is the photo being deleted.
final class ProfilePhotoTests: UITestCase {

    private let change = "تغییر عکس"
    private let remove = "حذف عکس"

    private func launchToProfile() -> (change: XCUIElement, remove: XCUIElement) {
        app.launchArguments += ["-WebyarScreen", "profile"]
        app.launch()
        let changeButton = app.buttons[change]
        let removeButton = app.buttons[remove]
        XCTAssertTrue(changeButton.waitForExistence(timeout: 20), "no Change photo button")
        XCTAssertTrue(removeButton.waitForExistence(timeout: 10), "the sample operator has no photo to keep")
        return (changeButton, removeButton)
    }

    /// Still there after a moment: a deletion answers within the second.
    private func assertPhotoKept(_ removeButton: XCUIElement, _ message: String) {
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(removeButton.exists, message)
    }

    func testOpeningTheGalleryDoesNotRemoveThePhoto() {
        let (changeButton, removeButton) = launchToProfile()
        changeButton.tap()
        assertPhotoKept(removeButton, "opening the gallery deleted the photograph")

        // Closing it without choosing anything changes nothing either.
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(changeButton.waitForExistence(timeout: 10))
        assertPhotoKept(removeButton, "closing the gallery deleted the photograph")
    }

    func testTappingThePhotoItselfDoesNotRemoveIt() {
        let (changeButton, removeButton) = launchToProfile()
        // The photo sits just above "Change photo", in the same row.
        changeButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -1.5)).tap()
        assertPhotoKept(removeButton, "tapping the photo deleted it")
    }

    func testRemovePhotoStillRemovesIt() {
        let (changeButton, removeButton) = launchToProfile()
        removeButton.tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: removeButton)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(changeButton.exists, "Change photo went with the photograph")
    }
}
