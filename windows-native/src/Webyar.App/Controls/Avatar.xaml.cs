using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Inbox;
using Windows.UI;
using Path = Microsoft.UI.Xaml.Shapes.Path;

namespace Webyar.App.Controls;

/// <summary>
/// A person, drawn as the Mac app's AvatarView draws them: their photo; else
/// their operating system's logo on that OS's gradient; else a grey disc with
/// a person in it, softly tinted by a hash of the name. Operators show their
/// photo or the grey disc with a person; the AI its sparkle. Never initials.
///
/// While the photo is on its way — or while the page still waits to learn
/// who this is (<see cref="IsPending"/>) — the avatar is a pulsing skeleton,
/// so a face is never drawn and then swapped for another.
/// </summary>
public sealed partial class Avatar : UserControl
{
    // Lucide / web glyphs on a 24×24 grid.
    private const string WindowsPath = "M3 5.5l8-1.1v7.1H3V5.5zm0 13l8 1.1v-7H3v5.9zm9 1.2l9 1.3v-8.5h-9v7.2zm0-15.4l9-1.3v8.5h-9V4.3z";
    private const string LinuxPath = "M12 2.4c-2 0-3.4 1.7-3.4 3.9 0 1 .3 1.9.7 2.6-.9.6-1.8 1.6-2.4 2.9-.9 2-1.4 4-2.2 5.5-.4.7-.9 1.2-.9 1.8 0 .8.8 1.3 1.7 1.5.7.2 1.4.3 1.7.6.4.4.8 1 2.1 1.2 1 .2 2.1-.1 2.7-.5.6.4 1.7.7 2.7.5 1.3-.2 1.7-.8 2.1-1.2.3-.3 1-.4 1.7-.6.9-.2 1.7-.7 1.7-1.5 0-.6-.5-1.1-.9-1.8-.8-1.5-1.3-3.5-2.2-5.5-.6-1.3-1.5-2.3-2.4-2.9.4-.7.7-1.6.7-2.6 0-2.2-1.4-3.9-3.4-3.9zm-1.4 4.1c.3 0 .5.4.5.9 0 .2 0 .4-.1.5-.1-.1-.3-.1-.4-.1-.4 0-.7.3-.7.7v.1c-.2-.2-.3-.5-.3-.8 0-.7.5-1.3 1-1.3zm2.8 0c.5 0 1 .6 1 1.3 0 .3-.1.6-.3.8v-.1c0-.4-.3-.7-.7-.7-.1 0-.3 0-.4.1-.1-.1-.1-.3-.1-.5 0-.5.2-.9.5-.9z";
    private const string ApplePath = "M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z";
    private const string AppleLeafPath = "M10 2c1 .5 2 2 2 5";
    private const string PhonePath = "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M12 18h.01";

    private const string PersonGlyph = "\uE77B";
    private const string SparkleGlyph = "\uE99A";

    private Storyboard? _pulse;

    public Avatar()
    {
        InitializeComponent();
        Loaded += (_, _) => Render();
        Unloaded += (_, _) => StopPulse();
    }

    private static DependencyProperty Prop<T>(string name, T fallback) =>
        DependencyProperty.Register(name, typeof(T), typeof(Avatar), new PropertyMetadata(fallback, (d, _) => ((Avatar)d).Render()));

    public static readonly DependencyProperty DisplayNameProperty = Prop<string?>(nameof(DisplayName), null);
    public static readonly DependencyProperty EmailProperty = Prop<string?>(nameof(Email), null);
    public static readonly DependencyProperty OsProperty = Prop<string?>(nameof(Os), null);
    public static readonly DependencyProperty CountryCodeProperty = Prop<string?>(nameof(CountryCode), null);
    public static readonly DependencyProperty ImageUrlProperty = Prop<string?>(nameof(ImageUrl), null);
    public static readonly DependencyProperty SizeProperty = Prop(nameof(Size), 40d);
    public static readonly DependencyProperty KindProperty = Prop<string?>(nameof(Kind), null);
    public static readonly DependencyProperty PresenceProperty = Prop<string?>(nameof(PresenceState), null);
    public static readonly DependencyProperty IsPendingProperty = Prop(nameof(IsPending), false);

    /// <summary>The person's own name, not a generated "Visitor · 4ZTK" label: the web hashes the raw name.</summary>
    public string? DisplayName { get => (string?)GetValue(DisplayNameProperty); set => SetValue(DisplayNameProperty, value); }
    public string? Email { get => (string?)GetValue(EmailProperty); set => SetValue(EmailProperty, value); }
    public string? Os { get => (string?)GetValue(OsProperty); set => SetValue(OsProperty, value); }
    public string? CountryCode { get => (string?)GetValue(CountryCodeProperty); set => SetValue(CountryCodeProperty, value); }
    public string? ImageUrl { get => (string?)GetValue(ImageUrlProperty); set => SetValue(ImageUrlProperty, value); }
    public double Size { get => (double)GetValue(SizeProperty); set => SetValue(SizeProperty, value); }

