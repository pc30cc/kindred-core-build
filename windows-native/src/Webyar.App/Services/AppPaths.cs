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
    public static string Files { get; } = Ensure(Path.Combine(Cache, "files"));

    /// <summary>
    /// Everything disposable, beside the installed app in %LOCALAPPDATA%\WebyarWindows\cache:
    /// Clear cache and uninstalling remove it, while settings and the DPAPI
    /// session stay in %APPDATA% and are never touched by either.
    /// </summary>
    public static string Cache => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WebyarWindows", "cache");

    /// <summary>The conversations and messages kept on this PC: one SQLite file per account (see Webyar.Core.Local.LocalStore).</summary>
    public static string LocalData { get; } = Ensure(Path.Combine(Cache, "data"));

    /// <summary>Profile photos, apart from message files: public images with their own size and age limits.</summary>
    public static string Avatars { get; } = Ensure(Path.Combine(Cache, "avatars"));

    /// <summary>Copies handed to another app by "open" (it needs a real file). Swept by Clear cache and on sign-out.</summary>
    public static string OpenedFiles => Path.Combine(Path.GetTempPath(), "Webyar");

    /// <summary>WebView2's profile (cookies, cache) for the maps, calls and email views.</summary>
    public static string WebView2 { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WebyarWindows", "WebView2"));
    public static string Icon => Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png");
    public static string WindowIcon => Path.Combine(AppContext.BaseDirectory, "Assets", "Webyar.ico");

    /// <summary>The app icon with a red phone badge: the tray's icon while calls wait, as the Mac's menu bar icon changes.</summary>
    public static string CallsWaitingIcon => Path.Combine(AppContext.BaseDirectory, "Assets", "WebyarCalls.ico");

    private static string Ensure(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }
}
