import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What the server takes as a chat attachment — conversationAttachments.ts
/// GLOBAL_ALLOWED_MIMES, used by the visitor chat and the colleagues chat
/// alike: pictures (PNG, JPG, WebP, GIF), PDF, plain text and sound, up to
/// 25 MB. Anything else is refused with 415 after the upload has begun, so it
/// is not offered in the picker, and a dropped or pasted one is refused at
/// once, in plain words. A Mac photo the server does not take (HEIC from an
/// iPhone, TIFF, BMP) goes as a JPEG instead of being turned away.
enum SendableFile {
    static let maxBytes = 25 * 1024 * 1024

    static let mimeTypes: Set<String> = [
        "image/png", "image/jpeg", "image/webp", "image/gif",
        "application/pdf", "text/plain",
        "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
    ]

    /// The picker's filter: pictures (the ones the server does not take are sent as JPEG), PDF, text and sound.
    static var pickerTypes: [UTType] {
        [.image, .pdf, .plainText] + ["mp3", "m4a", "ogg", "wav"].compactMap { UTType(filenameExtension: $0) }
    }

    enum Outcome: Equatable {
        case ready(name: String, mime: String, data: Data)
        case notAllowed
        case tooLarge
    }

    static func canSend(_ mime: String) -> Bool { mimeTypes.contains(mime.lowercased()) }

    /// A file from disk, as it goes to the server: its type from its extension first (what the
    /// server's list is written in), then what macOS knows of it; a picture of another kind as JPEG.
    static func prepare(name: String, type: UTType?, data: Data, maxBytes: Int = maxBytes) -> Outcome {
        let type = type ?? UTType(filenameExtension: (name as NSString).pathExtension)
        let byName = Mime.of(name)
        let out: (name: String, mime: String, data: Data)
        if canSend(byName) {
            out = (name, byName, data)
        } else if let type, type.conforms(to: .plainText) {
            // Markdown, CSV, a log: text all the same, and the server takes text.
            out = (name, "text/plain", data)
        } else if let mime = type?.preferredMIMEType, canSend(mime) {
            out = (name, mime.lowercased(), data)
        } else if type?.conforms(to: .image) == true || byName.hasPrefix("image/"), let jpeg = jpeg(data) {
            out = (((name as NSString).deletingPathExtension.isEmpty ? "image" : (name as NSString).deletingPathExtension) + ".jpg", "image/jpeg", jpeg)
        } else {
            return .notAllowed
        }
        return out.data.count > maxBytes ? .tooLarge : .ready(name: out.name, mime: out.mime, data: out.data)
    }

    /// Something already made in the app (a pasted picture, a voice note): only the checks.
    static func check(name: String, mime: String, data: Data, maxBytes: Int = maxBytes) -> Outcome {
        guard canSend(mime) else { return .notAllowed }
        return data.count > maxBytes ? .tooLarge : .ready(name: name, mime: mime.lowercased(), data: data)
    }

    /// The first frame as a JPEG, turned the way it was taken, without where it was taken.
    static func jpeg(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.85,
            kCGImagePropertyGPSDictionary: kCFNull as Any,
        ]
        CGImageDestinationAddImageFromSource(dest, source, 0, options as CFDictionary)
        guard CGImageDestinationFinalize(dest), out.length > 0 else { return nil }
        return out as Data
    }
}
