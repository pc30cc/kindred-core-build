using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Shapes;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Windows.Media.Core;
using Windows.Media.Playback;

namespace Webyar.App.Controls;

/// <summary>
/// Plays an audio attachment inside the conversation. The file is fetched with
/// the operator's session (attachments are private) and handed to the Windows
/// media stack from memory; only one note plays at a time.
/// </summary>
public sealed partial class AudioPlayer : UserControl
{
    private static AudioPlayer? _playing;

    /// <summary>Bars in the waveform. Only the shape is decorative; the fill is the real position.</summary>
    private const int Bars = 38;

    private readonly DispatcherQueueTimer _tick;
    private readonly Rectangle[] _bars = new Rectangle[Bars];
    private MediaPlayer? _player;
    private bool _opening;
    private int _played = -1;

    public AudioPlayer()
    {
        InitializeComponent();
        _tick = DispatcherQueue.GetForCurrentThread().CreateTimer();
        _tick.Interval = TimeSpan.FromMilliseconds(200);
        _tick.Tick += (_, _) => ShowPosition();
        for (var i = 0; i < Bars; i++)
        {
            _bars[i] = new Rectangle { Width = 3, RadiusX = 1.5, RadiusY = 1.5, VerticalAlignment = VerticalAlignment.Center };
            Wave.Children.Add(_bars[i]);
        }
        Loaded += (_, _) => Palette.ThemeChanged += Recolor;
        Unloaded += (_, _) =>
        {
            Palette.ThemeChanged -= Recolor;
            Stop();
        };
        Recolor();
    }

    public static readonly DependencyProperty OutgoingProperty = DependencyProperty.Register(
        nameof(Outgoing), typeof(bool), typeof(AudioPlayer), new PropertyMetadata(false, (d, _) => ((AudioPlayer)d).Recolor()));

    /// <summary>On an operator bubble: white controls on the brand blue instead of blue on grey.</summary>
    public bool Outgoing
    {
        get => (bool)GetValue(OutgoingProperty);
        set => SetValue(OutgoingProperty, value);
    }

    private void Recolor()
    {
        PlayButton.Background = Palette.Resource(Outgoing ? "PlayOutBackBrush" : "BrandBrush");
        var glyph = Palette.Resource(Outgoing ? "PlayOutGlyphBrush" : "OnBrandBrush");
        PlayGlyph.Foreground = glyph;
        Loading.Foreground = glyph;
        TimeText.Foreground = Palette.Resource(Outgoing ? "BubbleOutgoingMetaBrush" : "Text3Brush");
        _played = -1;
        Paint(Fraction());
    }

    /// <summary>
    /// A stable, speech-like outline per note: the same file always draws the
    /// same shape, louder in the middle and tapering at both ends.
    /// </summary>
    private void Shape(string seed)
    {
        var rnd = new Random(Palette.Hash(seed));
        var prev = 0.5;
        for (var i = 0; i < Bars; i++)
        {
            var envelope = Math.Sin(Math.PI * (i + 0.5) / Bars) * 0.55 + 0.45;
            var v = (prev * 0.45) + (rnd.NextDouble() * 0.55);
            prev = v;
            _bars[i].Height = Math.Max(4, Math.Round(4 + (22 * v * envelope)));
        }
    }

    private void Paint(double fraction)
    {
        var played = (int)Math.Round(fraction * Bars);
        if (played == _played) return;
        _played = played;
        var on = Palette.Resource(Outgoing ? "WaveOutPlayedBrush" : "WaveInPlayedBrush");
        var off = Palette.Resource(Outgoing ? "WaveOutBrush" : "WaveInBrush");
        for (var i = 0; i < Bars; i++) _bars[i].Fill = i < played ? on : off;
    }

    private double Fraction()
    {
        if (_player is null) return 0;
        var session = _player.PlaybackSession;
        var total = session.NaturalDuration.TotalMilliseconds;
        return total > 0 ? Math.Clamp(session.Position.TotalMilliseconds / total, 0, 1) : 0;
    }

    public static readonly DependencyProperty SourceProperty = DependencyProperty.Register(
        nameof(Source), typeof(AttachmentItem), typeof(AudioPlayer), new PropertyMetadata(null, (d, _) => ((AudioPlayer)d).Reset()));

