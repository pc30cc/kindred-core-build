namespace Webyar.App.Services;

/// <summary>
/// Everything the app keeps lives in %APPDATA%\WebyarWindows — outside the
/// Velopack install folder, so an update or reinstall never touches it.
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
    public static string Icon => Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png");
    public static string WindowIcon => Path.Combine(AppContext.BaseDirectory, "Assets", "Webyar.ico");

    private static string Ensure(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }
}
