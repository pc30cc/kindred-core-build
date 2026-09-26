using Webyar.App.Helpers;
using Webyar.App.ViewModels;

namespace Webyar.App.Services;

/// <summary>
/// "Open" hands a file to another app, which needs it as a real file: a copy
/// in %TEMP%\Webyar\&lt;id&gt;. It is written once — opening it again, even
/// while that app still has it open, reuses the copy — and the folder is
/// swept by Clear cache and on sign-out, so customer files do not linger.
/// </summary>
public static class OpenedFiles
{
    public static async Task<string> PrepareAsync(AttachmentItem a)
    {
        var dir = Path.Combine(AppPaths.OpenedFiles, a.Id.Replace(':', '_'));
        var name = string.Join("_", a.FileName.Split(Path.GetInvalidFileNameChars()));
        if (!Path.HasExtension(name)) name += Mime.Extension(a.MimeType);
        var path = Path.Combine(dir, name);
        if (File.Exists(path) && new FileInfo(path).Length > 0) return path;
        var data = await a.BytesAsync();
        Directory.CreateDirectory(dir);
        await File.WriteAllBytesAsync(path, data);
        return path;
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
