using Microsoft.Win32;

namespace Webyar.App.Services;

/// <summary>"Start with Windows": a Run entry for this user, pointing at Velopack's stable launcher.</summary>
public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "Webyar";

    public static void Apply(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
            if (enabled) key.SetValue(Name, $"\"{LauncherPath()}\" --hidden");
            else key.DeleteValue(Name, throwOnMissingValue: false);
        }
        catch (Exception e)
        {
            Log.Error("startup registration", e);
        }
    }

    /// <summary>
    /// Velopack runs the app from `…\Webyar\current\`, which each update replaces,
    /// and keeps a launcher one level up; the Run entry must survive updates.
    /// </summary>
    private static string LauncherPath()
    {
        var exe = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Webyar.exe");
        var dir = Path.GetDirectoryName(exe);
        if (dir is not null && string.Equals(Path.GetFileName(dir), "current", StringComparison.OrdinalIgnoreCase))
        {
            var launcher = Path.Combine(Path.GetDirectoryName(dir)!, Path.GetFileName(exe));
            if (File.Exists(launcher)) return launcher;
        }
        return exe;
    }
}
