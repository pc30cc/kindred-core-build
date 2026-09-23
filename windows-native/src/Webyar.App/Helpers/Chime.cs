using System.Runtime.InteropServices.WindowsRuntime;
using Webyar.App.Services;
using Windows.Media.Core;
using Windows.Media.Playback;

namespace Webyar.App.Helpers;

/// <summary>
/// The web desk's new-call chime, rebuilt sample for sample: two sine tones,
/// 880 Hz then 1175 Hz 0.18 s later, each ~0.32 s, peaking at 0.15 gain.
/// Rendered once into a WAV in memory and played through the media stack.
/// </summary>
public static class Chime
{
    private const int Rate = 44100;
    private static byte[]? _wav;
    private static MediaPlayer? _player;

    public static async void Play()
    {
        try
        {
            _wav ??= Render();
            var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(_wav.AsBuffer());
            stream.Seek(0);
            _player?.Dispose();
            _player = new MediaPlayer { AudioCategory = MediaPlayerAudioCategory.Alerts, Source = MediaSource.CreateFromStream(stream, "audio/wav") };
            _player.Play();
        }
        catch (Exception e)
        {
            Log.Error("chime", e);
        }
    }

    private static byte[] Render()
    {
        var total = (int)(Rate * 0.55);
        var samples = new double[total];
        Tone(samples, 880, 0, 0.32);
        Tone(samples, 1175, 0.18, 0.32);
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write("RIFF"u8); w.Write(36 + total * 2); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(Rate); w.Write(Rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write("data"u8); w.Write(total * 2);
        foreach (var s in samples) w.Write((short)Math.Clamp(s * short.MaxValue, short.MinValue, short.MaxValue));
        w.Flush();
        return ms.ToArray();
    }

    /// <summary>A quick attack to 0.15 and an exponential fade, like the Web Audio ramps.</summary>
    private static void Tone(double[] into, double hz, double start, double length)
    {
        var from = (int)(start * Rate);
        var n = (int)(length * Rate);
        for (var i = 0; i < n && from + i < into.Length; i++)
        {
            var t = (double)i / Rate;
            var attack = Math.Min(1, t / 0.02);
            var decay = Math.Exp(-t * 9);
            into[from + i] += Math.Sin(2 * Math.PI * hz * t) * 0.15 * attack * decay;
        }
    }
}
