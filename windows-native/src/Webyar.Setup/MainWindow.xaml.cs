using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;

namespace Webyar.Setup
{
    public partial class MainWindow : Window
    {
        private Strings _s = Strings.For(Strings.SystemDefault());
        private bool _busy;
        private bool _installed;
        private readonly Stage[] _stages = { Stage.Prepare, Stage.Copy, Stage.Shortcuts, Stage.Finish };
        private readonly string[] _stageKeys = { "stepPrepare", "stepCopy", "stepShortcuts", "stepFinish" };
        private Stage _stage = Stage.Prepare;

        public MainWindow()
        {
            InitializeComponent();
            _installed = Installer.IsInstalled;
            InstallToPath.Text = Installer.InstallDir;
            switch (_s.Code)
            {
                case "en": LangEn.IsChecked = true; break;
                case "tr": LangTr.IsChecked = true; break;
                default: LangFa.IsChecked = true; break;
            }
            Render();
            Loaded += (_, __) => Intro();
        }

        private static FontFamily FontFor(string code) => code == "fa"
            ? new FontFamily(new Uri("pack://application:,,,/"), "./Fonts/#IRANSans, ./Fonts/#Vazirmatn, Segoe UI Variable Text, Segoe UI")
            : new FontFamily("Segoe UI Variable Text, Segoe UI");

        private void Render()
        {
            var s = _s;
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
            FontFamily = FontFor(s.Code);
            Title = s["appName"];
            BrandName.Text = s["appName"];
            BrandTagline.Text = s["tagline"];
            Feature1.Text = s["feature1"];
            Feature2.Text = s["feature2"];
            Feature3.Text = s["feature3"];
            VersionText.Text = s.Digits(string.Format(s["version"], Installer.Version));
            FooterText.Text = s["footer"];
            MinimizeButton.ToolTip = s["minimize"];
            CloseButton.ToolTip = s["close"];

            WelcomeTitle.Text = _installed ? s["updateTitle"] : s["welcomeTitle"];
            WelcomeBody.Text = _installed ? s["updateBody"] : s["welcomeBody"];
            OptDesktopTitle.Text = s["optDesktop"];
            OptDesktopHint.Text = s["optDesktopHint"];
            OptStartupTitle.Text = s["optStartup"];
            OptStartupHint.Text = s["optStartupHint"];
            OptLaunchTitle.Text = s["optLaunch"];
            OptLaunchHint.Text = s["optLaunchHint"];
            InstallToLabel.Text = s["installTo"] + ":";
            InstallText.Text = _installed ? s["update"] : s["install"];
            CancelButton.Content = s["cancel"];

            ProgressTitle.Text = s["installingTitle"];
            ProgressBody.Text = s["installingBody"];
            RenderSteps();

            DoneTitle.Text = s["doneTitle"];
            DoneBody.Text = s["doneBody"];
            OpenText.Text = s["open"];
            FinishCloseButton.Content = s["close"];

            ErrorTitle.Text = s["errorTitle"];
            RetryText.Text = s["retry"];
            ErrorCloseButton.Content = s["close"];
        }

        // ── Steps list: pending, running (a spinning arc), done (a check) ──

        private void RenderSteps()
        {
            StepList.Children.Clear();
            var current = Array.IndexOf(_stages, _stage);
            for (var i = 0; i < _stages.Length; i++)
            {
                var state = i < current ? 2 : i == current ? 1 : 0;
                StepList.Children.Add(StepRow(_s[_stageKeys[i]], state));
            }
            StageText.Text = _s[_stageKeys[Math.Max(0, current)]];
        }

