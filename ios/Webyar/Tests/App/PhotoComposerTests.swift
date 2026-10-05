import Foundation
import UIKit
import XCTest
@testable import Webyar

/// A photo picked into the chat composer: it uploads at once, drawn small in
/// the field, and goes out with Send — never by itself, and never twice.
@MainActor
final class PhotoComposerTests: XCTestCase {
    private var root: URL!
    private var api: TestAPI!
    private var sync: SyncCoordinator!
    private var appState: AppState!

    override func setUp() async throws {
        root = try temporaryFolder()
        api = TestAPI()
        sync = SyncCoordinator(api: api, persistent: true, storeRoot: root, startsRealtime: false)
        sync.sessionChanged(userID: "u1", workspaceID: "w1")
        appState = AppState(api: api)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func model() async throws -> ChatViewModel {
        let vm = ChatViewModel(conversation: try conversation("c1"), api: api, sync: sync)
        await vm.load(appState: appState)
        return vm
    }

    private var photo: Data {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
    }

    private func stage(_ vm: ChatViewModel) async {
        await vm.stagePhoto(data: photo, fileName: "photo.png", mimeType: "image/png", appState: appState)
    }

    func testThePhotoUploadsAtOnceAndSendWaitsForIt() async throws {
        await api.setUploadDelay(300_000_000)
        let vm = try await model()
        await stage(vm)
        XCTAssertNotNil(vm.photos.photo, "in the field the moment it is picked")
        let uploading = await eventually(timeout: 0.25) {
            if case .uploading(let sent) = vm.photos.photo?.phase { return sent >= 0.5 }
            return false
        }
        XCTAssertTrue(uploading, "its progress is on it")
        XCTAssertFalse(vm.canSend, "Send waits for the upload")
        let ready = await eventually { vm.photos.attachmentID == "att-1" }
        XCTAssertTrue(ready)
        XCTAssertTrue(vm.canSend)
        let sent = await api.sentKeys
        XCTAssertTrue(sent.isEmpty, "picking a photo sends nothing")
    }

    func testSendTakesThePhotoAndTheWordsAsOneMessage() async throws {
        let vm = try await model()
        await stage(vm)
        _ = await eventually { vm.photos.attachmentID != nil }
        vm.draft = "Here it is"
        await api.setSendDelay(200_000_000)

        let sending = Task { await vm.send(appState: appState) }
        let shown = await eventually(timeout: 0.15) {
            guard let last = vm.state.value?.last else { return false }
            return last.isPending && last.attachments?.first?.id == "att-1" && last.body == "Here it is"
        }
        XCTAssertTrue(shown, "the bubble is on screen with the photo before the server answers")
        XCTAssertNil(vm.photos.photo, "and the field is empty again")
        XCTAssertNotNil(AttachmentPreviews.cached("att-1"), "drawn from this phone's copy")
        XCTAssertEqual(vm.sentCount, 1, "the transcript is told to follow it down")
        await sending.value

        let attachments = await api.sentAttachments
        XCTAssertEqual(attachments, ["att-1"])
        let uploads = await api.uploads
        XCTAssertEqual(uploads, 1, "uploaded once, when it was picked")
        XCTAssertEqual(vm.state.value?.filter { $0.attachments?.first?.id == "att-1" }.count, 1, "one message")
    }

    func testAFailedUploadKeepsSendOffUntilItIsRetried() async throws {
        await api.setUploadFailures(1)
        let vm = try await model()
        await stage(vm)
        let failed = await eventually { vm.photos.photo?.phase == .failed }
        XCTAssertTrue(failed)
        vm.draft = "words"
        XCTAssertFalse(vm.canSend, "not the words without the photo the operator put with them")

        vm.photos.retry()
        let ready = await eventually { vm.photos.attachmentID == "att-2" }
        XCTAssertTrue(ready)
        XCTAssertTrue(vm.canSend)
    }

    func testAFailedSendPutsThePhotoBackWithoutUploadingAgain() async throws {
        let vm = try await model()
        await stage(vm)
        _ = await eventually { vm.photos.attachmentID != nil }
        await api.setSendFailures([.beforeInsert])
        await vm.send(appState: appState)

        XCTAssertTrue(vm.sendFailed)
        XCTAssertEqual(vm.photos.attachmentID, "att-1", "back in the field, already uploaded")
        await vm.send(appState: appState)
        let attachments = await api.sentAttachments
        XCTAssertEqual(attachments, ["att-1", "att-1"])
        let keys = await api.sentKeys
        XCTAssertEqual(Set(keys).count, 1, "the second try is the same message")
        let uploads = await api.uploads
        XCTAssertEqual(uploads, 1)
    }

    func testTakingThePhotoOutStopsItsUpload() async throws {
        await api.setUploadDelay(200_000_000)
        let vm = try await model()
        await stage(vm)
        vm.photos.discard()
        try await Task.sleep(nanoseconds: 350_000_000)
        XCTAssertNil(vm.photos.photo, "an upload that finishes later does not bring it back")
        XCTAssertFalse(vm.canSend)
    }

    func testAPhotoBubbleTakesThePhotosOwnShape() {
        let tall = PhotoBubbleSize.fitting(CGSize(width: 600, height: 1200))
        XCTAssertEqual(tall.height, 260)
        XCTAssertEqual(tall.width, 130, "as narrow as the photo, not a 220-wide box")
        let wide = PhotoBubbleSize.fitting(CGSize(width: 1600, height: 900))
        XCTAssertEqual(wide.width, 220)
        XCTAssertEqual(wide.height, 124)
        let sliver = PhotoBubbleSize.fitting(CGSize(width: 2000, height: 100))
        XCTAssertEqual(sliver.height, 90, "a panorama is cropped, not drawn as a line")
    }
}
