using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Helpers;
using Webyar.Core.Inbox;

namespace Webyar.App.Controls;

/// <summary>
/// A person: their photo when there is one, otherwise their initials on a
/// colour picked from their name — the same ten colours and gradient as the
/// web console, so a visitor looks the same everywhere.
/// </summary>
public sealed partial class Avatar : UserControl
{
    public Avatar()
    {
        InitializeComponent();
        Loaded += (_, _) => Render();
    }

    public static readonly DependencyProperty DisplayNameProperty = DependencyProperty.Register(
        nameof(DisplayName), typeof(string), typeof(Avatar), new PropertyMetadata(string.Empty, (d, _) => ((Avatar)d).Render()));

    public static readonly DependencyProperty ImageUrlProperty = DependencyProperty.Register(
        nameof(ImageUrl), typeof(string), typeof(Avatar), new PropertyMetadata(null, (d, _) => ((Avatar)d).Render()));

    public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(
        nameof(Size), typeof(double), typeof(Avatar), new PropertyMetadata(40d, (d, _) => ((Avatar)d).Render()));

    /// <summary>"online", "offline" or null for no dot.</summary>
    public static readonly DependencyProperty PresenceProperty = DependencyProperty.Register(
        nameof(PresenceState), typeof(string), typeof(Avatar), new PropertyMetadata(null, (d, _) => ((Avatar)d).Render()));

    public string DisplayName
    {
        get => (string)GetValue(DisplayNameProperty);
        set => SetValue(DisplayNameProperty, value);
    }

    public string? ImageUrl
    {
        get => (string?)GetValue(ImageUrlProperty);
        set => SetValue(ImageUrlProperty, value);
    }

    public double Size
    {
        get => (double)GetValue(SizeProperty);
        set => SetValue(SizeProperty, value);
    }

    public string? PresenceState
    {
        get => (string?)GetValue(PresenceProperty);
        set => SetValue(PresenceProperty, value);
    }

    private string? _failedUrl;

    private void Render()
    {
        var size = Size > 0 ? Size : 40;
        Width = size;
        Height = size;
        var name = string.IsNullOrWhiteSpace(DisplayName) ? "?" : DisplayName;
        InitialsText.Text = Display.Initials(name);
        InitialsText.FontSize = Math.Max(10, size * 0.38);
        Disc.Background = Palette.AvatarBrush(name);

        var url = ImageUrl;
        var showPhoto = url is not null && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && url != _failedUrl;
        if (showPhoto && Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            if (PhotoBrush.ImageSource is not BitmapImage current || current.UriSource != uri)
                PhotoBrush.ImageSource = new BitmapImage(uri) { DecodePixelWidth = (int)(size * 2) };
            Photo.Visibility = Visibility.Visible;
        }
        else
        {
            Photo.Visibility = Visibility.Collapsed;
        }

        var dot = Math.Max(9, size * 0.28);
        Presence.Width = dot;
        Presence.Height = dot;
        Presence.Visibility = PresenceState is null ? Visibility.Collapsed : Visibility.Visible;
        if (PresenceState is not null)
            Presence.Fill = (Brush)Application.Current.Resources[PresenceState == "online" ? "SuccessBrush" : "Text3Brush"];
    }

    private void OnImageFailed(object sender, ExceptionRoutedEventArgs e)
    {
        _failedUrl = ImageUrl;
        Photo.Visibility = Visibility.Collapsed;
    }
}
