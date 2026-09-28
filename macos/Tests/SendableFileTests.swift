import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Webyar

/// Chat attachments: only what the server takes (conversationAttachments.ts
/// GLOBAL_ALLOWED_MIMES, 25 MB), refused before sending with a plain reason.
final class SendableFileTests: XCTestCase {
    private let en = Strings(.en)
    private let fa = Strings(.fa)
    private let bytes = Data("hello".utf8)

    private func mime(_ outcome: SendableFile.Outcome) -> String? {
        if case .ready(_, let mime, _) = outcome { return mime }
        return nil
    }

    func testTheKindsTheServerTakesGoAsTheyAre() {
        XCTAssertEqual(mime(SendableFile.prepare(name: "a.png", type: nil, data: bytes)), "image/png")
        XCTAssertEqual(mime(SendableFile.prepare(name: "a.JPG", type: nil, data: bytes)), "image/jpeg")
        XCTAssertEqual(mime(SendableFile.prepare(name: "a.pdf", type: nil, data: bytes)), "application/pdf")
        XCTAssertEqual(mime(SendableFile.prepare(name: "notes.txt", type: nil, data: bytes)), "text/plain")
        XCTAssertEqual(mime(SendableFile.prepare(name: "song.mp3", type: nil, data: bytes)), "audio/mpeg")
        // macOS calls these audio/x-m4a and audio/vnd.wave; the server's names win.
        XCTAssertEqual(mime(SendableFile.prepare(name: "memo.m4a", type: UTType(filenameExtension: "m4a"), data: bytes)), "audio/mp4")
        XCTAssertEqual(mime(SendableFile.prepare(name: "take.wav", type: UTType(filenameExtension: "wav"), data: bytes)), "audio/wav")
        // Any plain text goes as text.
        XCTAssertEqual(mime(SendableFile.prepare(name: "README.md", type: nil, data: bytes)), "text/plain")
    }

    func testOtherKindsAreRefusedBeforeSending() {
        XCTAssertEqual(SendableFile.prepare(name: "report.docx", type: nil, data: bytes), .notAllowed)
        XCTAssertEqual(SendableFile.prepare(name: "archive.zip", type: nil, data: bytes), .notAllowed)
        XCTAssertEqual(SendableFile.prepare(name: "clip.mov", type: nil, data: bytes), .notAllowed)
        XCTAssertEqual(SendableFile.prepare(name: "noextension", type: nil, data: bytes), .notAllowed)
        // A "picture" that can't be read as one is not sent as one.
        XCTAssertEqual(SendableFile.prepare(name: "broken.heic", type: nil, data: bytes), .notAllowed)
        XCTAssertEqual(SendableFile.check(name: "x.bin", mime: "application/octet-stream", data: bytes), .notAllowed)
    }

    func testTooLargeIsSaidAsSuch() {
        XCTAssertEqual(SendableFile.prepare(name: "a.pdf", type: nil, data: Data(count: 11), maxBytes: 10), .tooLarge)
        XCTAssertEqual(SendableFile.check(name: "voice.m4a", mime: "audio/mp4", data: Data(count: 11), maxBytes: 10), .tooLarge)
        XCTAssertEqual(SendableFile.maxBytes, 25 * 1024 * 1024)
    }

    func testAPictureTheServerDoesNotTakeGoesAsJPEG() throws {
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, UTType.tiff.identifier as CFString, 1, nil))
        let ctx = try XCTUnwrap(CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        guard case .ready(let name, let mime, let data) = SendableFile.prepare(name: "scan.tiff", type: .tiff, data: out as Data) else {
            return XCTFail("a TIFF should go as a JPEG")
        }
        XCTAssertEqual(name, "scan.jpg")
        XCTAssertEqual(mime, "image/jpeg")
        XCTAssertEqual(Array(data.prefix(2)), [0xFF, 0xD8])
    }

    func testThePickerOffersOnlyWhatCanBeSent() {
        let types = SendableFile.pickerTypes
        XCTAssertTrue(types.contains(.pdf))
        XCTAssertFalse(types.contains(.item))
        XCTAssertFalse(types.contains { UTType(filenameExtension: "docx")!.conforms(to: $0) })
        XCTAssertFalse(types.contains { UTType(filenameExtension: "zip")!.conforms(to: $0) })
    }

    func testTheServersRefusalReadsAsTheReason() {
        XCTAssertEqual(ErrorText.of(ApiError(failure: .server, status: 415, serverMessage: "File type not allowed"), fa), fa["fileTypeNotAllowed"])
        XCTAssertEqual(ErrorText.of(ApiError(failure: .server, status: 415, serverMessage: "File type not allowed"), en), en["fileTypeNotAllowed"])
        XCTAssertEqual(ErrorText.of(ApiError(failure: .server, status: 413, serverMessage: nil), fa), fa["fileTooLarge"])
        XCTAssertTrue(fa["fileTypeNotAllowed"].contains("PDF"), "the full sentence, not a leftover shorter one")
    }
}