        private FrameworkElement StepRow(string text, int state)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 14) };
            FrameworkElement mark;
            if (state == 2)
            {
                var g = new Grid { Width = 22, Height = 22 };
                g.Children.Add(new Ellipse { Fill = (Brush)FindResource("BrandBrush") });
                g.Children.Add(new TextBlock { Text = "", FontFamily = (FontFamily)FindResource("IconFont"), FontSize = 11, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
                mark = g;
            }
            else if (state == 1)
            {
                var arc = new Ellipse
                {
                    Width = 22,
                    Height = 22,
                    Stroke = (Brush)FindResource("BrandBrush"),
                    StrokeThickness = 2.5,
                    StrokeDashArray = new DoubleCollection { 5.5, 3.2 },
                    StrokeDashCap = PenLineCap.Round,
                    RenderTransformOrigin = new Point(0.5, 0.5),
                };
                var rotate = new RotateTransform();
                arc.RenderTransform = rotate;
                rotate.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(1.2)) { RepeatBehavior = RepeatBehavior.Forever });
                mark = arc;
            }
            else
            {
                mark = new Ellipse { Width = 22, Height = 22, Stroke = (Brush)FindResource("LineBrush"), StrokeThickness = 2 };
            }
            row.Children.Add(mark);
            row.Children.Add(new TextBlock
            {
                Text = text,
                Margin = new Thickness(12, 0, 0, 0),
                FontSize = 13.5,
                FontWeight = state == 1 ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = (Brush)FindResource(state == 0 ? "Text3Brush" : "TextBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            });
            return row;
        }

        // ── Pages ──

        private void Show(FrameworkElement page)
        {
            foreach (var p in new FrameworkElement[] { WelcomePage, ProgressPage, DonePage, ErrorPage })
                p.Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;
            var t = new TranslateTransform(0, 14);
            page.RenderTransform = t;
            page.Opacity = 0;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            page.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)) { EasingFunction = ease });
            t.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(14, 0, TimeSpan.FromMilliseconds(320)) { EasingFunction = ease });
        }

        private void Intro()
        {
            var ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.35 };
            LogoScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.7, 1, TimeSpan.FromMilliseconds(520)) { EasingFunction = ease });
            LogoScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.7, 1, TimeSpan.FromMilliseconds(520)) { EasingFunction = ease });
            Glow.BeginAnimation(OpacityProperty, new DoubleAnimation(0.35, 0.7, TimeSpan.FromSeconds(2.6)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
            Show(WelcomePage);
        }

        private async void OnInstall(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            if (!Installer.HasPayload)
            {
                ShowError(_s["noPayload"], null);
                return;
            }
            _busy = true;
            LanguageBar.IsEnabled = false;
            CloseButton.IsEnabled = false;
            _stage = Stage.Prepare;
            Bar.Value = 0;
            PercentText.Text = _s.Digits("0%");
            RenderSteps();
            Show(ProgressPage);

            var options = new InstallOptions
            {
                DesktopShortcut = OptDesktop.IsChecked == true,
                StartWithWindows = OptStartup.IsChecked == true,
                LaunchWhenDone = OptLaunch.IsChecked == true,
                Language = _s.Code,
            };
            var progress = new Progress<Tuple<Stage, double>>(p =>
            {
                if (p.Item1 != _stage)
                {
                    _stage = p.Item1;
                    RenderSteps();
                }
                var pct = Math.Round(p.Item2 * 100);
                Bar.BeginAnimation(RangeBase.ValueProperty, new DoubleAnimation(p.Item2, TimeSpan.FromMilliseconds(240)));
                PercentText.Text = _s.Digits(pct + "%");
            });
            try
            {
                await Task.Run(() => Installer.RunAsync(options, progress, CancellationToken.None));
                await Task.Delay(350);
                if (options.LaunchWhenDone)
                {
                    try { Installer.Launch(); } catch (Exception ex) { Installer.Log("launch: " + ex.Message); }
                }
                ShowDone(options.LaunchWhenDone);
            }
            catch (Exception ex)
            {
                Installer.Log("failed: " + ex);
                ShowError(_s["errorBody"], ex.Message + "  ·  " + Installer.LogPath);
            }
            finally
            {
                _busy = false;
                LanguageBar.IsEnabled = true;
                CloseButton.IsEnabled = true;
            }
        }

        private void ShowDone(bool launched)
        {
            _installed = true;
            // The app is already opening: the page offers to close instead.
            OpenButton.Visibility = launched ? Visibility.Collapsed : Visibility.Visible;
            FinishCloseButton.Style = (Style)FindResource(launched ? "AccentButton" : "SecondaryButton");
            Show(DonePage);
            var ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.5 };
            DoneScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(480)) { EasingFunction = ease });
            DoneScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(480)) { EasingFunction = ease });
            if (launched) CloseSoon();
        }

        /// <summary>Once the app is on screen the installer has done its job; it steps aside after a moment.</summary>
        private async void CloseSoon()
        {
            await Task.Delay(6000);
            if (IsVisible && DonePage.Visibility == Visibility.Visible) Close();
        }

        private void ShowError(string body, string detail)
        {
            ErrorBody.Text = body;
            ErrorDetail.Text = detail ?? string.Empty;
            ErrorDetail.Visibility = string.IsNullOrEmpty(detail) ? Visibility.Collapsed : Visibility.Visible;
            RetryButton.Visibility = Installer.HasPayload ? Visibility.Visible : Visibility.Collapsed;
            Show(ErrorPage);
        }

        private void OnOpen(object sender, RoutedEventArgs e)
        {
            try { Installer.Launch(); } catch (Exception ex) { Installer.Log("launch: " + ex.Message); }
            Close();
        }

        private void OnLanguage(object sender, RoutedEventArgs e)
        {
            if (sender is RadioButton r && r.Tag is string code && code != _s.Code)
            {
                _s = Strings.For(code);
                Render();
            }
        }

        private void OnDrag(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        }

        private void OnMinimize(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

        private void OnClose(object sender, RoutedEventArgs e)
        {
            if (!_busy) Close();
        }

        private void OnCardSizeChanged(object sender, SizeChangedEventArgs e) =>
            Card.Clip = new RectangleGeometry(new Rect(0, 0, Card.ActualWidth, Card.ActualHeight), 14, 14);

        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            // Closing mid-install would leave half a copy behind.
            if (_busy) e.Cancel = true;
            base.OnClosing(e);
        }
    }
}
