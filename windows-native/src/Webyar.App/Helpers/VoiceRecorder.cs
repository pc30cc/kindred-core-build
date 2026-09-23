using Webyar.App.Services;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using Windows.Storage.Streams;

namespace Webyar.App.Helpers;

/// <summary>
/// Records a voice note from the default microphone into memory as AAC in an
/// M4A container — the same audio/mp4 the widget sends, so both sides play it.
/// </summary>
public sealed class VoiceRecorder : IAsyncDisposable
{
    private MediaCapture? _capture;
    private InMemoryRandomAccessStream? _stream;

    public bool IsRecording { get; private set; }

    public DateTimeOffset StartedAt { get; private set; }

    /// <summary>Starts recording. Throws <see cref="UnauthorizedAccessException"/> when Windows blocks the microphone.</summary>
    public async Task StartAsync()
    {
        if (IsRecording) return;
        _capture = new MediaCapture();
        await _capture.InitializeAsync(new MediaCaptureInitializationSettings
        {
            StreamingCaptureMode = StreamingCaptureMode.Audio,
            MediaCategory = MediaCategory.Speech,
        });
        _stream = new InMemoryRandomAccessStream();
        await _capture.StartRecordToStreamAsync(MediaEncodingProfile.CreateM4a(AudioEncodingQuality.Medium), _stream);
        IsRecording = true;
        StartedAt = DateTimeOffset.Now;
    }

    /// <summary>Stops and returns the note's bytes.</summary>
    public async Task<byte[]> StopAsync()
    {
        if (!IsRecording || _capture is null || _stream is null) return [];
        IsRecording = false;
        await _capture.StopRecordAsync();
        var data = new byte[_stream.Size];
        _stream.Seek(0);
        using (var reader = new DataReader(_stream.GetInputStreamAt(0)))
        {
            await reader.LoadAsync((uint)_stream.Size);
            reader.ReadBytes(data);
        }
        await DisposeAsync();
        return data;
    }

    /// <summary>Throws the recording away.</summary>
    public async Task CancelAsync()
    {
        if (IsRecording && _capture is not null)
        {
            IsRecording = false;
            try
            {
                await _capture.StopRecordAsync();
            }
            catch (Exception e)
            {
                Log.Error("voice cancel", e);
            }
        }
        await DisposeAsync();
    }

    public ValueTask DisposeAsync()
    {
        IsRecording = false;
        _capture?.Dispose();
        _capture = null;
        _stream?.Dispose();
        _stream = null;
        return ValueTask.CompletedTask;
    }
}
