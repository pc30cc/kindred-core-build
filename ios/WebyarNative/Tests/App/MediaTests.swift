import UIKit
import XCTest
@testable import WebyarNative

/// Pictures in memory: decoded small, retried after a failure, and one entry
/// per picture however its link is signed.
@MainActor
final class MediaTests: XCTestCase {

    // 33. Image downsampling

    func testABubblePreviewIsDecodedSmallNeverAtFullSize() async throws {
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }()).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let data = try XCTUnwrap(big.jpegData(compressionQuality: 0.8))

        let preview = try XCTUnwrap(await AttachmentPreviews.decode(data, maxPixel: CachePolicy.attachmentPreviewPixels))
        let pixels = try XCTUnwrap(preview.cgImage)
        XCTAssertLessThanOrEqual(max(pixels.width, pixels.height), CachePolicy.attachmentPreviewPixels)
        XCTAssertEqual(Double(pixels.width) / Double(pixels.height), 4.0 / 3.0, accuracy: 0.02, "proportions kept")

        let viewer = try XCTUnwrap(await AttachmentPreviews.decode(data, maxPixel: CachePolicy.attachmentViewerPixels))
        XCTAssertLessThanOrEqual(max(viewer.cgImage?.width ?? 0, viewer.cgImage?.height ?? 0), CachePolicy.attachmentViewerPixels)
    }

    func testBytesThatAreNotAPictureDecodeToNothing() async {
        let decoded = await AttachmentPreviews.decode(Data("not a picture".utf8), maxPixel: 800)
        XCTAssertNil(decoded)
    }

    // 34. A failed picture is asked for again later

    func testAFailedPictureIsRetriedAfterItsCoolDown() async throws {
        let cache = ImageCache.shared
        cache.clearMemory()
        // Nothing listens there: the read fails at once.
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:9/avatar-\(UUID().uuidString).png"))
        let image = await cache.load(url, maxPixel: 64)
        XCTAssertNil(image)
        XCTAssertTrue(cache.hasFailed(url), "not retried on every scroll")
        XCTAssertFalse(cache.hasFailed(url, now: Date().addingTimeInterval(CachePolicy.remoteImageFailureTTL + 1)),
                       "but retried later — not dead for the rest of the session")
        cache.clearMemory()
        XCTAssertFalse(cache.hasFailed(url))
    }

    func testASignedLinkIsOnePictureWhateverItsSignature() throws {
        let a = try XCTUnwrap(URL(string: "https://cdn.example/users/u1/avatar.jpg?X-Amz-Signature=aaa&X-Amz-Date=1&v=2"))
        let b = try XCTUnwrap(URL(string: "https://cdn.example/users/u1/avatar.jpg?X-Amz-Signature=bbb&X-Amz-Date=2&v=2"))
        let other = try XCTUnwrap(URL(string: "https://cdn.example/users/u2/avatar.jpg?X-Amz-Signature=aaa"))
        let versioned = try XCTUnwrap(URL(string: "https://cdn.example/users/u1/avatar.jpg?X-Amz-Signature=aaa&v=3"))
        XCTAssertEqual(ImageCache.identity(of: a), ImageCache.identity(of: b))
        XCTAssertNotEqual(ImageCache.identity(of: a), ImageCache.identity(of: other))
        XCTAssertNotEqual(ImageCache.identity(of: a), ImageCache.identity(of: versioned), "a version is part of the picture")
        let plain = try XCTUnwrap(URL(string: "https://cdn.example/logo.png"))
        XCTAssertEqual(ImageCache.identity(of: plain), plain.absoluteString)
    }

    // A banner reply replayed by iOS is the same message

    func testAReplyTypedOnABannerHasAStableKey() {
        let a = PushController.replyKey(notification: "n-1", body: "on my way")
        let b = PushController.replyKey(notification: "n-1", body: "on my way")
        let c = PushController.replyKey(notification: "n-2", body: "on my way")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertTrue((8...64).contains(a.count), "the server's bounds for client_message_id")
    }
}
