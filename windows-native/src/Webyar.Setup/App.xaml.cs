using System;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace Webyar.Setup
{
    public partial class App : Application
    {
        public static bool IsDark { get; private set; }

        /// <summary>What the window opens on.</summary>
        public enum Mode { Install, Maintain, Uninstall }

        private static bool Has(StartupEventArgs e, string flag) =>
            e.Args.Any(a => string.Equals(a.TrimStart('/', '-'), flag, StringComparison.OrdinalIgnoreCase));

        /// <summary>
        ///   (no arguments)        install, or the maintenance page when Webyar is already installed
        ///   /uninstall            the uninstall page (Settings → Apps → Uninstall runs this)
        ///   /uninstall /silent    remove without a window
        ///   /silent [/launch]     install or update without a window (the app's own updater)
        /// </summary>
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ApplyTheme();
            // The copy in the install folder only ever uninstalls, however it is started.
            var uninstall = Has(e, "uninstall") || Installer.IsUninstallerCopy;
            var silent = Has(e, "silent");
            if (Has(e, "fromtemp")) Exit += (_, __) => Installer.DeleteSelfLater();

            if (uninstall && Installer.RelaunchFromTempIfNeeded(e.Args))
            {
                Shutdown();
                return;
            }
            if (silent)
            {
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                var launch = Has(e, "launch");
                var progress = new Progress<Tuple<Stage, double>>(_ => { });
                System.Threading.Tasks.Task.Run(async () =>
                {
                    var code = 0;
                    try
                    {
                        if (uninstall) await Installer.UninstallAsync(false, progress, CancellationToken.None);
                        else
                        {
                            await Installer.RunAsync(Installer.CurrentOptions(), progress, CancellationToken.None);
                            if (launch) Installer.Launch();
                        }
                    }
                    catch (Exception ex)
                    {
                        Installer.Log("silent failed: " + ex);
                        code = 1;
                    }
                    Dispatcher.Invoke(() => Shutdown(code));
                });
                return;
            }

            var mode = uninstall ? Mode.Uninstall : Installer.IsInstalled ? Mode.Maintain : Mode.Install;
            MainWindow = new MainWindow(mode);
            MainWindow.Show();
        }

        /// <summary>Follows the Windows app theme, as the app does.</summary>
        private void ApplyTheme()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    IsDark = key?.GetValue("AppsUseLightTheme") is int v && v == 0;
            }
            catch { IsDark = false; }
            if (!IsDark) return;
            Set("SurfaceBrush", "#1F2128");
            Set("Surface2Brush", "#262932");
            Set("LineBrush", "#353945");
            Set("TextBrush", "#F2F4F8");
            Set("Text2Brush", "#B2B8C6");
            Set("Text3Brush", "#7C8394");
            Set("BrandBrush", "#5A94FF");
            Set("BrandHoverBrush", "#6FA2FF");
            Set("BrandPressedBrush", "#4A84EF");
            Set("BrandSoftBrush", "#295A94FF");
            Set("HoverBrush", "#12FFFFFF");
            Set("PressedBrush", "#1FFFFFFF");
            Set("SuccessBrush", "#4ADE80");
            Set("SuccessSoftBrush", "#294ADE80");
            Set("DangerBrush", "#F87171");
            Set("DangerSoftBrush", "#29F87171");
            Set("SwitchOffBrush", "#7C8394");
        }

        private void Set(string key, string hex) =>
            Resources[key] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
    }
}
