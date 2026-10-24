using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.Core.Inbox;

namespace Webyar.App.Controls;

/// <summary>
/// A workspace's face, on a rounded square: the logo its owner set; else —
/// when there is none, while it is on its way, or if it will not load — the
/// platform's workspace glyph (AvatarGlyphs, a shop front) in the brand's ink
/// on its soft tile. Never the workspace's first letter, and never the
/// product's own mark, which says nothing about which workspace this is.
/// The same glyph the web panel, the website widgets and the other apps draw.
/// </summary>
public sealed partial class WorkspaceMark : UserControl
{
    public WorkspaceMark()
    {
        InitializeComponent();
        Glyph.Data = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), AvatarGlyphs.WorkspacePath);
        Loaded += (_, _) => Render();
    }

    private static DependencyProperty Prop<T>(string name, T fallback) =>
        DependencyProperty.Register(name, typeof(T), typeof(WorkspaceMark), new PropertyMetadata(fallback, (d, _) => ((WorkspaceMark)d).Render()));

    public static readonly DependencyProperty LogoUrlProperty = Prop<string?>(nameof(LogoUrl), null);
    public static readonly DependencyProperty SizeProperty = Prop(nameof(Size), 28d);

    /// <summary>The workspace's logo; anything but an https link counts as none.</summary>
    public string? LogoUrl { get => (string?)GetValue(LogoUrlProperty); set => SetValue(LogoUrlProperty, value); }

    /// <summary>Width and height, in pixels.</summary>
    public double Size { get => (double)GetValue(SizeProperty); set => SetValue(SizeProperty, value); }

    /// <summary>The logo the brush shows or is loading, so a re-render does not start it over.</summary>
    private string? _shown;
    private string? _failed;

    private void Render()
    {
        var size = Size > 0 ? Size : 28;
        Width = Height = size;
        var corner = new CornerRadius(Math.Round(size * 0.28));
        Tile.CornerRadius = corner;
        Logo.CornerRadius = corner;
        GlyphBox.Width = GlyphBox.Height = Math.Round(size * AvatarGlyphs.WorkspaceBox(size));

        var logo = LogoUrl is { } url && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.AbsoluteUri != _failed ? uri : null;
        if (logo is null)
        {
            _shown = null;
            LogoBrush.ImageSource = null;
            ShowGlyph();
            return;
        }
        if (_shown == logo.AbsoluteUri) return;
        _shown = logo.AbsoluteUri;
        ShowGlyph();
        LogoBrush.ImageSource = new BitmapImage(logo);
    }

    private void ShowGlyph()
    {
        Logo.Opacity = 0;
        Tile.Visibility = Visibility.Visible;
    }

    private void OnLogoOpened(object sender, RoutedEventArgs e)
    {
        if (_shown is null) return;
        // On its own: a logo with see-through corners must not show the shop front behind it.
        Logo.Opacity = 1;
        Tile.Visibility = Visibility.Collapsed;
    }

    private void OnLogoFailed(object sender, ExceptionRoutedEventArgs e)
    {
        _failed = _shown;
        _shown = null;
        LogoBrush.ImageSource = null;
        ShowGlyph();
    }
}
