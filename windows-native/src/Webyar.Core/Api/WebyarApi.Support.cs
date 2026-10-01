using System.Text.Json;
using Webyar.Core.Support;

namespace Webyar.Core.Api;

/// <summary>
/// Platform support, the operator's side (server/routes/platformSupport.ts).
/// camelCase both ways: bodies go out as dictionaries (whose keys the
/// snake_case policy leaves alone) and answers are read with
/// <see cref="SupportJson.Options"/>.
/// </summary>
public sealed partial class WebyarApi : ISupportApi
{
    private const string SupportBase = "/api/platform-support";

    public async Task<SupportStatus> SupportStatusAsync(CancellationToken ct = default) =>
        Read<SupportStatus>(await _client.GetAsync<JsonElement>($"{SupportBase}/status", ct: ct).ConfigureAwait(false)) ?? new SupportStatus();

    public async Task<SupportHistory> SupportHistoryAsync(CancellationToken ct = default) =>
        Read<SupportHistory>(await _client.GetAsync<JsonElement>($"{SupportBase}/history", ct: ct).ConfigureAwait(false)) ?? new SupportHistory();

    public async Task<SupportPostResult> SendSupportMessageAsync(string body, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default)
    {
        var payload = SupportBody(("body", body), ("clientMessageId", clientMessageId), ("conversationId", conversationId), ("workspaceId", workspaceId));
        return Posted(await _client.PostAsync<JsonElement>($"{SupportBase}/messages", payload, ct).ConfigureAwait(false));
    }

    public async Task<SupportPostResult> SendSupportAttachmentAsync(string fileName, string mimeType, byte[] data, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default)
    {
        var payload = SupportBody(
            ("fileName", fileName), ("mimeType", mimeType), ("data", Convert.ToBase64String(data)),
            ("clientMessageId", clientMessageId), ("conversationId", conversationId), ("workspaceId", workspaceId));
        return Posted(await _client.PostAsync<JsonElement>($"{SupportBase}/attachments", payload, ct).ConfigureAwait(false));
    }

    public Task<byte[]> SupportAttachmentDataAsync(string attachmentId, CancellationToken ct = default) =>
        _client.GetBytesAsync($"{SupportBase}/attachments/{Uri.EscapeDataString(attachmentId)}", ct);

    public async Task<SupportConversation> RateSupportConversationAsync(string conversationId, int score, string? comment, CancellationToken ct = default)
    {
        var payload = SupportBody(("score", score), ("comment", comment));
        var r = Read<SupportRatingResult>(await _client.PostAsync<JsonElement>($"{SupportBase}/conversations/{Uri.EscapeDataString(conversationId)}/rating", payload, ct).ConfigureAwait(false));
        return r?.Conversation ?? throw new ApiException(ApiFailure.Decoding);
    }

    public Task MarkSupportReadAsync(CancellationToken ct = default) =>
        _client.SendAsync(HttpMethod.Post, $"{SupportBase}/read", ct: ct);

    /// <summary>The keys that have a value; an absent conversation starts a new one.</summary>
    private static Dictionary<string, object> SupportBody(params (string Key, object? Value)[] fields)
    {
        var body = new Dictionary<string, object>();
        foreach (var (key, value) in fields)
            if (value is not null) body[key] = value;
        return body;
    }

    private static SupportPostResult Posted(JsonElement e) =>
        Read<SupportPostResult>(e) is { Conversation: not null, Item: not null } r ? r : throw new ApiException(ApiFailure.Decoding);

    internal static T? Read<T>(JsonElement e)
    {
        if (e.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return default;
        try
        {
            return e.Deserialize<T>(SupportJson.Options);
        }
        catch (JsonException ex)
        {
            throw new ApiException(ApiFailure.Decoding, inner: ex);
        }
    }

    // ISupportApi: the support chat's view of these, so it can be tested without HTTP.
    Task<SupportStatus> ISupportApi.StatusAsync(CancellationToken ct) => SupportStatusAsync(ct);
    Task<SupportHistory> ISupportApi.HistoryAsync(CancellationToken ct) => SupportHistoryAsync(ct);
    Task<SupportPostResult> ISupportApi.SendMessageAsync(string body, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct) =>
        SendSupportMessageAsync(body, clientMessageId, conversationId, workspaceId, ct);
    Task<SupportPostResult> ISupportApi.SendAttachmentAsync(string fileName, string mimeType, byte[] data, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct) =>
        SendSupportAttachmentAsync(fileName, mimeType, data, clientMessageId, conversationId, workspaceId, ct);
    Task<SupportConversation> ISupportApi.RateAsync(string conversationId, int score, string? comment, CancellationToken ct) =>
        RateSupportConversationAsync(conversationId, score, comment, ct);
    Task ISupportApi.MarkReadAsync(CancellationToken ct) => MarkSupportReadAsync(ct);
}
