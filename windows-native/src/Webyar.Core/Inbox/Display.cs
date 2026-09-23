using System.Globalization;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.Core.Inbox;

/// <summary>How conversations and messages read in lists and notifications — the same rules as the other clients.</summary>
public static class Display
{
    public static string ContactName(ConversationContact? contact, Strings s, string? fallbackId = null) =>
        VisitorName(contact?.Name, contact?.VisitorCode, fallbackId, null, null, null, s);

    /// <summary>The name the web inbox shows: with the visitor's city once the network profile is known.</summary>
    public static string ConversationName(Conversation c, Strings s) =>
        VisitorName(c.Contacts?.Name, c.Contacts?.VisitorCode, c.ContactId ?? c.Id, c.VisitorCity, c.VisitorRegion, c.VisitorCountryCode, s);

    /// <summary>
    /// The web console's contactDisplayName: the contact's own name, else
    /// "Visitor from {city} · {code}" (the province for Iran), else
    /// "Visitor · {code}". The code is the widget's, else a hash of the id,
    /// exactly as the server derives it.
    /// </summary>
    public static string VisitorName(string? name, string? code, string? fallbackId, string? city, string? region, string? countryCode, Strings s)
    {
        var n = (name ?? string.Empty).Trim();
        if (n.Length > 0 && !n.Equals("visitor", StringComparison.OrdinalIgnoreCase)) return n;
        var c = code is { Length: > 0 } ? code.Trim() : fallbackId is { Length: > 0 } ? LegacyCode(fallbackId) : "----";
        var isolated = "\u2068" + c + "\u2069";
        var iran = string.Equals(countryCode?.Trim(), "IR", StringComparison.OrdinalIgnoreCase);
        var place = (iran ? region : city)?.Trim();
        if (string.IsNullOrEmpty(place)) return s.Get("visitorAnonymous", "code", isolated);
        var vars = new Dictionary<string, object> { ["code"] = isolated, [iran ? "region" : "city"] = "\u2068" + place + "\u2069" };
        return s.Get(iran ? "visitorAnonymousFromRegion" : "visitorAnonymousFromCity", vars);
    }

    /// <summary>server/services/widget/anonymousContact.ts anonCodeFrom: base-36 of a ×31 hash, last four.</summary>
    public static string LegacyCode(string seed)
    {
        uint h = 0;
        foreach (var ch in seed) h = unchecked(h * 31 + ch);
        const string digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        var sb = new System.Text.StringBuilder();
        do { sb.Insert(0, digits[(int)(h % 36)]); h /= 36; } while (h > 0);
        var text = sb.ToString().PadLeft(4, '0');
        return text[^4..];
    }

    /// <summary>Up to two letters for an avatar, from the first two words.</summary>
    public static string Initials(string name)
    {
        var words = name.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (words.Length == 0) return "?";
        var first = StringInfo.GetNextTextElementLength(words[0]) is var n && n > 0 ? words[0][..n] : words[0];
        if (words.Length == 1) return first.ToUpper(CultureInfo.CurrentCulture);
        var second = StringInfo.GetNextTextElementLength(words[1]) is var m && m > 0 ? words[1][..m] : words[1];
        // "بازدیدکننده 4ZTK" would render as a jumbled "ب4": mixed directions keep one letter.
        if (IsRightToLeft(first) != IsRightToLeft(second)) return first.ToUpper(CultureInfo.CurrentCulture);
        return (first + second).ToUpper(CultureInfo.CurrentCulture);
    }

    private static bool IsRightToLeft(string text) =>
        text.Length > 0 && text[0] is >= '\u0590' and <= '\u08FF' or >= '\uFB1D' and <= '\uFEFC';

    /// <summary>A one-line preview of the last message; attachments get a sentence instead of an empty line.</summary>
    public static string Preview(MessagePreview? last, Strings s)
    {
        if (last is null) return string.Empty;
        var body = OneLine(last.Body);
        if (body.Length > 0) return body;
        if (string.IsNullOrEmpty(last.AttachmentKind)) return string.Empty;
        var outgoing = last.SenderType is SenderTypes.Agent or SenderTypes.Ai or SenderTypes.Bot;
        return AttachmentPreview(last.AttachmentKind, outgoing, last.SenderName, s);
    }

    /// <summary>"You sent a photo" / "Sara sent a photo" — windows/src/renderer/src/lib/format.ts, word for word.</summary>
    public static string AttachmentPreview(string kind, bool isMe, string? senderName, Strings s)
    {
        var k = kind switch { "image" => "Image", "audio" => "Audio", "video" => "Video", _ => "File" };
        if (isMe) return s[$"previewYouSent{k}"];
        var sender = string.IsNullOrWhiteSpace(senderName) ? s["previewSomeone"] : senderName.Trim();
        return s.Get($"previewSentBy{k}", "name", sender);
    }

    /// <summary>Any run of whitespace, line breaks included, becomes one space.</summary>
    public static string OneLine(string? text) =>
        string.Join(' ', (text ?? string.Empty).Split((char[])[' ', '\r', '\n', '\t', '\u00A0'], StringSplitOptions.RemoveEmptyEntries));

    /// <summary>
    /// The stamp beside a conversation: the time today, "Yesterday", the weekday
    /// within a week, otherwise the date — in the Persian calendar and digits
    /// for Persian.
    /// </summary>
    public static string ListStamp(DateTimeOffset when, DateTimeOffset now, Strings s, TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        var local = TimeZoneInfo.ConvertTime(when, zone);
        var today = TimeZoneInfo.ConvertTime(now, zone).Date;
        var culture = s.Culture;
        string text;
        if (local.Date == today) text = local.ToString("HH:mm", CultureInfo.InvariantCulture);
        else if (local.Date == today.AddDays(-1)) text = s["yesterday"];
        else if (local.Date > today.AddDays(-7)) text = culture.DateTimeFormat.GetDayName(local.DayOfWeek);
        else text = ShortDate(local.DateTime, s.Language);
        return Digits.Localize(text, s.Language);
    }

    /// <summary>The clock time under a chat bubble.</summary>
    public static string ClockTime(DateTimeOffset when, Language language, TimeZoneInfo? zone = null) =>
        Digits.Localize(TimeZoneInfo.ConvertTime(when, zone ?? TimeZoneInfo.Local).ToString("HH:mm", CultureInfo.InvariantCulture), language);

    public static string ShortDate(DateTime date, Language language)
    {
        if (language == Language.Fa)
        {
            var pc = new PersianCalendar();
            return Digits.Localize($"{pc.GetYear(date)}/{pc.GetMonth(date):00}/{pc.GetDayOfMonth(date):00}", language);
        }
        return date.ToString("d", Strings.CultureOf(language));
    }
}

/// <summary>The words an error shows — the same mapping as the iOS app and the Electron client.</summary>
public static class ErrorText
{
    public static string For(Exception error, Strings s, string? unauthorized = null)
    {
        if (error is not ApiException e) return s["offlineBody"];
        return e.Failure switch
        {
            ApiFailure.Transport => s["offlineBody"],
            ApiFailure.Unauthorized => unauthorized ?? s["sessionExpired"],
            ApiFailure.Decoding => s["errorUnreadableAnswer"],
            _ when s.Language == Language.En && e.ServerMessage is { Length: > 0 } m => m,
            _ => (e.Status ?? 500) switch
            {
                400 or 422 => s["errorInvalidInput"],
                404 => s["errorNotFound"],
                409 => s["errorConflict"],
                429 => s["errorTooManyRequests"],
                >= 400 and < 500 => s["errorNotAllowed"],
                _ => s["errorServerProblem"],
            },
        };
    }
}
