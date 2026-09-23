using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Webyar.Setup
{
    public enum Stage { Prepare, Copy, Shortcuts, Finish }

    public sealed class InstallOptions
    {
        public bool DesktopShortcut = true;
        public bool StartWithWindows = true;
        public bool LaunchWhenDone = true;
        public string Language = "fa";
    }

    /// <summary>
    /// Runs the embedded Velopack setup silently and turns what it does into
    /// progress: the bytes landing in the install folder against the size of
    /// the app, then the finishing touches Velopack leaves to us (the desktop
    /// shortcut if unwanted, start with Windows, the app's language).
    /// </summary>
    public static class Installer
    {
        public const string PackId = "WebyarWindows";

        public static string InstallDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PackId);

        /// <summary>Velopack's stable launcher, one level above `current`, which every update keeps.</summary>
        public static string Launcher => Path.Combine(InstallDir, "Webyar.exe");

        public static bool IsInstalled => File.Exists(Path.Combine(InstallDir, "current", "Webyar.exe"));

        public static string InstalledVersion()
        {
            try
            {
                var dll = Path.Combine(InstallDir, "current", "Webyar.dll");
                return File.Exists(dll) ? FileVersionInfo.GetVersionInfo(dll).ProductVersion : null;
            }
            catch { return null; }
        }

        public static string Version
        {
            get
            {
                var info = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
                var plus = info.IndexOf('+');
                return plus > 0 ? info.Substring(0, plus) : info;
            }
        }

        public static bool HasPayload => Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.exe") != null;

        /// <summary>The unpacked size of the app, measured when the installer was built.</summary>
        private static long ExpectedBytes
        {
            get
            {
                var meta = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "PayloadBytes");
                return meta != null && long.TryParse(meta.Value, out var n) && n > 0 ? n : 290L * 1024 * 1024;
            }
        }

        public static string LogPath => Path.Combine(Path.GetTempPath(), "Webyar-Setup.log");

        public static async Task RunAsync(InstallOptions options, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            File.WriteAllText(LogPath, $"Webyar setup {Version} {DateTime.Now:u}{Environment.NewLine}");
            progress.Report(Tuple.Create(Stage.Prepare, 0.0));

            // A running copy holds its files open; Velopack would wait on it.
            CloseRunningApp();

            var temp = Path.Combine(Path.GetTempPath(), "WebyarSetup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(temp);
            var payload = Path.Combine(temp, "WebyarWindows-win-Setup.exe");
            using (var src = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.exe"))
            {
                if (src == null) throw new InvalidOperationException("payload missing");
                using (var dst = File.Create(payload))
                {
                    var buffer = new byte[1 << 20];
                    long total = src.Length, done = 0;
                    int read;
                    while ((read = await src.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                    {
                        await dst.WriteAsync(buffer, 0, read, ct);
                        done += read;
                        progress.Report(Tuple.Create(Stage.Prepare, 0.08 * done / total));
                    }
                }
            }
            Log("payload extracted");

            var before = FolderBytes(InstallDir);
            var desktopBefore = DesktopShortcutExists();
            var psi = new ProcessStartInfo(payload, "--silent") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = temp };
            using (var p = Process.Start(psi))
            {
                if (p == null) throw new InvalidOperationException("setup did not start");
                var expected = ExpectedBytes;
                var shown = 0.08;
                while (!p.HasExited)
                {
                    await Task.Delay(250, ct);
                    // Count what has been added since we started, so an update over an old copy is measured too.
                    var added = FolderBytes(InstallDir) - before;
                    var fraction = Math.Min(1.0, Math.Max(0, added) / (double)expected);
                    var target = 0.08 + 0.80 * fraction;
                    // Never go backwards, and creep while Velopack is busy with work we cannot measure.
                    shown = Math.Max(shown, Math.Min(0.87, Math.Max(target, shown + 0.002)));
                    progress.Report(Tuple.Create(Stage.Copy, shown));
                }
                Log("velopack exited " + p.ExitCode);
                if (p.ExitCode != 0 || !IsInstalled) throw new InvalidOperationException("Velopack setup failed with exit code " + p.ExitCode);
            }

            progress.Report(Tuple.Create(Stage.Shortcuts, 0.9));
            await Task.Delay(400, ct);
            // Velopack opens the app once it has installed it; the finish page decides that instead.
            await Task.Delay(1200, ct);
            CloseRunningApp();
            if (!options.DesktopShortcut && !desktopBefore) RemoveDesktopShortcut();

            progress.Report(Tuple.Create(Stage.Finish, 0.95));
            ApplySettings(options);
            SetStartWithWindows(options.StartWithWindows);
            TryDelete(temp);
            await Task.Delay(300, ct);
            progress.Report(Tuple.Create(Stage.Finish, 1.0));
            Log("done");
        }

        public static void Launch()
        {
            var exe = File.Exists(Launcher) ? Launcher : Path.Combine(InstallDir, "current", "Webyar.exe");
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) });
        }

        private static void CloseRunningApp()
        {
            foreach (var p in Process.GetProcessesByName("Webyar"))
            {
                try
                {
                    var path = p.MainModule?.FileName ?? "";
                    if (path.IndexOf(PackId, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    p.Kill();
                    p.WaitForExit(5000);
                    Log("closed running app " + p.Id);
                }
                catch (Exception e) { Log("close app: " + e.Message); }
                finally { p.Dispose(); }
            }
        }

        private static string Desktop => Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);

        private static bool DesktopShortcutExists() => File.Exists(Path.Combine(Desktop, "Webyar.lnk"));

        private static void RemoveDesktopShortcut()
        {
            try
            {
                var lnk = Path.Combine(Desktop, "Webyar.lnk");
                if (File.Exists(lnk)) File.Delete(lnk);
            }
            catch (Exception e) { Log("desktop shortcut: " + e.Message); }
        }

        /// <summary>The app's own settings file: its language and "start with Windows", so the app agrees with the choices made here.</summary>
        private static void ApplySettings(InstallOptions o)
        {
            try
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), PackId);
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, "settings.json");
                var startup = o.StartWithWindows ? "true" : "false";
                string json;
                if (File.Exists(file))
                {
                    json = File.ReadAllText(file);
                    json = Set(json, "StartWithWindows", startup);
                    json = Set(json, "Language", "\"" + o.Language + "\"");
                }
                else
                {
                    json = "{\n  \"Language\": \"" + o.Language + "\",\n  \"StartWithWindows\": " + startup + "\n}\n";
                }
                File.WriteAllText(file, json);
            }
            catch (Exception e) { Log("settings: " + e.Message); }
        }

        private static string Set(string json, string key, string value)
        {
            var re = new Regex("\"" + key + "\"\\s*:\\s*(\"[^\"]*\"|true|false|null|-?\\d+)");
            if (re.IsMatch(json)) return re.Replace(json, "\"" + key + "\": " + value, 1);
            var brace = json.IndexOf('{');
            return brace < 0 ? json : json.Insert(brace + 1, "\n  \"" + key + "\": " + value + ",");
        }

        /// <summary>The same Run entry the app writes from its settings (StartupRegistration).</summary>
        private static void SetStartWithWindows(bool on)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (on) key.SetValue("Webyar", "\"" + Launcher + "\" --hidden");
                    else key.DeleteValue("Webyar", false);
                }
            }
            catch (Exception e) { Log("startup: " + e.Message); }
        }

        private static long FolderBytes(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return 0;
                return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => { try { return f.Length; } catch { return 0L; } });
            }
            catch { return 0; }
        }

        private static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, true); } catch { }
        }

        public static void Log(string line)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine); } catch { }
        }
    }
}
