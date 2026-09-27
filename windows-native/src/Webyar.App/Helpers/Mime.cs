namespace Webyar.App.Helpers;

/// <summary>Just enough of the extension ↔ MIME map for what operators send and receive.</summary>
public static class Mime
{
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".heic"] = "image/heic",
        [".pdf"] = "application/pdf",
        [".txt"] = "text/plain",
        [".csv"] = "text/csv",
        [".zip"] = "application/zip",
        [".doc"] = "application/msword",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xls"] = "application/vnd.ms-excel",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".ppt"] = "application/vnd.ms-powerpoint",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        [".mp3"] = "audio/mpeg",
        [".m4a"] = "audio/mp4",
        [".ogg"] = "audio/ogg",
        [".wav"] = "audio/wav",
        [".webm"] = "video/webm",
        [".mp4"] = "video/mp4",
        [".mov"] = "video/quicktime",
    };

    /// <summary>
    /// What the server takes as a chat attachment (conversationAttachments.ts
    /// GLOBAL_ALLOWED_MIMES): pictures, PDF, plain text and sound. Anything else
    /// is refused with 415, so it is not offered, and said plainly when dropped.
    /// </summary>
    private static readonly HashSet<string> Sendable = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/webp", "image/gif",
        "application/pdf", "text/plain",
        "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
    };

    /// <summary>The file picker's filter: the extensions of the types the server takes.</summary>
    public static readonly string[] SendableExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".txt", ".mp3", ".m4a", ".ogg", ".wav"];

    public static bool CanSend(string mimeType) => Sendable.Contains(mimeType);

    /// <summary>The type to send a picked file as: by its extension, else what Windows says it is.</summary>
    public static string ForUpload(string fileName, string? contentType)
    {
        var byName = Of(fileName);
        return CanSend(byName) || string.IsNullOrEmpty(contentType) ? byName : contentType;
    }

    public static string Of(string fileName) =>
        Types.TryGetValue(Path.GetExtension(fileName), out var t) ? t : "application/octet-stream";

    public static string Extension(string mimeType) =>
        Types.FirstOrDefault(kv => kv.Value.Equals(mimeType, StringComparison.OrdinalIgnoreCase)).Key ?? string.Empty;
}
