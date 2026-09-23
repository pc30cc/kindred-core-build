namespace Webyar.App.Services;

/// <summary>
/// Everything the app keeps lives in %APPDATA%\WebyarWindows and
/// %LOCALAPPDATA%\WebyarWindows — never in the install folder, which under
/// Program Files is read-only and is replaced by every update.
/// </summary>
public static class AppPaths
{
    public static string Data { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WebyarWindows"));
    public static string Logs { get; } = Ensure(Path.Combine(Data, "logs"));
    public static string Settings => Path.Combine(Data, "settings.json");
    public static string Session => Path.Combine(Data, "session.bin");
    /// <summary>
    /// Downloaded files, beside the installed app in %LOCALAPPDATA%\WebyarWindows
    /// (Velopack's install root). Updates only replace "current", so the cache
    /// survives them, and uninstalling removes it with the app.
    /// </summary>
    public static string Files { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WebyarWindows", "cache", "files"));
    /// <summary>WebView2's profile (cookies, cache) for the maps, calls and email views.</summary>
    public static string WebView2 { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WebyarWindows", "WebView2"));
    public static string Icon => Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png");
    public static string WindowIcon => Path.Combine(AppContext.BaseDirectory, "Assets", "Webyar.ico");

    private static string Ensure(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }
}
