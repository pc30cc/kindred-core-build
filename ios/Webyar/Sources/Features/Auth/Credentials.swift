import Foundation

/// Cleans what an iOS keyboard actually hands us before it reaches the server.
///
/// This is a port of `src/mobile/normalizeCredentials.ts`, and it exists for a
/// concrete reason: the Persian and Arabic iOS keyboards silently insert
/// bidirectional and zero-width marks, and they type Persian digits. None of
/// those are ever part of a real credential, but they do make an otherwise
/// correct email or password fail to match on the server — which the operator
/// experiences as "my password stopped working".
enum Credentials {

    /// Bidi controls, zero-width characters and the BOM.
    private static let invisible: Set<Unicode.Scalar> = {
        var set = Set<Unicode.Scalar>()
        for value in 0x200B...0x200F { set.insert(Unicode.Scalar(value)!) }   // ZWSP…RLM
        set.insert(Unicode.Scalar(0x061C)!)                                   // Arabic letter mark
        for value in 0x202A...0x202E { set.insert(Unicode.Scalar(value)!) }   // LRE…RLO
        for value in 0x2066...0x2069 { set.insert(Unicode.Scalar(value)!) }   // LRI…PDI
        set.insert(Unicode.Scalar(0xFEFF)!)                                   // BOM
        return set
    }()

    /// Removes the invisible marks and folds a non-breaking space to a normal
    /// one. Applied to passwords too — a password is compared byte for byte,
    /// so a stray mark is exactly as fatal there.
    static func stripInvisible(_ value: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in value.unicodeScalars where !invisible.contains(scalar) {
            scalars.append(scalar == "\u{00A0}" ? " " : scalar)
        }
        return String(scalars)
    }

    /// Everything `stripInvisible` does, plus Persian/Arabic-Indic digits
    /// folded to ASCII, trimmed and lowercased — the form the server stores.
    static func normalizeEmail(_ value: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in stripInvisible(value).unicodeScalars {
            switch scalar.value {
            case 0x06F0...0x06F9, 0x0660...0x0669:
                // Both ranges are ordered 0–9, so the low nibble is the digit.
                scalars.append(Unicode.Scalar(0x30 + (scalar.value & 0xF))!)
            default:
                scalars.append(scalar)
            }
        }
        return String(scalars)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    /// A shape check only — enough to enable the submit button without
    /// pretending to know which addresses exist. The server decides.
    static func isPlausibleEmail(_ value: String) -> Bool {
        let normalized = normalizeEmail(value)
        guard let at = normalized.firstIndex(of: "@"), at != normalized.startIndex else { return false }
        let domain = normalized[normalized.index(after: at)...]
        return !domain.isEmpty
            && domain.contains(".")
            && !domain.hasPrefix(".")
            && !domain.hasSuffix(".")
            && !normalized.contains(" ")
            && normalized.filter { $0 == "@" }.count == 1
    }
}
