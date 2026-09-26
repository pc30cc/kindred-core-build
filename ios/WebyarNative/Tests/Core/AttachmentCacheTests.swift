import Foundation
import XCTest
@testable import WebyarNative

/// Attachment files: memory, then disk, then the server — once per file,
/// kept across launches, bounded, scoped, and never named by the sender.
final class AttachmentCacheTests: XCTestCase {
    private var root: URL!
    private var api: TestAPI!
    private let scope = LocalStore.Scope(userID: "u1", workspaceID: "w1")
    private let photo = MessageAttachment(id: "att-1", fileName: "holiday.jpg", mimeType: "image/jpeg", sizeBytes: 4, kind: "image")
    private let voice = MessageAttachment(id: "att-2", fileName: "m4a", mimeType: "audio/mp4", sizeBytes: 6, kind: "audio")

    override func setUp() async throws {
        root = try temporaryFolder()
        api = TestAPI()
        await api.setFile(photo.id, Data([1, 2, 3, 4]))
        await api.setFile(voice.id, Data([9, 9, 9, 9, 9, 9]))
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeStore(limit: Int64 = 10 * 1024 * 1024, memory: Int = 1024 * 1024) async -> (AttachmentStore, AttachmentDiskCache) {
        let disk = AttachmentDiskCache(root: root, limit: limit)
        let store = AttachmentStore(disk: disk, memoryLimit: memory)
        await store.setScope(scope)
        return (store, disk)
    }

    // 26. Network fetch, then 24. memory hit

    func testTheFirstReadFetchesAndTheSecondIsFromMemory() async throws {
        let (store, _) = await makeStore()
        let first = try await store.data(for: photo, api: api)
        let second = try await store.data(for: photo, api: api)
        XCTAssertEqual(first, Data([1, 2, 3, 4]))
        XCTAssertEqual(second, first)
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 1)
    }

    // 25. Disk hit — a relaunch, with empty memory