    public AttachmentItem? Source
    {
        get => (AttachmentItem?)GetValue(SourceProperty);
        set => SetValue(SourceProperty, value);
    }

    private void Reset()
    {
        Stop();
        _player?.Dispose();
        _player = null;
        ErrorGlyph.Visibility = Visibility.Collapsed;
        Shape(Source?.Id ?? string.Empty);
        _played = -1;
        Paint(0);
        TimeText.Text = Source?.SizeText is { Length: > 0 } size ? size : "0:00";
    }

    private async void OnPlay(object sender, RoutedEventArgs e)
    {
        if (_opening || Source is not { } source) return;
        if (_player is null)
        {
            _opening = true;
            Loading.IsActive = true;
            PlayGlyph.Visibility = Visibility.Collapsed;
            try
            {
                var data = await source.BytesAsync();
                var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
                await stream.WriteAsync(data.AsBuffer());
                stream.Seek(0);
                var mime = string.IsNullOrEmpty(source.MimeType) ? "audio/mpeg" : source.MimeType;
                _player = new MediaPlayer { AudioCategory = MediaPlayerAudioCategory.Speech, Source = MediaSource.CreateFromStream(stream, mime) };
                _player.MediaEnded += (_, _) => DispatcherQueue.TryEnqueue(() =>
                {
                    _tick.Stop();
                    ShowPlaying(false);
                    if (_player is { } p) p.PlaybackSession.Position = TimeSpan.Zero;
                    ShowPosition();
                });
                _player.MediaFailed += (_, a) => DispatcherQueue.TryEnqueue(() => Failed(a.ErrorMessage));
                _player.PlaybackSession.NaturalDurationChanged += (_, _) => DispatcherQueue.TryEnqueue(ShowPosition);
            }
            catch (Exception ex)
            {
                Log.Error("audio load", ex);
                Failed(ex.Message);
                return;
            }
            finally
            {
                _opening = false;
                Loading.IsActive = false;
                PlayGlyph.Visibility = Visibility.Visible;
            }
        }

        if (_player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing)
        {
            _player.Pause();
            _tick.Stop();
            ShowPlaying(false);
            return;
        }
        if (_playing is { } other && other != this) other.Stop();
        _playing = this;
        _player.Play();
        _tick.Start();
        ShowPlaying(true);
    }

    private void Stop()
    {
        if (_player?.PlaybackSession.PlaybackState == MediaPlaybackState.Playing) _player.Pause();
        _tick.Stop();
        ShowPlaying(false);
        if (_playing == this) _playing = null;
    }

    private void Failed(string message)
    {
        Log.Write($"[audio] cannot play {Source?.MimeType}: {message}");
        _tick.Stop();
        ShowPlaying(false);
        _player?.Dispose();
        _player = null;
        ErrorGlyph.Visibility = Visibility.Visible;
        ToolTipService.SetToolTip(ErrorGlyph, AppHost.Current.Strings["audioUnsupported"]);
    }

    private void ShowPlaying(bool playing) => PlayGlyph.Glyph = playing ? "" : "";

    private void ShowPosition()
    {
        if (_player is null) return;
        var session = _player.PlaybackSession;
        var total = session.NaturalDuration;
        Paint(Fraction());
        var shown = session.PlaybackState == MediaPlaybackState.Playing || session.Position > TimeSpan.Zero ? session.Position : total;
        TimeText.Text = Format(shown) + (total > TimeSpan.Zero && shown != total ? " / " + Format(total) : string.Empty);
    }

    /// <summary>Seek by clicking the waveform, like every messenger.</summary>
    private void OnWavePressed(object sender, PointerRoutedEventArgs e)
    {
        if (_player is null || WaveHost.ActualWidth <= 0) return;
        var total = _player.PlaybackSession.NaturalDuration;
        if (total <= TimeSpan.Zero) return;
        var x = e.GetCurrentPoint(Wave).Position.X;
        var width = Wave.ActualWidth > 0 ? Wave.ActualWidth : WaveHost.ActualWidth;
        _player.PlaybackSession.Position = TimeSpan.FromMilliseconds(total.TotalMilliseconds * Math.Clamp(x / width, 0, 1));
        ShowPosition();
    }

    private static string Format(TimeSpan t) => $"{(int)t.TotalMinutes}:{t.Seconds:00}";
}
