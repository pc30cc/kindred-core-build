using System.Text.Json;

namespace Webyar.Core.Realtime;

/// <summary>Something that happened in the workspace: a new message, or a change to a conversation.</summary>
public sealed record InboxEvent(string Type, string? ConversationId, string? MessageId = null, string? SenderType = null, string? Kind = null)
{
    public bool IsMessage => Type == "message";
    public bool IsVisitorMessage => IsMessage && SenderType == Api.SenderTypes.Contact;
}

public abstract record CentrifugoFrame
{
    /// <summary>An empty object: the server's ping. Unanswered, the server drops the connection.</summary>
    public sealed record Ping : CentrifugoFrame;
    public sealed record Reply(int Id, bool IsConnect, bool IsSubscribe, string? Error) : CentrifugoFrame;
    public sealed record Publication(string? Channel, InboxEvent Event) : CentrifugoFrame;
    public sealed record Disconnect : CentrifugoFrame;
    public sealed record Other : CentrifugoFrame;
}

/// <summary>
/// Centrifugo's JSON protocol, the subset the web console uses
/// (src/realtime/providers/centrifugo.ts): numbered commands, replies with the
/// same id, pushes carrying `{ type, payload }` envelopes, and several frames
/// per WebSocket message separated by newlines.
/// </summary>
public static class CentrifugoProtocol
{
    public static string Connect(int id, string token, string name) =>
        JsonSerializer.Serialize(new { id, connect = new { token, name } });

    public static string Subscribe(int id, string channel, string token) =>
        JsonSerializer.Serialize(new { id, subscribe = new { channel, token } });

    public const string Pong = "{}";

    public static IEnumerable<CentrifugoFrame> Parse(string message)
    {
        foreach (var raw in message.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            CentrifugoFrame frame;
            try
            {
                using var doc = JsonDocument.Parse(line);
                frame = ParseOne(doc.RootElement);
            }
            catch (JsonException)
            {
                continue;
            }
            yield return frame;
        }
    }

    private static CentrifugoFrame ParseOne(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return new CentrifugoFrame.Other();
        if (!root.EnumerateObject().Any()) return new CentrifugoFrame.Ping();

        if (root.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id))
        {
            string? error = null;
            if (root.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
            {
                error = err.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : err.GetRawText();
            }
            return new CentrifugoFrame.Reply(id, root.TryGetProperty("connect", out _), root.TryGetProperty("subscribe", out _), error);
        }

        if (root.TryGetProperty("push", out var push) && push.ValueKind == JsonValueKind.Object)
        {
            if (push.TryGetProperty("disconnect", out _)) return new CentrifugoFrame.Disconnect();
            var channel = push.TryGetProperty("channel", out var ch) && ch.ValueKind == JsonValueKind.String ? ch.GetString() : null;
            if (push.TryGetProperty("pub", out var pub) && pub.TryGetProperty("data", out var data) && ToEvent(data) is { } ev)
                return new CentrifugoFrame.Publication(channel, ev);
        }
        return new CentrifugoFrame.Other();
    }

    /// <summary>The `{ type, payload }` envelope the server publishes (server/services/realtime/publish.ts).</summary>
    internal static InboxEvent? ToEvent(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return null;
        var type = t.GetString()!;
        var payload = data.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
        string? S(string name) => payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new InboxEvent(type, S("conversation_id"), S("id"), S("sender_type"), S("kind"));
    }
}
