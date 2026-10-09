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
        ///   /removemachine        remove the old all-users copy (this installer asking Windows for rights)
        /// </summary>
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            if (Has(e, "removemachine"))
            {
                Installer.RemoveMachineInstall();
                Shutdown(0);
                return;
            }
            ApplyBrand();
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
                        // The app's updater closed it to get here: it comes back as it was.
                        if (launch && !uninstall)
                        {
                            try { Installer.LaunchWhatIsInstalled(); } catch (Exception e2) { Installer.Log("relaunch: " + e2.Message); }
                        }
                    }
                    Dispatcher.Invoke(() => Shutdown(code));
                });
                return;
            }

            var mode = uninstall ? Mode.Uninstall : Installer.IsInstalled ? Mode.Maintain : Mode.Install;
            MainWindow = new MainWindow(mode);
            MainWindow.Show();
        }

        /// <summary>
        /// Each brand kit's colours: the panel on the left behind the app icon, and the accent of the
        /// buttons and switches. WebYar: the icon's turquoise, deepened so white text stays readable on it.
        /// RESPOK: Ink, with Signal Deep for actions.
        /// </summary>
        private void ApplyBrand()
        {
#if BRAND_RESPOK
            Panel("#2B2849", "#1F1C3A", "#16142B");
            Set("BrandPanelTaglineBrush", "#D4D2E3");
            Set("BrandPanelTextBrush", "#ECEBF4");
            Set("BrandPanelFooterBrush", "#A9A7BC");
            Set("BrandBrush", "#D3361A");
            Set("BrandHoverBrush", "#BC2F16");
            Set("BrandPressedBrush", "#A52912");
            Set("BrandSoftBrush", "#1FD3361A");
#else
            Panel("#13B89C", "#0B8A78", "#075C51");
            Set("BrandPanelTaglineBrush", "#DDF7F1");
            Set("BrandPanelTextBrush", "#F0FCF9");
            Set("BrandPanelFooterBrush", "#B5E6DC");
            Set("BrandBrush", "#0B7D6C");
            Set("BrandHoverBrush", "#0A6E5F");
            Set("BrandPressedBrush", "#085E51");
            Set("BrandSoftBrush", "#1F0B7D6C");
#endif
        }

        private void Panel(string top, string middle, string bottom)
        {
            var brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 1) };
            brush.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(top), 0));
            brush.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(middle), 0.55));
            brush.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(bottom), 1));
            Resources["BrandPanelBrush"] = brush;
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
#if BRAND_RESPOK
            Set("BrandBrush", "#FF5A3C");
            Set("BrandHoverBrush", "#FF7559");
            Set("BrandPressedBrush", "#E84E31");
            Set("BrandSoftBrush", "#29FF5A3C");
#else
            Set("BrandBrush", "#16C7A8");
            Set("BrandHoverBrush", "#2ED3B7");
            Set("BrandPressedBrush", "#12B396");
            Set("BrandSoftBrush", "#2916C7A8");
#endif
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
