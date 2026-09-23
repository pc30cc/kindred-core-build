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
        Password.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter) OnSignIn(this, new RoutedEventArgs());
        };
        LanguagePicker.SelectedIndex = Host.Strings.Language switch { Language.En => 1, Language.Tr => 2, _ => 0 };
        ApplyLanguage();
        _ready = true;
        Loaded += (_, _) => Email.Focus(FocusState.Programmatic);
    }

    private static AppHost Host => App.Current.Host;

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        TitleText.Text = s["loginTitle"];
        SubtitleText.Text = s["loginSubtitle"];
        Email.Header = s["emailLabel"];
        Password.Header = s["passwordLabel"];
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
        var email = Email.Text.Trim();
        if (email.Length == 0)
        {
            Email.Focus(FocusState.Programmatic);
            return;
        }
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
            Title = s["resetTitle"],
            Content = s["resetSubtitle"] + "\n\n" + email,
            PrimaryButtonText = s["sendResetLink"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try
        {
            await Host.Api.SendPasswordResetAsync(email, Strings.Code(s.Language));
            await new ContentDialog
            {
                XamlRoot = XamlRoot,
                FlowDirection = dialog.FlowDirection,
                Title = s["resetSentTitle"],
                Content = s.Get("resetSentDetail", "email", email) + "\n\n" + s["resetCheckSpam"],
                CloseButtonText = s["ok"],
            }.ShowAsync();
        }
        catch (Exception ex)
        {
            Error.Message = ErrorText.For(ex, s);
            Error.IsOpen = true;
        }
    }

    private void OnLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || LanguagePicker.SelectedItem is not ComboBoxItem { Tag: string code } || Strings.Parse(code) is not { } language) return;
        Host.SetLanguage(language);
        ApplyLanguage();
    }
}
