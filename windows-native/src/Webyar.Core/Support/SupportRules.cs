using System.Globalization;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.Core.Support;

/// <summary>
/// What the server takes (server/services/platformSupport/text.ts) and how
/// support reads to the operator — plain functions, tested on their own.
/// </summary>
public static class SupportRules
{
    /// <summary>The server's limit on a message body.</summary>
    public const int MaxBody = 4000;

    /// <summary>The server's limit on a rating comment.</summary>
    public const int MaxComment = 1000;

    /// <summary>The server's limit on a support file, decoded: 2 MB.</summary>
    public const long MaxFileBytes = 2L * 1024 * 1024;

    /// <summary>Realtime kinds that mean the history moved (publishSupportEvent).</summary>
    public static readonly IReadOnlySet<string> LiveKinds = new HashSet<string>(StringComparer.Ordinal) { "support_message", "support_update", "support_read" };

    /// <summary>ALLOWED_FILE_TYPES: the chat widget's own list — pictures, PDF and plain text. No sound, no video.</summary>
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain",
    };

    private static readonly Dictionary<string, string> ByExtension = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".gif"] = "image/gif",
        [".pdf"] = "application/pdf",
        [".txt"] = "text/plain",
    };

    /// <summary>The file picker's filter: only what the server takes, so nothing is picked just to be refused.</summary>
    public static readonly IReadOnlyList<string> PickableExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".txt"];

    /// <summary>The prefix the app's file store keeps support files under.</summary>
    public const string StorePrefix = "support:";

    public static string StoreId(string attachmentId) => StorePrefix + attachmentId;

    /// <summary>The type a picked file goes as: by its extension first (what the server checks), else what Windows says; null when not allowed.</summary>
    public static string? CanonicalMime(string fileName, string? contentType)
    {
        if (ByExtension.TryGetValue(Path.GetExtension(fileName ?? string.Empty), out var byName)) return byName;
        var given = (contentType ?? string.Empty).Split(';')[0].Trim().ToLowerInvariant();
        if (given == "image/jpg") given = "image/jpeg";
        return Allowed.Contains(given) ? given : null;
    }

    public enum FileVerdict { Ok, TypeNotAllowed, TooLarge, Empty }

    /// <summary>Refused here, before a byte is sent, when the server would refuse it.</summary>
    public static FileVerdict CheckFile(string? mimeType, long size)
    {
        if (mimeType is null || !Allowed.Contains(mimeType)) return FileVerdict.TypeNotAllowed;
        if (size <= 0) return FileVerdict.Empty;
        return size > MaxFileBytes ? FileVerdict.TooLarge : FileVerdict.Ok;
    }

    /// <summary>
    /// What an error from `/api/platform-support` means to the operator: its
    /// own codes first (docs/PLATFORM_SUPPORT.md), then the app's usual wording.
    /// </summary>
    public static string ErrorText(Exception error, Strings s)
    {
        var code = (error as ApiException)?.ServerMessage ?? string.Empty;
        if (code.Contains("conversation_ended", StringComparison.Ordinal)) return s["supportConversationEnded"];
        if (code.Contains("rate_limited", StringComparison.Ordinal)) return s["supportRateLimited"];
        if (code.Contains("file_too_large", StringComparison.Ordinal)) return s["supportFileTooLarge"];
        if (code.Contains("file_type_not_allowed", StringComparison.Ordinal)) return s["supportFileTypeNotAllowed"];
        if (code.Contains("support_disabled", StringComparison.Ordinal) || code.Contains("support_not_configured", StringComparison.Ordinal)) return s["supportUnavailable"];
        return Inbox.ErrorText.For(error, s);
    }

    public static bool IsConversationEnded(Exception error) =>
        (error as ApiException)?.ServerMessage?.Contains("conversation_ended", StringComparison.Ordinal) == true;

    /// <summary>A rating the server says is given already, or cannot be: the chat is simply read again.</summary>
    public static bool IsStaleRating(Exception error) =>
        (error as ApiException)?.ServerMessage is { } m && (m.Contains("already_rated", StringComparison.Ordinal) || m.Contains("not_ratable", StringComparison.Ordinal));

    /// <summary>The conversations that have ended, the one that ended last first.</summary>
    public static IReadOnlyList<SupportConversation> Closed(IEnumerable<SupportConversation> conversations) =>
        conversations.Where(c => c.Ended).OrderByDescending(c => c.EndedAt ?? c.CreatedAt ?? DateTimeOffset.MinValue).ToList();

    /// <summary>
    /// A line to know a closed conversation by: what the operator wrote
    /// first — its text, or the name of the file they sent — else the team's first word.
    /// </summary>
    public static string? Preview(string conversationId, IEnumerable<SupportItem> items)
    {
        var own = items.Where(i => i.ConversationId == conversationId && !i.IsJoin).ToList();
        var first = own.FirstOrDefault(i => !i.FromTeam) ?? own.FirstOrDefault();
        var text = first?.Text.Trim();
        if (!string.IsNullOrEmpty(text)) return text.Split('\n')[0].Trim();
        return first?.Files.FirstOrDefault()?.FileName is { Length: > 0 } name ? name : null;
    }

    /// <summary>What a closed conversation is called: its first words, or a plain name.</summary>
    public static string ClosedTitle(string? preview, Strings s) =>
        string.IsNullOrWhiteSpace(preview) ? s["supportConversationUntitled"] : preview;

    /// <summary>«حل شد · ۵ مهر»: how and when it ended.</summary>
    public static string ClosedSubtitle(SupportConversation c, Strings s, DateTimeOffset now, TimeZoneInfo? zone = null)
    {
        var word = s[c.Status == SupportConversation.StatusClosed ? "supportStatusClosed" : "supportStatusResolved"];
        return (c.EndedAt ?? c.CreatedAt) is { } at ? $"{word} · {DayHeader(at, s, now, zone)}" : word;
    }

    /// <summary>The line under an ended conversation, by its status.</summary>
    public static string EndedSentence(string status, Strings s) =>
        s[status == SupportConversation.StatusClosed ? "supportEndedClosed" : "supportEndedResolved"];

    /// <summary>"Online", or "Offline · Leave a message".</summary>
    public static string Presence(bool online, Strings s) => s[online ? "supportOnline" : "supportOfflineLeaveMessage"];

    /// <summary>«گفتگوی تازه · ‹date›».</summary>
    public static string NewConversation(DateTimeOffset? startedAt, Strings s, DateTimeOffset now, TimeZoneInfo? zone = null) =>
        startedAt is { } at ? $"{s["supportNewConversation"]} · {DayHeader(at, s, now, zone)}" : s["supportNewConversation"];

    public static string Joined(string? name, Strings s) =>
        s.Get("supportJoined", "name", string.IsNullOrWhiteSpace(name) ? s["supportTeam"] : "⁨" + name.Trim() + "⁩");

    public static string Stars(int count, Strings s) => count == 1 ? s["supportStarsOne"] : s.Get("supportStars", "n", count);

    /// <summary>Today, yesterday, else the date — as the other transcripts head a day.</summary>
    public static string DayHeader(DateTimeOffset when, Strings s, DateTimeOffset now, TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        var day = TimeZoneInfo.ConvertTime(when, zone).Date;
        var today = TimeZoneInfo.ConvertTime(now, zone).Date;
        if (day == today) return s["today"];
        if (day == today.AddDays(-1)) return s["yesterday"];
        var weekday = s.Culture.DateTimeFormat.GetDayName(day.DayOfWeek);
        return $"{weekday} {Display.ShortDate(day, s.Language)}";
    }

    /// <summary>
    /// When the hours open again: "We'll be back at 9:00" later today,
    /// "… tomorrow at 9:00", a weekday within the coming week, a date beyond.
    /// </summary>
    public static string NextOpen(DateTimeOffset at, Strings s, DateTimeOffset now, TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        var local = TimeZoneInfo.ConvertTime(at, zone);
        var today = TimeZoneInfo.ConvertTime(now, zone).Date;
        var time = Display.ClockTime(at, s.Language, zone);
        if (local.Date <= today) return s.Get("supportNextOpenToday", "time", time);
        string day;
        if (local.Date == today.AddDays(1)) day = s["supportTomorrow"];
        else if (local.Date < today.AddDays(7)) day = s.Culture.DateTimeFormat.GetDayName(local.DayOfWeek);
        else day = Display.ShortDate(local.Date, s.Language);
        var line = s.Get("supportNextOpenDay", new Dictionary<string, object> { ["day"] = day, ["time"] = time });
        return s.Language == Language.Tr && line.Length > 0 ? char.ToUpper(line[0], s.Culture) + line[1..] : line;
    }

    /// <summary>A stored `HH:mm` as the reader writes it: «۹:۰۰», "9:00".</summary>
    public static string OpeningTime(string value, Language language)
    {
        var parts = value.Split(':');
        if (parts.Length != 2 || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var h) ||
            !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var m) || h is < 0 or > 24 || m is < 0 or > 59)
            return value;
        return Digits.Localize($"{h}:{m:00}", language);
    }
}