    /// <summary>null for a visitor, "operator" for a teammate, "ai" for the assistant.</summary>
    public string? Kind { get => (string?)GetValue(KindProperty); set => SetValue(KindProperty, value); }

    /// <summary>
    /// The dot: operator presence (active, away, disconnected, offline),
    /// visitor presence (online, idle) or a conversation status (open,
    /// pending, resolved, closed). null for none.
    /// </summary>
    public string? PresenceState { get => (string?)GetValue(PresenceProperty); set => SetValue(PresenceProperty, value); }

    /// <summary>Who this is (their photo, device) is still loading: the skeleton, not a face that may change.</summary>
    public bool IsPending { get => (bool)GetValue(IsPendingProperty); set => SetValue(IsPendingProperty, value); }

    private string? _failedUrl;

    /// <summary>The photo (URL and decode width) the brush shows or is loading, so a re-render does not start over.</summary>
    private string? _photoKey;

    private void Render()
    {
        var size = Size > 0 ? Size : 40;
        Width = size;
        Height = size;

        var photo = PhotoUri(ImageUrl);
        var photoReady = false;
        if (photo is not null && photo.AbsoluteUri != _failedUrl && AvatarImages.ShouldTry(photo))
        {
            // Through the shared photo cache (memory → disk → network), not a
            // BitmapImage per row: a list refresh, a recycled row or a restart
            // shows the photo without downloading it again, offline included.
            var width = (int)(size * 2);
            var key = $"{width}|{photo.AbsoluteUri}";
            if (_photoKey != key)
            {
                _photoKey = key;
                if (AvatarImages.Peek(photo, width) is { } ready) PhotoBrush.ImageSource = ready;
                else
                {
                    PhotoBrush.ImageSource = null;
                    _ = LoadPhotoAsync(photo, width, key);
                }
            }
            photoReady = PhotoBrush.ImageSource is not null;
            Photo.Visibility = Visibility.Visible;
        }
        else
        {
            photo = null;
            _photoKey = null;
            PhotoBrush.ImageSource = null;
            Photo.Visibility = Visibility.Collapsed;
        }

        GlyphBox.Visibility = Visibility.Collapsed;
        IconGlyph.Visibility = Visibility.Collapsed;
        Gloss.Visibility = Visibility.Collapsed;
        Tint.Visibility = Visibility.Collapsed;

        // Still loading who this is, or their photo: the skeleton and nothing else.
        var loading = Kind is not "ai" && (IsPending || (photo is not null && !photoReady));
        Skeleton.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        if (loading) StartPulse();
        else StopPulse();

        if (loading || photoReady)
        {
            // Under the photo too, for a picture with transparent corners.
            Disc.Fill = Palette.Resource("ElevatedBrush");
        }
        else if (Kind is "ai")
        {
            Disc.Fill = Palette.Resource("AiSoftBrush");
            ShowIcon(SparkleGlyph, size * 0.5, Palette.Resource("AiBrush"));
        }
        else if (Kind is "operator")
        {
            // No initials anywhere: an operator without a photo is the grey disc with a person.
            Disc.Fill = Palette.Resource("ElevatedBrush");
            ShowIcon(PersonGlyph, size * 0.46, Palette.Resource("Text3Brush"));
        }
        else if (AvatarArt.For(DisplayName, Email, Os) is { Os: not AvatarOs.None } art)
        {
            Disc.Fill = Gradient(art);
            Gloss.Visibility = Visibility.Visible;
            ShowGlyph(art.Os, size);
        }
        else
        {
            // Nor for visitors: without their device's logo, a grey disc with a person, tinted by their name.
            var tint = ToColor(AvatarArt.Tint(DisplayName, Email));
            Disc.Fill = Palette.Resource("ElevatedBrush");
            Tint.Fill = new SolidColorBrush(tint);
            Tint.Visibility = Visibility.Visible;
            ShowIcon(PersonGlyph, size * 0.46, new SolidColorBrush(tint) { Opacity = 0.85 });
        }

        var badge = AvatarArt.CountryBadge(CountryCode);
        CountryBadge.Visibility = badge is null || size < 32 || IsPending ? Visibility.Collapsed : Visibility.Visible;
        if (badge is not null)
        {
            var b = size switch { <= 36 => 15, <= 40 => 16, <= 48 => 18, _ => Math.Round(size * 0.36) };
            CountryBadge.Width = b + 4;
            CountryBadge.Height = b;
            CountryBadge.Margin = new Thickness(-4, 0, 0, -4);
            CountryText.Text = badge;
            CountryText.FontSize = Math.Max(7, b * 0.48);
        }

        ShowDot(size);
    }

    private void ShowIcon(string glyph, double fontSize, Brush foreground)
    {
        IconGlyph.Glyph = glyph;
        IconGlyph.FontSize = fontSize;
        IconGlyph.Foreground = foreground;
        IconGlyph.Visibility = Visibility.Visible;
    }

