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

    public static string Of(string fileName) =>
        Types.TryGetValue(Path.GetExtension(fileName), out var t) ? t : "application/octet-stream";

    public static string Extension(string mimeType) =>
        Types.FirstOrDefault(kv => kv.Value.Equals(mimeType, StringComparison.OrdinalIgnoreCase)).Key ?? string.Empty;
}
