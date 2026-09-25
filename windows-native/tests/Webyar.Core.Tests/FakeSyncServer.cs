using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Webyar.Core.Api;

namespace Webyar.Core.Tests;

/// <summary>
/// The server side of thread and queue sync, as server/routes/conversations.ts
/// and server/services/messageSync.ts implement it: `?since=` deltas by
/// updated_at, a `total` per answer, weak ETags and 304s. Counts every
/// request and byte so tests can compare approaches.
/// </summary>
internal sealed partial class FakeSyncServer
{
    private readonly object _lock = new();
    private long _clock = 1_000;

    public string WorkspaceId { get; init; } = "w1";
    public Dictionary<string, List<Message>> Threads { get; } = [];
    public Dictionary<InboxFilter, List<Conversation>> Queues { get; } = [];
    public HashSet<string> Forbidden { get; } = [];

    /// <summary>Off: behaves like a server from before incremental sync (full threads, no `sync`).</summary>
    public bool SupportsDelta { get; set; } = true;

    /// <summary>Called before each answer, e.g. to hold one back and answer another first.</summary>
    public Func<HttpRequestMessage, Task>? BeforeRespond { get; set; }

    /// <summary>Makes every request fail as if offline.</summary>
    public bool Offline { get; set; }

    public int Requests;
    public long BytesSent;
    public int NotModifiedCount;

    public HttpMessageHandler Handler => new FakeHttp(RespondAsync);

    public WebyarApi Api() => new(new ApiClient(new MemorySessionStore("t"), handler: Handler));

    private DateTimeOffset Tick() => DateTimeOffset.FromUnixTimeMilliseconds(Interlocked.Increment(ref _clock));

    public Message Add(string conversationId, string id, string body = "hi", string sender = SenderTypes.Contact, string? clientMessageId = null)
    {
        lock (_lock)
        {
            var now = Tick();
            JsonElement? meta = clientMessageId is null ? null : JsonDocument.Parse($"{{\"client_message_id\":\"{clientMessageId}\"}}").RootElement.Clone();
            var m = new Message(id, conversationId, sender, body, CreatedAt: now, Metadata: meta, UpdatedAt: now);
            (Threads.TryGetValue(conversationId, out var list) ? list : Threads[conversationId] = []).Add(m);
            return m;
        }
    }

    public void Edit(string conversationId, string id, string body)
    {
        lock (_lock)
        {
            var list = Threads[conversationId];
            var i = list.FindIndex(m => m.Id == id);
            list[i] = list[i] with { Body = body, UpdatedAt = Tick() };
        }
    }

    public void Delete(string conversationId, string id)
    {
        lock (_lock) Threads[conversationId].RemoveAll(m => m.Id == id);
    }

    [GeneratedRegex("^/api/conversations/([^/]+)/messages$")]
    private static partial Regex ThreadPath();

    private async Task<HttpResponseMessage> RespondAsync(HttpRequestMessage request)
    {
        Interlocked.Increment(ref Requests);
        if (BeforeRespond is { } hook) await hook(request);
        if (Offline) throw new HttpRequestException("offline");
        var path = request.RequestUri!.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
        string json;
        bool allowNotModified;
        lock (_lock)
        {
            if (ThreadPath().Match(path) is { Success: true } m)
            {
                var id = Uri.UnescapeDataString(m.Groups[1].Value);
                if (Forbidden.Contains(id)) return Json(HttpStatusCode.Forbidden, """{"error":"forbidden"}""");
                if (!Threads.TryGetValue(id, out var thread)) return Json(HttpStatusCode.NotFound, """{"error":"conversation_not_found"}""");
                var ordered = thread.OrderBy(x => x.CreatedAt).ToList();
                var since = query["since"] is { } s && s.StartsWith("v1.", StringComparison.Ordinal) ? long.Parse(s[3..]) : (long?)null;
                if (!SupportsDelta)
                {
                    json = Serialize(new { messages = ordered });
                    allowNotModified = true;
                }
                else if (since is { } cursor)
                {
                    var changed = ordered.Where(x => x.UpdatedAt!.Value.ToUnixTimeMilliseconds() > cursor).ToList();
                    json = Serialize(new { messages = changed, sync = new { mode = "delta", cursor = Cursor(ordered, cursor), total = ordered.Count } });
                    allowNotModified = false;
                }
                else
                {
                    json = Serialize(new { messages = ordered, sync = new { mode = "full", cursor = Cursor(ordered, null), total = ordered.Count } });
                    allowNotModified = true;
                }
            }
            else if (path == "/api/conversations")
            {
                var filter = Enum.GetValues<InboxFilter>().First(f => WebyarApi.QueueOf(f).Count() == query.Count - 1 && WebyarApi.QueueOf(f).All(q => query[q.Key] == q.Value));
                if (query["workspace_id"] != WorkspaceId) return Json(HttpStatusCode.Forbidden, """{"error":"forbidden"}""");
                json = Serialize(new { conversations = Queues.GetValueOrDefault(filter) ?? [] });
                allowNotModified = true;
            }
            else
            {
                return Json(HttpStatusCode.NotFound, "{}");
            }
        }
        var etag = $"W/\"{Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(json)))[..16]}\"";
        if (allowNotModified && request.Headers.IfNoneMatch.Any(t => t.ToString() == etag))
        {
            Interlocked.Increment(ref NotModifiedCount);
            var nm = new HttpResponseMessage(HttpStatusCode.NotModified) { Content = new ByteArrayContent([]) };
            nm.Headers.TryAddWithoutValidation("ETag", etag);
            return nm;
        }
        var response = Json(HttpStatusCode.OK, json);
        response.Headers.TryAddWithoutValidation("ETag", etag);
        return response;
    }

    private static string Cursor(List<Message> rows, long? since)
    {
        var newest = rows.Count == 0 ? 0 : rows.Max(r => r.UpdatedAt!.Value.ToUnixTimeMilliseconds());
        return "v1." + Math.Max(newest, since ?? 0);
    }

    private HttpResponseMessage Json(HttpStatusCode status, string json)
    {
        Interlocked.Add(ref BytesSent, Encoding.UTF8.GetByteCount(json));
        return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Webyar.Core.Api.Json.Options);
}
