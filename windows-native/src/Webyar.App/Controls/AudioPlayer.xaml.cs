using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
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

    private readonly DispatcherQueueTimer _tick;
    private MediaPlayer? _player;
    private bool _seeking;
    private bool _opening;

    public AudioPlayer()
    {
        InitializeComponent();
        _tick = DispatcherQueue.GetForCurrentThread().CreateTimer();
        _tick.Interval = TimeSpan.FromMilliseconds(200);
        _tick.Tick += (_, _) => ShowPosition();
        Unloaded += (_, _) => Stop();
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
        Scrubber.Value = 0;
        TimeText.Text = "0:00";
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
        _seeking = true;
        Scrubber.Value = total.TotalMilliseconds > 0 ? session.Position.TotalMilliseconds / total.TotalMilliseconds : 0;
        _seeking = false;
        var shown = session.PlaybackState == MediaPlaybackState.Playing || session.Position > TimeSpan.Zero ? session.Position : total;
        TimeText.Text = Format(shown) + (total > TimeSpan.Zero ? " / " + Format(total) : string.Empty);
    }

    private void OnScrub(object sender, RangeBaseValueChangedEventArgs e)
    {
        if (_seeking || _player is null) return;
        var total = _player.PlaybackSession.NaturalDuration;
        if (total > TimeSpan.Zero) _player.PlaybackSession.Position = TimeSpan.FromMilliseconds(total.TotalMilliseconds * e.NewValue);
        ShowPosition();
    }

    private static string Format(TimeSpan t) => $"{(int)t.TotalMinutes}:{t.Seconds:00}";
}
