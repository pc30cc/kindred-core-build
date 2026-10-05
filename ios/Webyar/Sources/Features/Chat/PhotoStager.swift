import SwiftUI
import Observation

/// A photo picked into the composer.
///
/// It uploads the moment it is picked, drawn small in the field with its
/// progress on it, and goes out with Send — with whatever was typed as its
/// caption — once the upload is done. Nothing is sent by picking it.
struct StagedPhoto: Identifiable, Equatable {
    enum Phase: Equatable {
        case uploading(Double)
        case ready(attachmentID: String)
        case failed
    }

    let id: UUID
    /// Decoded at the size a bubble draws photos, so the bubble that goes
    /// out shows the same picture at once.
    let preview: UIImage
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    var phase: Phase

    var attachmentID: String? {
        if case .ready(let id) = phase { return id }
        return nil
    }
}

/// The composer's photo, from the pick to the send: one at a time, uploaded
/// at once, its progress reported as it goes.
///
/// Shared by the visitor chat and the colleague chat, which upload to the
/// same place and differ only in what the message is attached to.
@MainActor
@Observable
final class PhotoStager {
    typealias Upload = @Sendable (
        _ data: Data,
        _ fileName: String,
        _ mimeType: String,
        _ onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> String

    private(set) var photo: StagedPhoto?

    /// The bytes, kept for a retry after a failed upload and until the
    /// message carrying them is sent.
    @ObservationIgnored private var data: Data?
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Where the photo goes, given by the screen with each pick: the visitor
    /// chat files it under the conversation, the colleague chat under the
    /// workspace alone.
    @ObservationIgnored private var upload: Upload?
    /// The server said the session is void.
    @ObservationIgnored var onUnauthorized: (@MainActor () async -> Void)?

    nonisolated init() {}

    /// The uploaded file, once it is ready to go with a message.
    var attachmentID: String? { photo?.attachmentID }

    /// Puts a photo in the field and starts its upload. A second pick
    /// replaces the first. False when the bytes are not a picture.
    @discardableResult
    func stage(data: Data, fileName: String, mimeType: String, using upload: @escaping Upload) async -> Bool {
        guard let preview = await AttachmentPreviews.decode(data, maxPixel: CachePolicy.attachmentPreviewPixels) else {
            return false
        }
        discard()
        self.data = data
        self.upload = upload
        photo = StagedPhoto(
            id: UUID(), preview: preview, fileName: fileName, mimeType: mimeType,
            sizeBytes: data.count, phase: .uploading(0)
        )
        start()
        return true
    }

    /// Tries a failed upload again, with the same bytes.
    func retry() {
        guard case .failed = photo?.phase else { return }
        start()
    }

    /// Takes the photo out of the field, stopping its upload. A file the
    /// server already has stays attached to no message.
    func discard() {
        task?.cancel()
        task = nil
        photo = nil
        data = nil
        upload = nil
    }

    /// The ready photo, taken out of the field for a send. Nil while there is
    /// none or it is still uploading.
    func takeForSending() -> StagedPhoto? {
        guard let photo, photo.attachmentID != nil else { return nil }
        self.photo = nil
        return photo
    }

    /// A send that failed: the photo goes back in the field, already
    /// uploaded — unless another one was picked meanwhile.
    func putBack(_ sent: StagedPhoto) {
        guard photo == nil else { return }
        photo = sent
    }

    /// The message with this photo is on the server.
    func sent(_ sent: StagedPhoto) {
        guard photo == nil else { return }
        data = nil
        upload = nil
    }

    private func start() {
        guard let staged = photo, let data, let upload else { return }
        let id = staged.id
        photo?.phase = .uploading(0)
        task?.cancel()
        task = Task {
            do {
                let attachmentID = try await upload(data, staged.fileName, staged.mimeType) { sent in
                    Task { @MainActor [weak self] in self?.moved(id, to: sent) }
                }
                guard !Task.isCancelled, photo?.id == id else { return }
                photo?.phase = .ready(attachmentID: attachmentID)
            } catch APIError.unauthorized {
                guard !Task.isCancelled else { return }
                discard()
                await onUnauthorized?()
            } catch {
                guard !Task.isCancelled, photo?.id == id else { return }
                photo?.phase = .failed
            }
        }
    }

    /// Only forward, and only while it is still uploading: a report that
    /// lands after the answer must not take a finished photo back.
    private func moved(_ id: UUID, to sent: Double) {
        guard photo?.id == id, case .uploading(let shown) = photo?.phase, sent > shown else { return }
        photo?.phase = .uploading(sent)
    }
}