    private void StartPulse()
    {
        if (_pulse is not null) return;
        var fade = new DoubleAnimation
        {
            From = 1,
            To = 0.45,
            Duration = TimeSpan.FromMilliseconds(900),
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        Storyboard.SetTarget(fade, Skeleton);
        Storyboard.SetTargetProperty(fade, "Opacity");
        _pulse = new Storyboard { Children = { fade } };
        _pulse.Begin();
    }

    private void StopPulse()
    {
        if (_pulse is null) return;
        _pulse.Stop();
        _pulse = null;
        Skeleton.Opacity = 1;
    }

    private void ShowGlyph(AvatarOs os, double size)
    {
        GlyphCanvas.Children.Clear();
        var white = new SolidColorBrush(Colors.White);
        switch (os)
        {
            case AvatarOs.Windows:
                GlyphCanvas.Children.Add(new Path { Data = Geometry(WindowsPath), Fill = white });
                break;
            case AvatarOs.Linux:
                GlyphCanvas.Children.Add(new Path { Data = Geometry(LinuxPath), Fill = white });
                break;
            case AvatarOs.Apple:
                GlyphCanvas.Children.Add(new Path { Data = Geometry(ApplePath), Fill = white, Stroke = white, StrokeThickness = 2, StrokeLineJoin = PenLineJoin.Round });
                GlyphCanvas.Children.Add(new Path { Data = Geometry(AppleLeafPath), Stroke = white, StrokeThickness = 2, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round });
                break;
            case AvatarOs.Android:
                GlyphCanvas.Children.Add(new Path { Data = Geometry(PhonePath), Stroke = white, StrokeThickness = 2, StrokeLineJoin = PenLineJoin.Round, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round });
                break;
        }
        GlyphBox.Width = GlyphBox.Height = Math.Round(size * 0.5);
        GlyphBox.Visibility = Visibility.Visible;
    }

    private void ShowDot(double size)
    {
        var state = PresenceState;
        if (state is null)
        {
            DotHost.Visibility = Visibility.Collapsed;
            return;
        }
        var d = size switch { <= 28 => 9, <= 40 => 11, <= 48 => 13, _ => Math.Round(size * 0.24) };
        DotHost.Width = DotHost.Height = d;
        DotHost.Margin = new Thickness(0, 0, -1, -1);
        Dot.Width = Dot.Height = d;
        DotHalo.Width = DotHalo.Height = d;
        DotHalo.Opacity = 0;
        var (fill, ring) = state switch
        {
            "active" or "online" or "open" => ("SuccessBrush", false),
            "away" or "idle" or "pending" => ("WarningBrush", false),
            "resolved" => ("InfoBrush", false),
            "disconnected" => ("Text3Brush", true),
            _ => ("Text3Brush", false),
        };
        Dot.Fill = Palette.Resource(fill);
        if (ring)
        {
            // Available but not connected: grey with a green ring, as on the web.
            DotHalo.Fill = Palette.Resource("SuccessBrush");
            DotHalo.Opacity = 0.6;
            Dot.Width = Dot.Height = d - 2;
        }
        DotHost.Visibility = Visibility.Visible;
    }

    private static Brush Gradient(AvatarArt art)
    {
        // CSS linear-gradient(angle): 0deg points up, clockwise; the line spans the box's corners.
        var rad = art.AngleDegrees * Math.PI / 180;
        double dx = Math.Sin(rad), dy = -Math.Cos(rad);
        var len = Math.Abs(dx) + Math.Abs(dy);
        return new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0.5 - dx * len / 2, 0.5 - dy * len / 2),
            EndPoint = new Windows.Foundation.Point(0.5 + dx * len / 2, 0.5 + dy * len / 2),
            GradientStops =
            {
                new GradientStop { Color = ToColor(art.From), Offset = 0 },
                new GradientStop { Color = ToColor(art.To), Offset = 1 },
            },
        };
    }

    private static Color ToColor(Hsl hsl)
    {
        var (r, g, b) = hsl.ToRgb();
        return Color.FromArgb(255, r, g, b);
    }

    private static Geometry Geometry(string data) => (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), data);

    /// <summary>Server URLs are absolute, except local storage, which answers with /storage/… on the API.</summary>
    private static Uri? PhotoUri(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            return Uri.TryCreate(url, UriKind.Absolute, out var abs) ? abs : null;
        if (url.StartsWith('/')) return new Uri(AppHost.Current.Client.Origin, url);
        return null;
    }

    private async Task LoadPhotoAsync(Uri photo, int width, string key)
    {
        var image = await AvatarImages.LoadAsync(photo, width);
        if (_photoKey != key) return; // another person or size since
        if (image is null)
        {
            // Their device's logo or the person disc instead; the shared cache retries the URL later.
            _photoKey = null;
            Render();
            return;
        }
        PhotoBrush.ImageSource = image;
        Render();
    }

    private void OnImageFailed(object sender, ExceptionRoutedEventArgs e)
    {
        _failedUrl = PhotoUri(ImageUrl)?.AbsoluteUri;
        _photoKey = null;
        Photo.Visibility = Visibility.Collapsed;
        Render();
    }
}
