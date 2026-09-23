using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.Core.Api;

namespace Webyar.App.Controls;

/// <summary>Shows Super Admin's ad for one placement; follows changes on its own while on screen.</summary>
public sealed partial class CampaignCard : UserControl
{
    private DesktopCampaign? _shown;

    public CampaignCard()
    {
        InitializeComponent();
        Loaded += (_, _) =>
        {
            Host.Engagement.Changed += Render;
            Render();
        };
        Unloaded += (_, _) => Host.Engagement.Changed -= Render;
    }

    private static AppHost Host => App.Current.Host;

    public static readonly DependencyProperty PlacementProperty =
        DependencyProperty.Register(nameof(Placement), typeof(string), typeof(CampaignCard), new PropertyMetadata(null, (d, _) => ((CampaignCard)d).Render()));

    /// <summary>inbox_list, colleagues_list, contacts_list, chat_empty or settings.</summary>
    public string? Placement
    {
        get => (string?)GetValue(PlacementProperty);
        set => SetValue(PlacementProperty, value);
    }

    private void Render()
    {
        var ad = Placement is { } p ? Host.Engagement.AdFor(p) : null;
        _shown = ad;
        Visibility = ad is null ? Visibility.Collapsed : Visibility.Visible;
        if (ad is null) return;
        AdBadge.Text = Host.Strings["adTag"];
        TitleText.Text = ad.Title ?? string.Empty;
        TitleText.Visibility = string.IsNullOrWhiteSpace(ad.Title) ? Visibility.Collapsed : Visibility.Visible;
        BodyText.Text = ad.Body ?? string.Empty;
        BodyText.Visibility = string.IsNullOrWhiteSpace(ad.Body) ? Visibility.Collapsed : Visibility.Visible;
        CloseButton.Visibility = ad.Dismissible ? Visibility.Visible : Visibility.Collapsed;
        ToolTipService.SetToolTip(CloseButton, Host.Strings["close"]);
        var hasCta = ad.CtaUrl is { Length: > 0 };
        Cta.Visibility = hasCta ? Visibility.Visible : Visibility.Collapsed;
        CtaText.Text = ad.CtaLabel is { Length: > 0 } label ? label : Host.Strings["adLearnMore"];
        if (ad.ImageUrl is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            PictureBrush.ImageSource = new BitmapImage(uri) { DecodePixelWidth = 96 };
            Picture.Visibility = Visibility.Visible;
        }
        else
        {
            Picture.Visibility = Visibility.Collapsed;
        }
    }

    private void OnClose(object sender, RoutedEventArgs e)
    {
        if (_shown is { } ad) Host.Engagement.Dismiss(ad);
    }

    private async void OnCta(object sender, RoutedEventArgs e)
    {
        if (_shown?.CtaUrl is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
            await Windows.System.Launcher.LaunchUriAsync(uri);
    }
}
