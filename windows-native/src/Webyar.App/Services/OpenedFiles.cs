using Webyar.App.Helpers;
using Webyar.App.ViewModels;
using Webyar.Core.Localization;
using Windows.System;

namespace Webyar.App.Services;

/// <summary>
/// Opening attachments. Whoever sent a file chose its name, and handing an .exe,
/// .bat, .js, .hta, .lnk, .docm … to Windows' default handler runs it. So only
/// types whose default handler just shows the content are opened; everything
/// else is offered through "Save as". Every file written is tagged as coming
/// from the internet (Mark of the Web), as a browser download would be.
/// </summary>
public static class OpenedFiles
{
    /// <summary>Opened as-is: viewers that do not run code from the file.</summary>
    private static readonly HashSet<string> Passive = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic",
        ".pdf", ".txt",
        ".mp3", ".wav", ".ogg", ".m4a", ".mp4", ".webm", ".mov",
    };

    /// <summary>
    /// Opened only when the Mark of the Web could be written, so Office shows
    /// them in Protected View. Macro-enabled formats (.docm, .xlsm, …) never are.
    /// </summary>
    private static readonly HashSet<string> NeedsMarkOfTheWeb = new(StringComparer.OrdinalIgnoreCase)
    {
        ".docx", ".xlsx", ".pptx", ".csv",
    };

    public enum Outcome
    {
        Opened,
        /// <summary>Not a type that is safe to open; the operator was offered "Save as".</summary>
        Saved,
        Cancelled,
    }

    /// <summary>Opens a passive file with whatever Windows opens it with, or offers to save anything else.</summary>
    public static async Task<Outcome> OpenAsync(AttachmentItem a)
    {
        var data = await a.BytesAsync();
        var name = SafeName(a.FileName, a.MimeType);
        var ext = Path.GetExtension(name);
        var passive = Passive.Contains(ext);
        if (passive || NeedsMarkOfTheWeb.Contains(ext))
        {
            // %TEMP%\Webyar\<id>: swept by Clear cache and on sign-out (see Clear).
            var dir = Path.Combine(AppPaths.OpenedFiles, a.Id.Replace(':', '_'));
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, name);
            if (!File.Exists(path) || new FileInfo(path).Length == 0)
                await File.WriteAllBytesAsync(path, data);
            if (MarkFromInternet(path) || passive)
            {
                var stored = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
                await Launcher.LaunchFileAsync(stored);
                return Outcome.Opened;
            }
        }
        return await SaveAsync(name, data) ? Outcome.Saved : Outcome.Cancelled;
    }

    /// <summary>Why a file was saved instead of opened, in the operator's language.</summary>
    public static string SavedInsteadMessage(Strings s) => s.Language switch
    {
        Webyar.Core.Localization.Language.Fa => "این نوع فایل می‌تواند کد اجرا کند، پس مستقیم باز نمی‌شود. آن را ذخیره کردید؛ پیش از باز کردن بررسی کنید.",
        Webyar.Core.Localization.Language.Tr => "Bu tür bir dosya kod çalıştırabilir, bu yüzden doğrudan açılmaz. Kaydedildi; açmadan önce kontrol edin.",
        _ => "This kind of file can run code, so it is not opened directly. It was saved instead; check it before opening.",
    };

    private static async Task<bool> SaveAsync(string name, byte[] data)
    {
        var picker = new Windows.Storage.Pickers.FileSavePicker { SuggestedFileName = Path.GetFileNameWithoutExtension(name) };
        var ext = Path.GetExtension(name);
        // "." lets a file without an extension keep having none.
        picker.FileTypeChoices.Add(ext.Length > 1 ? ext.TrimStart('.').ToUpperInvariant() : "File", new List<string> { ext.Length > 1 ? ext : "." });
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.Current.Window!));
        var file = await picker.PickSaveFileAsync();
        if (file is null) return false;
        await Windows.Storage.FileIO.WriteBytesAsync(file, data);
        if (!string.IsNullOrEmpty(file.Path)) MarkFromInternet(file.Path);
        return true;
    }

    /// <summary>
    /// Tags a file as downloaded from the internet (the Zone.Identifier NTFS
    /// stream), so SmartScreen and Office's Protected View apply. Best effort.
    /// </summary>
    public static bool MarkFromInternet(string path)
    {
        try
        {
            File.WriteAllText(path + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n");
            return true;
        }
        catch (Exception e)
        {
            Log.Error("mark of the web", e);
            return false;
        }
    }

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>A file name Windows stores exactly as given: no folders, streams, bidi tricks or trailing dots.</summary>
    internal static string SafeName(string fileName, string mimeType)
    {
        var last = (fileName ?? string.Empty).Split('/', '\\').LastOrDefault() ?? string.Empty;
        var invalid = Path.GetInvalidFileNameChars();
        var chars = last
            .Where(c => c is not ('‎' or '‏' or (>= '‪' and <= '‮') or (>= '⁦' and <= '⁩')))
            .Select(c => Array.IndexOf(invalid, c) >= 0 || c == ':' || char.IsControl(c) ? '_' : c)
            .ToArray();
        // Windows drops trailing dots and spaces, so "a.exe." would really be "a.exe".
        var name = new string(chars).TrimEnd('.', ' ').Trim();
        if (!Path.HasExtension(name)) name += Mime.Extension(mimeType);
        if (name.Length == 0 || ReservedNames.Contains(name.Split('.')[0])) name = "file_" + name;
        return name.Length > 180 ? name[^180..] : name;
    }

    public static void Clear()
    {
        try
        {
            if (!Directory.Exists(AppPaths.OpenedFiles)) return;
            foreach (var file in Directory.EnumerateFiles(AppPaths.OpenedFiles, "*", SearchOption.AllDirectories).ToList())
            {
                try { File.Delete(file); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* another app still has it open */ }
            }
            foreach (var dir in Directory.EnumerateDirectories(AppPaths.OpenedFiles).ToList())
            {
                try { if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
