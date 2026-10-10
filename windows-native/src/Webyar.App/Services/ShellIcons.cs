using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Webyar.App.Services;

/// <summary>
/// Makes Windows show the app's current icon after an update. Explorer caches icons by path, and
/// Velopack replaces the exe in place (`…\current\`), so the taskbar, the Start menu and the
/// desktop shortcut kept the icon of before (seen after WebYar's new brand kit, 2026-10-10)
/// until the icon cache was rebuilt. Run from Velopack's install and update hooks, both brands.
/// </summary>
public static class ShellIcons
{
    private const int SHCNE_UPDATEITEM = 0x00002000;
    private const int SHCNE_ASSOCCHANGED = 0x08000000;
    private const uint SHCNF_IDLIST = 0x0000;
    private const uint SHCNF_PATHW = 0x0005;
    private const uint SHCNF_FLUSHNOWAIT = 0x3000;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int eventId, uint flags, string? item1, IntPtr item2);

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    public static void Refresh()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (exe is not null)
            {
                SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, exe, IntPtr.Zero);
                // Velopack's launcher one level up, which the shortcuts and the Run entry point at.
                var dir = Path.GetDirectoryName(exe);
                if (dir is not null && string.Equals(Path.GetFileName(dir), "current", StringComparison.OrdinalIgnoreCase))
                {
                    var launcher = Path.Combine(Path.GetDirectoryName(dir)!, Path.GetFileName(exe));
                    if (File.Exists(launcher))
                        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, launcher, IntPtr.Zero);
                }
            }
            // Tells Explorer its icon cache is stale: the taskbar and shortcuts re-read the icons.
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSHNOWAIT, IntPtr.Zero, IntPtr.Zero);

            // Windows' own refresher of the per-user icon cache; not waited for.
            var ie4uinit = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "ie4uinit.exe");
            if (File.Exists(ie4uinit))
                Process.Start(new ProcessStartInfo(ie4uinit, "-show") { UseShellExecute = false, CreateNoWindow = true })?.Dispose();
        }
        catch (Exception e)
        {
            Log.Error("icon refresh", e);
        }
    }
}