    func testAFileReadBeforeIsReadFromDiskAfterARelaunch() async throws {
        let (store, _) = await makeStore()
        _ = try await store.data(for: photo, api: api)

        let (relaunched, _) = await makeStore()
        let again = try await relaunched.data(for: photo, api: api)
        XCTAssertEqual(again, Data([1, 2, 3, 4]))
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 1, "not downloaded twice")
    }

    // 27. Concurrent requests

    func testManyViewsAskingAtOnceMakeOneRequest() async throws {
        await api.setFileDelay(100_000_000)
        let (store, _) = await makeStore()
        let photo = self.photo, api: TestAPI = self.api
        async let a = store.data(for: photo, api: api)
        async let b = store.data(for: photo, api: api)
        async let c = store.data(for: photo, api: api)
        let results = try await [a, b, c]
        XCTAssertEqual(Set(results), [Data([1, 2, 3, 4])])
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 1)
    }

    // 28. Failed attachment

    func testAFailedReadKeepsNothingAndTheNextAskTriesAgain() async throws {
        await api.setFailing(photo.id, true)
        let (store, disk) = await makeStore()
        do {
            _ = try await store.data(for: photo, api: api)
            XCTFail("the server failed")
        } catch {}
        let kept = await disk.existing(id: photo.id, fileExtension: "jpg", scope: scope)
        XCTAssertNil(kept)
        await api.setFailing(photo.id, false)
        let data = try await store.data(for: photo, api: api)
        XCTAssertEqual(data, Data([1, 2, 3, 4]))
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 2)
    }

    // 31./32. Voice notes and documents: nothing is fetched until asked

    func testLookingForAFileOnDiskNeverTouchesTheNetwork() async throws {
        let (store, _) = await makeStore()
        let before = await store.cachedFileURL(for: voice)
        XCTAssertNil(before, "not downloaded yet, and not downloaded by looking")
        var calls = await api.fileCalls + api.dataCalls
        XCTAssertEqual(calls, 0)

        // Play (or open) is what downloads it — straight to a file.
        let url = try await store.fileURL(for: voice, api: api)
        XCTAssertEqual(try Data(contentsOf: url), Data([9, 9, 9, 9, 9, 9]))
        calls = await api.fileCalls
        XCTAssertEqual(calls, 1)

        // From then on, from disk — relaunches included.
        let (relaunched, _) = await makeStore()
        let cached = await relaunched.cachedFileURL(for: voice)
        XCTAssertEqual(cached, url)
        let again = try await relaunched.fileURL(for: voice, api: api)
        XCTAssertEqual(again, url)
        calls = await api.fileCalls
        XCTAssertEqual(calls, 1)
    }

    func testTheFileLivesInCachesUnderAHashedNameNeverTheSendersOne() async throws {
        let (store, disk) = await makeStore()
        let url = try await store.fileURL(for: voice, api: api)
        XCTAssertTrue(url.path.hasPrefix(root.path))
        XCTAssertFalse(url.lastPathComponent.contains("att-2"))
        XCTAssertEqual(url.pathExtension, "m4a", "the MIME type's extension, as the name had none")
        let folder = await disk.folder(for: scope)
        XCTAssertEqual(url.deletingLastPathComponent(), folder)
    }

    func testANameCannotReachOutsideTheFolder() {
        XCTAssertEqual(AttachmentDiskCache.sanitizedExtension("../../etc/passwd"), "etcpassw")
        XCTAssertEqual(AttachmentDiskCache.sanitizedExtension("PDF"), "pdf")
        XCTAssertEqual(AttachmentDiskCache.sanitizedExtension("/"), "bin")
        XCTAssertEqual(AttachmentDiskCache.sanitizedExtension(nil), "bin")
        let name = AttachmentDiskCache.fileName(id: "../../../x", fileExtension: "a/b")
        XCTAssertFalse(name.contains("/"))
        XCTAssertFalse(name.contains(".."))
        let evil = MessageAttachment(id: "e", fileName: "report.p/../../df", mimeType: nil, sizeBytes: nil, kind: nil)
        XCTAssertFalse(AttachmentDiskCache.sanitizedExtension(AttachmentFormat.fileExtension(for: evil)).contains("/"))
    }

    // Scoping

    func testAnotherWorkspaceDoesNotSeeTheFile() async throws {
        let (store, disk) = await makeStore()
        _ = try await store.fileURL(for: voice, api: api)
        let other = LocalStore.Scope(userID: "u1", workspaceID: "w2")
        let elsewhere = await disk.existing(id: voice.id, fileExtension: AttachmentFormat.fileExtension(for: voice), scope: other)
        XCTAssertNil(elsewhere)
        await store.setScope(other)
        let cached = await store.cachedFileURL(for: voice)
        XCTAssertNil(cached)
    }

    func testADownloadThatFinishesAfterSignOutIsKeptNowhere() async throws {
        await api.setFileDelay(150_000_000)
        let (store, disk) = await makeStore()
        let photo = self.photo, api: TestAPI = self.api
        async let fetched = store.data(for: photo, api: api)
        try await Task.sleep(nanoseconds: 30_000_000)
        await store.setScope(nil)
        _ = try await fetched
        let kept = await disk.existing(id: photo.id, fileExtension: "jpg", scope: scope)
        XCTAssertNil(kept, "the account signed out while it was on its way")
    }

    // 29. Disk eviction

    func testTheCacheIsTrimmedLeastRecentlyUsedFirstAndNeverAPinnedFile() async throws {
        let disk = AttachmentDiskCache(root: root, limit: 1_000)
        let a = await disk.store(Data(repeating: 1, count: 400), id: "a", fileExtension: "bin", scope: scope)
        try await Task.sleep(nanoseconds: 20_000_000)
        let b = await disk.store(Data(repeating: 2, count: 400), id: "b", fileExtension: "bin", scope: scope)
        XCTAssertNotNil(a)
        XCTAssertNotNil(b)
        // "a" is in use (playing): a trim must leave it.
        if let a { await disk.pin(a) }
        try await Task.sleep(nanoseconds: 20_000_000)
        _ = await disk.store(Data(repeating: 3, count: 400), id: "c", fileExtension: "bin", scope: scope)

        let hasA = await disk.existing(id: "a", fileExtension: "bin", scope: scope)
        let hasB = await disk.existing(id: "b", fileExtension: "bin", scope: scope)
        let hasC = await disk.existing(id: "c", fileExtension: "bin", scope: scope)
        XCTAssertNotNil(hasA, "pinned")
        XCTAssertNil(hasB, "the least recently used unpinned file went")
        XCTAssertNotNil(hasC, "the newest stays")
        let size = await disk.size()
        XCTAssertLessThanOrEqual(size, 1_000)
    }

    func testAnEmptyFileIsNotAHit() async throws {
        let disk = AttachmentDiskCache(root: root, limit: 10_000)
        let url = await disk.location(id: "z", fileExtension: "bin", scope: scope)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: url)
        let hit = await disk.existing(id: "z", fileExtension: "bin", scope: scope)
        XCTAssertNil(hit)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "and it is cleaned away")
    }

    func testADamagedCopyIsDroppedAndFetchedAgain() async throws {
        let (store, disk) = await makeStore()
        _ = try await store.data(for: photo, api: api)
        await store.discard(photo)
        let gone = await disk.existing(id: photo.id, fileExtension: "jpg", scope: scope)
        XCTAssertNil(gone)
        _ = try await store.data(for: photo, api: api)
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 2)
    }

    // 30. Clear, while something plays

    func testClearingRemovesEverythingButAFileInUse() async throws {
        let disk = AttachmentDiskCache(root: root, limit: 10_000)
        let playing = await disk.store(Data([1]), id: "playing", fileExtension: "m4a", scope: scope)
        _ = await disk.store(Data([2]), id: "idle", fileExtension: "m4a", scope: scope)
        if let playing { await disk.pin(playing) }
        await disk.removeAll()
        let stillPlaying = await disk.existing(id: "playing", fileExtension: "m4a", scope: scope)
        let idle = await disk.existing(id: "idle", fileExtension: "m4a", scope: scope)
        XCTAssertNotNil(stillPlaying)
        XCTAssertNil(idle)
    }

    // 35. Memory pressure: NSCache lets go, the disk still answers

    func testWhatMemoryLetsGoIsReadFromDiskNotTheNetwork() async throws {
        await api.setFile("big-1", Data(repeating: 1, count: 600))
        await api.setFile("big-2", Data(repeating: 2, count: 600))
        let (store, _) = await makeStore(memory: 700)
        let one = MessageAttachment(id: "big-1", fileName: "1.bin", mimeType: nil, sizeBytes: nil, kind: "file")
        let two = MessageAttachment(id: "big-2", fileName: "2.bin", mimeType: nil, sizeBytes: nil, kind: "file")
        _ = try await store.data(for: one, api: api)
        _ = try await store.data(for: two, api: api)   // over the memory budget: "big-1" may go
        await store.clearMemory()                      // and memory pressure takes the rest
        _ = try await store.data(for: one, api: api)
        _ = try await store.data(for: two, api: api)
        let calls = await api.dataCalls
        XCTAssertEqual(calls, 2, "evicted from memory, read back from disk")
    }

    func testTheLimitFollowsFreeSpaceWithinItsBounds() {
        XCTAssertEqual(CachePolicy.attachmentDiskLimit(freeBytes: nil), CachePolicy.attachmentDiskFloor)
        XCTAssertEqual(CachePolicy.attachmentDiskLimit(freeBytes: 1024 * 1024 * 1024), CachePolicy.attachmentDiskFloor)
        XCTAssertEqual(CachePolicy.attachmentDiskLimit(freeBytes: 4 * 1024 * 1024 * 1024), Int64(Double(4 * 1024 * 1024 * 1024) * 0.05))
        XCTAssertEqual(CachePolicy.attachmentDiskLimit(freeBytes: 100 * 1024 * 1024 * 1024), CachePolicy.attachmentDiskCeiling)
    }
}
