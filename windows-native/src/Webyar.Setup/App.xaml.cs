using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace Webyar.Setup
{
    public partial class App : Application
    {
        public static bool IsDark { get; private set; }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ApplyTheme();
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
