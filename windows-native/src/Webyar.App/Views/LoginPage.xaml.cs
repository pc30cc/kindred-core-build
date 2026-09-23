using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

public sealed partial class LoginPage : Page
{
    private bool _ready;

    public LoginPage()
    {
        InitializeComponent();
        Logo.Source = new BitmapImage(new Uri(AppPaths.Icon));
        BrandLogo.Source = new BitmapImage(new Uri(AppPaths.Icon));
        if (SavedLogin.Read() is { } saved)
        {
            Email.Text = saved.Email;
            Password.Password = saved.Password;
            Remember.IsChecked = true;
        }
        Password.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter) OnSignIn(this, new RoutedEventArgs());
        };
        LanguagePicker.SelectedIndex = Host.Strings.Language switch { Core.Localization.Language.En => 1, Core.Localization.Language.Tr => 2, _ => 0 };
        ApplyLanguage();
        _ready = true;
        Loaded += (_, _) => (Email.Text.Length > 0 ? (Control)SignIn : Email).Focus(FocusState.Programmatic);
    }

    private static AppHost Host => App.Current.Host;

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        TitleText.Text = s["loginTitle"];
        SubtitleText.Text = s["loginSubtitle"];
        EmailLabel.Text = s["emailLabel"];
        PasswordLabel.Text = s["passwordLabel"];
        Remember.Content = s["rememberMe"];
        LanguageLabel.Text = s["language"];
        BrandName.Text = s["appName"];
        BrandTagline.Text = s["desktopTagline"];
        Feature1.Text = s["loginFeatureInbox"];
        Feature2.Text = s["loginFeatureAi"];
        Feature3.Text = s["loginFeatureCalls"];
        SignInText.Text = s["logIn"];
        ForgotPassword.Content = s["forgotPassword"];
        Error.IsOpen = false;
    }

    private async void OnSignIn(object sender, RoutedEventArgs e)
    {
        var s = Host.Strings;
        var email = Email.Text.Trim();
        if (email.Length == 0 || Password.Password.Length == 0 || !SignIn.IsEnabled) return;
        SetBusy(true);
        Error.IsOpen = false;
        try
        {
            Host.User = await Host.Client.LoginAsync(email, Password.Password);
            if (Remember.IsChecked == true) SavedLogin.Write(email, Password.Password);
            else SavedLogin.Forget();
            Password.Password = string.Empty;
            await App.Current.Window!.EnterAsync();
        }
        catch (Exception ex)
        {
            Log.Error("login", ex);
            Error.Message = ErrorText.For(ex, s, unauthorized: s["loginFailed"]);
            if (ex is ApiException { Status: 400 or 401 or 403 }) Error.Message = s["loginFailed"];
            Error.IsOpen = true;
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        SignIn.IsEnabled = !busy;
        Email.IsEnabled = !busy;
        Password.IsEnabled = !busy;
        Busy.IsActive = busy;
        Busy.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        SignInText.Text = busy ? Host.Strings["signingIn"] : Host.Strings["logIn"];
    }

    private async void OnForgotPassword(object sender, RoutedEventArgs e)
    {
        var s = Host.Strings;
        var flow = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        // The address is asked for in the dialog itself; an empty field used to do nothing at all.
        var box = new TextBox
        {
            Text = Email.Text.Trim(),
            PlaceholderText = "name@company.com",
            InputScope = new Microsoft.UI.Xaml.Input.InputScope { Names = { new Microsoft.UI.Xaml.Input.InputScopeName(Microsoft.UI.Xaml.Input.InputScopeNameValue.EmailSmtpAddress) } },
            IsSpellCheckEnabled = false,
            FlowDirection = FlowDirection.LeftToRight,
            CornerRadius = new CornerRadius(10),
        };
        var panel = new StackPanel { Spacing = 12, MinWidth = 340 };
        panel.Children.Add(new TextBlock { Text = s["resetSubtitle"], TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(box);
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            FlowDirection = flow,
            Title = s["resetTitle"],
            Content = panel,
            PrimaryButtonText = s["sendResetLink"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Primary,
        };
        box.TextChanged += (_, _) => dialog.IsPrimaryButtonEnabled = IsEmail(box.Text);
        dialog.IsPrimaryButtonEnabled = IsEmail(box.Text);
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var email = box.Text.Trim();
        Email.Text = email;
        try
        {
            await Host.Api.SendPasswordResetAsync(email, Strings.Code(s.Language));
            await new ContentDialog
            {
                XamlRoot = XamlRoot,
                FlowDirection = flow,
                Title = s["resetSentTitle"],
                Content = s.Get("resetSentDetail", "email", email) + "\n\n" + s["resetCheckSpam"],
                CloseButtonText = s["ok"],
            }.ShowAsync();
        }
        catch (Exception ex)
        {
            Log.Error("password reset", ex);
            Error.Message = ErrorText.For(ex, s);
            Error.IsOpen = true;
        }
    }

    private static bool IsEmail(string text)
    {
        var t = text.Trim();
        var at = t.IndexOf('@');
        return at > 0 && t.LastIndexOf('.') > at + 1 && !t.EndsWith('.');
    }

    /// <summary>The brand panel needs room; on a narrow window the card stands alone.</summary>
    private void OnSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var wide = e.NewSize.Width >= 900;
        BrandPanel.Visibility = wide ? Visibility.Visible : Visibility.Collapsed;
        BrandColumn.Width = wide ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
        SmallLogo.Visibility = wide ? Visibility.Collapsed : Visibility.Visible;
    }

    private void OnLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || LanguagePicker.SelectedItem is not ComboBoxItem { Tag: string code } || Strings.Parse(code) is not { } language) return;
        Host.SetLanguage(language);
        ApplyLanguage();
    }
}
