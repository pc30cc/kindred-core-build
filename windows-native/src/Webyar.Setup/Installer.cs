using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Security.Principal;
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
    /// Installs Webyar for the person signed in, as Slack, Discord and VS Code's
    /// user setup do — no administrator rights, and updates that apply in place:
    ///   %LOCALAPPDATA%\Programs\Webyar\current   the app, which updates itself (Velopack)
    ///   Start menu → Webyar, Desktop → Webyar      the user's own shortcuts
    ///   Settings → Apps                            "Webyar", with Uninstall
    /// The app's settings and sign-in stay in %APPDATA%\WebyarWindows and its
    /// cache in %LOCALAPPDATA%\WebyarWindows, apart from the program, untouched.
    ///
    /// The payload is Velopack's own setup for this version, run silently. The
    /// app's updater also runs this installer when it is still installed the old
    /// way, for all users under Program Files (versions 2.2 to 2.5.1): that copy
    /// is then removed, asking Windows once for permission.
    /// </summary>
    public static class Installer
    {
        public const string ProductName = "Webyar";
        public const string ExeName = "Webyar.exe";
        public const string UninstallerName = "Uninstall Webyar.exe";
        /// <summary>Velopack's id for the app: its folder under %LOCALAPPDATA% and its Apps entry.</summary>
        private const string PackId = "WebyarWindows";
        private const string PayloadName = "app-setup.exe";
        private const string MachineUninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Webyar";

        /// <summary>
        /// Where the app lives: Velopack's install root for this user, where Windows keeps
        /// per-user programs. Not %LOCALAPPDATA%\WebyarWindows, Velopack's default: that
        /// holds the app's cache, and setup would first try to move it aside.
        /// </summary>
        public static string InstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", ProductName);

        /// <summary>The app's cache and WebView2 profile (see the app's AppPaths); disposable.</summary>
        private static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PackId);
        public static string AppExe => Path.Combine(InstallDir, "current", ExeName);

        /// <summary>The all-users install of versions 2.2 to 2.5.1, replaced by this one.</summary>
        public static string MachineDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), ProductName);
        private static string MachineExe => Path.Combine(MachineDir, ExeName);
        private static string MachineStartMenuShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), ProductName + ".lnk");
        private static string MachineDesktopShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), ProductName + ".lnk");
        private static string UserDesktopShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ProductName + ".lnk");
        private static string UserStartMenuShortcut =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ProductName + ".lnk");

        public static bool IsInstalled => File.Exists(AppExe) || File.Exists(MachineExe);

        private static bool HasMachineInstall => Directory.Exists(MachineDir) || File.Exists(MachineStartMenuShortcut) || File.Exists(MachineDesktopShortcut);

        public static bool IsElevated
        {
            get
            {
                try
                {
                    using (var id = WindowsIdentity.GetCurrent())
                        return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
                }
                catch { return false; }
            }
        }

        public static string InstalledVersion()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + PackId))
                {
                    if (key?.GetValue("DisplayVersion") is string v && v.Length > 0) return v;
                }
                foreach (var dll in new[] { Path.Combine(InstallDir, "current", "Webyar.dll"), Path.Combine(MachineDir, "Webyar.dll") })
                {
                    if (!File.Exists(dll)) continue;
                    var version = FileVersionInfo.GetVersionInfo(dll).ProductVersion ?? "";
                    var plus = version.IndexOf('+');
                    return plus > 0 ? version.Substring(0, plus) : version;
                }
                return null;
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

        public static bool HasPayload => Assembly.GetExecutingAssembly().GetManifestResourceInfo(PayloadName) != null;

        /// <summary>True for a copy that lives in the old install folder as its uninstaller.</summary>
        public static bool IsUninstallerCopy =>
            string.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location), UninstallerName, StringComparison.OrdinalIgnoreCase);

        public static string LogPath => Path.Combine(Path.GetTempPath(), "Webyar-Setup.log");

        // ── Install / update / repair ────────────────────────────────────────

        public static async Task RunAsync(InstallOptions options, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            File.WriteAllText(LogPath, $"Webyar setup {Version} {DateTime.Now:u}{(IsElevated ? " elevated" : "")}{Environment.NewLine}");
            progress.Report(Tuple.Create(Stage.Prepare, 0.0));

            CloseRunningApp();
            progress.Report(Tuple.Create(Stage.Prepare, 0.08));

            // Velopack's setup, as its own file: it installs for this user and registers the app.
            var setup = Path.Combine(Path.GetTempPath(), "Webyar-AppSetup-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            using (var src = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
            {
                if (src == null) throw new InvalidOperationException("payload missing");
                using (var dst = File.Create(setup)) await src.CopyToAsync(dst, 1 << 20, ct);
            }
            progress.Report(Tuple.Create(Stage.Copy, 0.15));

            try
            {
                var code = RunAppSetup(setup, progress, ct);
                if (code != 0)
                {
                    // Something still had the folder open: close everything again and try once more.
                    Log("Velopack setup exited with code " + code + "; retrying (its log: %LOCALAPPDATA%\\velopack\\velopack.log)");
                    CloseRunningApp();
                    Thread.Sleep(1000);
                    code = RunAppSetup(setup, progress, ct);
                }
                if (code != 0) throw new InvalidOperationException("Velopack setup exited with code " + code);
            }
            finally
            {
                TryDeleteFile(setup);
            }
            if (!File.Exists(AppExe)) throw new FileNotFoundException("the app is not where setup puts it", AppExe);
            Log("installed to " + InstallDir);
            // Velopack may start the app when it is done; it is started again as the operator chose.
            await Task.Delay(1500, ct);
            CloseRunningApp();
            progress.Report(Tuple.Create(Stage.Shortcuts, 0.86));

            if (!options.DesktopShortcut) TryDeleteFile(UserDesktopShortcut);
            progress.Report(Tuple.Create(Stage.Finish, 0.9));

            RemoveMachineInstall();
            ApplySettings(options);
            SetStartWithWindows(options.StartWithWindows);
            await Task.Delay(250, ct);
            progress.Report(Tuple.Create(Stage.Finish, 1.0));
            Log("done");
        }

        /// <summary>Velopack's setup, silent; its exit code. No progress comes from it: the bar moves on its own until it is done.</summary>
        private static int RunAppSetup(string setup, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            using (var p = Process.Start(new ProcessStartInfo(setup, "--silent --installto \"" + InstallDir + "\"") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetTempPath() }))
            {
                var share = 0.15;
                var until = DateTime.UtcNow.AddMinutes(10);
                while (!p.WaitForExit(250))
                {
                    ct.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow > until) throw new TimeoutException("setup did not finish in 10 minutes");
                    share = Math.Min(0.8, share + 0.006);
                    progress.Report(Tuple.Create(Stage.Copy, share));
                }
                return p.ExitCode;
            }
        }

        /// <summary>After a failed update: the app as it was, so the operator is never left without it.</summary>
        public static void LaunchWhatIsInstalled()
        {
            var exe = File.Exists(AppExe) ? AppExe : File.Exists(MachineExe) ? MachineExe : null;
            if (exe == null) return;
            if (IsElevated) Process.Start(new ProcessStartInfo("explorer.exe", "\"" + exe + "\"") { UseShellExecute = true });
            else Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) });
            Log("started " + exe);
        }

        /// <summary>Starts the app as the signed-in user, never elevated (an elevated installer starts it through Explorer).</summary>
        public static void Launch()
        {
            var dir = Path.GetDirectoryName(AppExe);
            if (IsElevated)
            {
                try
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + AppExe + "\"") { UseShellExecute = true });
                    return;
                }
                catch (Exception e) { Log("launch via explorer: " + e.Message); }
            }
            Process.Start(new ProcessStartInfo(AppExe) { UseShellExecute = true, WorkingDirectory = dir });
        }

        // ── The old all-users install ────────────────────────────────────────

        /// <summary>
        /// Removes the Program Files copy, its all-users shortcuts and its Apps entry.
        /// Without administrator rights it asks Windows for them, once; declined, the old copy stays.
        /// </summary>
        public static void RemoveMachineInstall()
        {
            if (!HasMachineInstall) return;
            if (!IsElevated)
            {
                try
                {
                    using (var p = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "/removemachine") { UseShellExecute = true, Verb = "runas" }))
                        p?.WaitForExit(120000);
                    Log("old Program Files copy removed (elevated)");
                }
                catch (Win32Exception e) { Log("remove old copy declined: " + e.Message); }
                return;
            }
            CloseRunningApp();
            TryDeleteFile(MachineStartMenuShortcut);
            TryDeleteFile(MachineDesktopShortcut);
            try
            {
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                    hklm.DeleteSubKeyTree(MachineUninstallKey, false);
            }
            catch (Exception e) { Log("registry: " + e.Message); }
            foreach (var dir in new[] { MachineDir, MachineDir + ".old", MachineDir + ".new" })
            {
                for (var i = 0; i < 10 && Directory.Exists(dir); i++)
                {
                    TryDelete(dir);
                    if (Directory.Exists(dir)) Thread.Sleep(500);
                }
                if (Directory.Exists(dir)) ScheduleDelete(dir);
            }
            Log("old Program Files copy removed");
        }

        // ── Uninstall ────────────────────────────────────────────────────────

        public static async Task UninstallAsync(bool removeUserData, IProgress<Tuple<Stage, double>> progress, CancellationToken ct)
        {
            File.WriteAllText(LogPath, $"Webyar uninstall {Version} {DateTime.Now:u}{Environment.NewLine}");
            progress.Report(Tuple.Create(Stage.Remove, 0.05));
            CloseRunningApp();
            await Task.Delay(300, ct);

            progress.Report(Tuple.Create(Stage.Remove, 0.25));
            TryDeleteFile(UserDesktopShortcut);
            TryDeleteFile(UserStartMenuShortcut);
            SetStartWithWindows(false);

            progress.Report(Tuple.Create(Stage.Remove, 0.45));
            RemoveUserInstall();
            progress.Report(Tuple.Create(Stage.Remove, 0.7));
            RemoveMachineInstall();

            if (removeUserData)
            {
                TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), PackId));
                TryDelete(DataDir);
            }
            TryDelete(InstallDir);
            await Task.Delay(250, ct);
            progress.Report(Tuple.Create(Stage.Remove, 1.0));
            Log("uninstalled");
        }

        /// <summary>
        /// Windows cannot delete a running exe, so the uninstaller in the old install
        /// folder reruns itself from %TEMP% and lets that copy do the work.
        /// </summary>
        public static bool RelaunchFromTempIfNeeded(string[] args)
        {
            var self = Assembly.GetExecutingAssembly().Location;
            if (!self.StartsWith(MachineDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return false;
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

        /// <summary>
        /// The app's files and Apps entry for this user (and those of the per-user install of
        /// versions up to 2.1, in %LOCALAPPDATA%\WebyarWindows); its settings and sign-in in %APPDATA% stay.
        /// </summary>
        private static void RemoveUserInstall()
        {
            try
            {
                foreach (var root in new[] { InstallDir, DataDir })
                {
                    foreach (var name in new[] { "current", "packages" }) TryDelete(Path.Combine(root, name));
                    foreach (var name in new[] { "Update.exe", ExeName, "sq.version", ".betaId" }) TryDeleteFile(Path.Combine(root, name));
                }
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                    key?.DeleteSubKeyTree(PackId, false);
            }
            catch (Exception e) { Log("user install: " + e.Message); }
        }

        /// <summary>
        /// Closes the app and the WebView2 processes it started (calls, maps, email):
        /// they outlive it for a few seconds and keep its folder in use.
        /// </summary>
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
            // They exit on their own a moment after the app; any still there are closed, and waited for.
            for (var round = 0; round < 20 && CloseWebViews() > 0; round++) Thread.Sleep(500);
        }

        /// <summary>Closes the WebView2 processes running on Webyar's profile; how many there were.</summary>
        private static int CloseWebViews()
        {
            var found = 0;
            try
            {
                using (var search = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedgewebview2.exe'"))
                {
                    foreach (var o in search.Get().Cast<ManagementObject>())
                    {
                        using (o)
                        {
                            var cmd = o["CommandLine"] as string;
                            if (cmd == null || cmd.IndexOf(PackId + @"\WebView2", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            found++;
                            try
                            {
                                using (var p = Process.GetProcessById(Convert.ToInt32(o["ProcessId"])))
                                {
                                    p.Kill();
                                    p.WaitForExit(3000);
                                }
                            }
                            catch { }
                        }
                    }
                }
            }
            catch (Exception e) { Log("close webview: " + e.Message); }
            if (found > 0) Log("closed " + found + " WebView2 processes");
            return found;
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

        /// <summary>The settings the app already has, so a silent update keeps the operator's choices.</summary>
        public static InstallOptions CurrentOptions()
        {
            var o = new InstallOptions
            {
                DesktopShortcut = File.Exists(UserDesktopShortcut) || File.Exists(MachineDesktopShortcut) || !IsInstalled,
                LaunchWhenDone = false,
            };
            try
            {
                var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), PackId, "settings.json");
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
