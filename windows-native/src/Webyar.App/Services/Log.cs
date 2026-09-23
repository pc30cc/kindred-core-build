namespace Webyar.App.Services;

/// <summary>
/// A plain text log in %APPDATA%\WebyarWindows\logs\app.log, one previous file
/// kept past 2 MB — so a problem on someone's machine leaves a trail.
/// </summary>
public static class Log
{
    private const long Limit = 2 * 1024 * 1024;
    private static readonly object Gate = new();

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                var file = Path.Combine(AppPaths.Logs, "app.log");
                if (File.Exists(file) && new FileInfo(file).Length > Limit)
                    File.Move(file, Path.Combine(AppPaths.Logs, "app.old.log"), overwrite: true);
                File.AppendAllText(file, $"{DateTimeOffset.UtcNow:O} {line}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
            // Logging must never be what breaks the app.
        }
    }

    public static void Error(string what, Exception e) => Write($"error {what}: {e.GetType().Name}: {e.Message}");
}
