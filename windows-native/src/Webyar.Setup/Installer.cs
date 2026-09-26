using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Webyar.Setup
{
    public enum Stage { Prepare, Copy, Shortcuts, Finish, Remove }

    public sealed class InstallOptions
    {
        public bool DesktopShortcut = true;
        public bool StartWithWindows = true;
        public bool LaunchWhenDone = true;
        public string Language = "fa";
    }

    /// <summary>
    /// Installs Webyar for every user of the machine, the way Windows programs
    /// are expected to be installed:
    ///   C:\Program Files\Webyar             the app, plus "Uninstall Webyar.exe"
    ///   Start menu → Webyar                 for all users
    ///   Desktop → Webyar                    for all users (optional)
    ///   Settings → Apps / Control Panel     "Webyar", with version, size and Uninstall
    /// Per-user things stay per user: the app's settings and data in %APPDATA% and
    /// %LOCALAPPDATA%, and "start with Windows" in the user's Run key.
    ///
    /// The payload is the published app folder as a zip. An update or repair
    /// unpacks it beside the current copy and swaps the folders, so a failure
    /// half-way leaves the previous version in place.
    /// </summary>
    public static class Installer
    {
        public const string ProductName = "Webyar";
        public const string Publisher = "Webyar";
        public const string ExeName = "Webyar.exe";
        public const string UninstallerName = "Uninstall Webyar.exe";
        private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Webyar";
        /// <summary>The per-user Velopack install older versions used.</summary>
        private const string LegacyPackId = "WebyarWindows";

        public static string InstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), ProductName);
        public static string AppExe => Path.Combine(InstallDir, ExeName);
        public static string UninstallerPath => Path.Combine(InstallDir, UninstallerName);

        private static string StartMenuShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), ProductName + ".lnk");
        private static string DesktopShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), ProductName + ".lnk");

        public static bool IsInstalled => File.Exists(AppExe);

        public static string InstalledVersion()
        {
            try
            {
                using (var key = OpenMachine().OpenSubKey(UninstallKey))
                {
                    if (key?.GetValue("DisplayVersion") is string v && v.Length > 0) return v;
                }
                var dll = Path.Combine(InstallDir, "Webyar.dll");
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

        public static bool HasPayload => Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.zip") != null;

        /// <summary>True for the copy that lives in the install folder as the uninstaller.</summary>
        public static bool IsUninstallerCopy =>
            string.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location), UninstallerName, StringComparison.OrdinalIgnoreCase);

        public static string LogPath => Path.Combine(Path.GetTempPath(), "Webyar-Setup.log");

        // ── Install / update / repair ────────────────────────────────────────

        public static async Task RunAsync(InstallOptions options, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            File.WriteAllText(LogPath, $"Webyar setup {Version} {DateTime.Now:u}{Environment.NewLine}");
            progress.Report(Tuple.Create(Stage.Prepare, 0.0));

            CloseRunningApp();
            RemoveLegacyInstall();
            progress.Report(Tuple.Create(Stage.Prepare, 0.06));

            var parent = Path.GetDirectoryName(InstallDir);
            var staging = InstallDir + ".new";
            var previous = InstallDir + ".old";
            TryDelete(staging);
            TryDelete(previous);
            Directory.CreateDirectory(staging);

            using (var zipStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (zipStream == null) throw new InvalidOperationException("payload missing");
                using (var zip = new ZipArchive(zipStream, ZipArchiveMode.Read))
                {
                    var entries = zip.Entries.Where(e => e.Name.Length > 0).ToList();
                    long total = Math.Max(1, entries.Sum(e => e.Length)), done = 0;
                    var buffer = new byte[1 << 20];
                    foreach (var entry in zip.Entries)
                    {
                        ct.ThrowIfCancellationRequested();
                        var target = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                        if (!target.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                        if (entry.Name.Length == 0)
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var src = entry.Open())
                        using (var dst = File.Create(target))
                        {
                            int read;
                            while ((read = await src.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                            {
                                await dst.WriteAsync(buffer, 0, read, ct);
                                done += read;
                            }
                        }
                        progress.Report(Tuple.Create(Stage.Copy, 0.06 + 0.78 * done / total));
                    }
                }
            }
            Log("payload unpacked");

            // The uninstaller: this installer's small twin, without the app inside.
            using (var un = Assembly.GetExecutingAssembly().GetManifestResourceStream("uninstaller.exe"))
            {
                if (un != null)
                    using (var dst = File.Create(Path.Combine(staging, UninstallerName))) un.CopyTo(dst);
                else
                    File.Copy(Assembly.GetExecutingAssembly().Location, Path.Combine(staging, UninstallerName), true);
            }

            // Swap: the old copy steps aside, the new one takes its name.
            Directory.CreateDirectory(parent);
            if (Directory.Exists(InstallDir)) MoveWithRetry(InstallDir, previous);
            MoveWithRetry(staging, InstallDir);
            TryDelete(previous);
            Log("installed to " + InstallDir);
            progress.Report(Tuple.Create(Stage.Shortcuts, 0.88));

            CreateShortcut(StartMenuShortcut);
            if (options.DesktopShortcut) CreateShortcut(DesktopShortcut);
            else TryDeleteFile(DesktopShortcut);
            RemoveUserShortcuts();
            progress.Report(Tuple.Create(Stage.Finish, 0.94));

            Register();
            ApplySettings(options);
            SetStartWithWindows(options.StartWithWindows);
            await Task.Delay(250, ct);
            progress.Report(Tuple.Create(Stage.Finish, 1.0));
            Log("done");
        }

        public static void Launch()
        {
            // Started from an elevated installer, the app would run elevated too; Explorer starts it as the user.
            var psi = new ProcessStartInfo("explorer.exe", "\"" + AppExe + "\"") { UseShellExecute = true };
            try { Process.Start(psi); }
            catch { Process.Start(new ProcessStartInfo(AppExe) { UseShellExecute = true, WorkingDirectory = InstallDir }); }
        }

        // ── Uninstall ────────────────────────────────────────────────────────

        public static async Task UninstallAsync(bool removeUserData, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            File.WriteAllText(LogPath, $"Webyar uninstall {Version} {DateTime.Now:u}{Environment.NewLine}");
            progress.Report(Tuple.Create(Stage.Remove, 0.05));
            CloseRunningApp();
            await Task.Delay(300, ct);

            progress.Report(Tuple.Create(Stage.Remove, 0.25));
            TryDeleteFile(StartMenuShortcut);
            TryDeleteFile(DesktopShortcut);
            RemoveUserShortcuts();
            SetStartWithWindows(false);

            progress.Report(Tuple.Create(Stage.Remove, 0.45));
            for (var i = 0; i < 10 && Directory.Exists(InstallDir); i++)
            {
                TryDelete(InstallDir);
                if (Directory.Exists(InstallDir)) await Task.Delay(500, ct);
            }
            if (Directory.Exists(InstallDir)) ScheduleDelete(InstallDir);

            progress.Report(Tuple.Create(Stage.Remove, 0.75));
            try { OpenMachine().DeleteSubKeyTree(UninstallKey, false); } catch (Exception e) { Log("registry: " + e.Message); }
            RemoveLegacyInstall();

            if (removeUserData)
            {
                TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), LegacyPackId));
                TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), LegacyPackId));
            }
            await Task.Delay(250, ct);
            progress.Report(Tuple.Create(Stage.Remove, 1.0));
            Log("uninstalled");
        }

        /// <summary>
        /// Windows cannot delete a running exe, so the uninstaller in the install
        /// folder reruns itself from %TEMP% and lets that copy do the work.
        /// </summary>
        public static bool RelaunchFromTempIfNeeded(string[] args)
        {
            var self = Assembly.GetExecutingAssembly().Location;
            if (!self.StartsWith(InstallDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return false;
            var temp = Path.Combine(Path.GetTempPath(), "Webyar-Uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            File.Copy(self, temp, true);
            var rest = string.Join(" ", args.Select(a => a.Contains(' ') ? "\"" + a + "\"" : a));
            if (!args.Any(a => a.TrimStart('/', '-').Equals("uninstall", StringComparison.OrdinalIgnoreCase))) rest = "/uninstall " + rest;
            Process.Start(new ProcessStartInfo(temp, rest.Trim() + " /fromtemp") { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
            return true;
        }

        /// <summary>The temporary uninstaller removes itself a moment after it closes.</summary>
        public static void DeleteSelfLater()
        {
            try
            {
                var self = Assembly.GetExecutingAssembly().Location;
                if (!self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
            }
            catch { }
        }

        // ── Registration ─────────────────────────────────────────────────────

        private static RegistryKey OpenMachine() => RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);

        /// <summary>The entry Settings → Apps and Control Panel → Programs and Features list.</summary>
        private static void Register()
        {
            using (var key = OpenMachine().CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", ProductName);
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", Publisher);
                key.SetValue("DisplayIcon", "\"" + AppExe + "\",0");
                key.SetValue("InstallLocation", InstallDir);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("UninstallString", "\"" + UninstallerPath + "\" /uninstall");
                key.SetValue("QuietUninstallString", "\"" + UninstallerPath + "\" /uninstall /silent");
                key.SetValue("URLInfoAbout", "https://webyar.ai");
                key.SetValue("HelpLink", "https://webyar.ai");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(FolderBytes(InstallDir) / 1024), RegistryValueKind.DWord);
                var parts = Version.Split('.', '-');
                if (parts.Length > 0 && int.TryParse(parts[0], out var major)) key.SetValue("VersionMajor", major, RegistryValueKind.DWord);
                if (parts.Length > 1 && int.TryParse(parts[1], out var minor)) key.SetValue("VersionMinor", minor, RegistryValueKind.DWord);
            }
            Log("registered in Apps & features");
        }

        private static void CreateShortcut(string path)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic link = shell.CreateShortcut(path);
                link.TargetPath = AppExe;
                link.WorkingDirectory = InstallDir;
                link.IconLocation = AppExe + ",0";
                link.Description = ProductName;
                link.Save();
                Log("shortcut " + path);
            }
            catch (Exception e) { Log("shortcut " + path + ": " + e.Message); }
        }

        /// <summary>Shortcuts the old per-user install left, which would now point nowhere.</summary>
        private static void RemoveUserShortcuts()
        {
            TryDeleteFile(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ProductName + ".lnk"));
            TryDeleteFile(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ProductName + ".lnk"));
        }

        /// <summary>
        /// Versions up to 2.1 installed per user through Velopack in
        /// %LOCALAPPDATA%\WebyarWindows. Its files and Apps entry go; the app's
        /// settings and sign-in in %APPDATA% stay, so nothing has to be set up again.
        /// </summary>
        private static void RemoveLegacyInstall()
        {
            var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), LegacyPackId);
            try
            {
                foreach (var name in new[] { "current", "packages" }) TryDelete(Path.Combine(local, name));
                foreach (var name in new[] { "Update.exe", ExeName, "sq.version", ".betaId" }) TryDeleteFile(Path.Combine(local, name));
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                    key?.DeleteSubKeyTree(LegacyPackId, false);
            }
            catch (Exception e) { Log("legacy: " + e.Message); }
        }

        private static void CloseRunningApp()
        {
            foreach (var p in Process.GetProcessesByName("Webyar"))
            {
                try
                {
                    p.Kill();
                    p.WaitForExit(5000);
                    Log("closed running app " + p.Id);
                }
                catch (Exception e) { Log("close app: " + e.Message); }
                finally { p.Dispose(); }
            }
        }

        /// <summary>The app's own settings file: its language and "start with Windows", so the app agrees with the choices made here.</summary>
        private static void ApplySettings(InstallOptions o)
        {
            try
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), LegacyPackId);
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

        /// <summary>The settings the app already has, so a silent update keeps the operator's choices.</summary>
        public static InstallOptions CurrentOptions()
        {
            var o = new InstallOptions { DesktopShortcut = File.Exists(DesktopShortcut) || !IsInstalled, LaunchWhenDone = false };
            try
            {
                var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), LegacyPackId, "settings.json");
                if (File.Exists(file))
                {
                    var json = File.ReadAllText(file);
                    var lang = Regex.Match(json, "\"Language\"\\s*:\\s*\"(fa|en|tr)\"");
                    if (lang.Success) o.Language = lang.Groups[1].Value;
                    o.StartWithWindows = !Regex.IsMatch(json, "\"StartWithWindows\"\\s*:\\s*false");
                }
            }
            catch { }
            return o;
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
                    if (on) key.SetValue("Webyar", "\"" + AppExe + "\" --hidden");
                    else key.DeleteValue("Webyar", false);
                }
            }
            catch (Exception e) { Log("startup: " + e.Message); }
        }

        // ── Files ────────────────────────────────────────────────────────────

        private static void MoveWithRetry(string from, string to)
        {
            for (var i = 0; ; i++)
            {
                try
                {
                    Directory.Move(from, to);
                    return;
                }
                catch (IOException) when (i < 20)
                {
                    // A process that just exited can hold its files for a moment.
                    CloseRunningApp();
                    Thread.Sleep(500);
                }
            }
        }

        /// <summary>Whatever could not be removed now goes at the next restart.</summary>
        private static void ScheduleDelete(string dir)
        {
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) MoveFileEx(f, null, 4);
                foreach (var d in Directory.EnumerateDirectories(dir, "*", SearchOption.AllDirectories).OrderByDescending(x => x.Length)) MoveFileEx(d, null, 4);
                MoveFileEx(dir, null, 4);
                Log("scheduled removal at restart: " + dir);
            }
            catch (Exception e) { Log("schedule delete: " + e.Message); }
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileEx(string existing, string replacement, int flags);

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
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (Exception e) { Log("delete " + dir + ": " + e.Message); }
        }

        private static void TryDeleteFile(string file)
        {
            try { if (File.Exists(file)) File.Delete(file); } catch (Exception e) { Log("delete " + file + ": " + e.Message); }
        }

        public static void Log(string line)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine); } catch { }
        }
    }
}
