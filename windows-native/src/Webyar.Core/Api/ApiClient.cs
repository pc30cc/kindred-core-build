using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Webyar.Core.Api;

/// <summary>
/// One HTTP client for the whole app. Bearer transport, like the iOS app: the
/// login asks for `client: "mobile"`, which the server honours only for a
/// request with no Origin header — which a native client never sends.
/// </summary>
public sealed class ApiClient : IDisposable
{
    /// <summary>The bootstrap the very first request goes to — the same one the iOS build compiles in.</summary>
    public static readonly Uri DefaultOrigin = new("https://api.webyar.ai");

    private readonly HttpClient _http;
    private readonly ISessionStore _session;
    private Uri _origin;

    public ApiClient(ISessionStore session, Uri? origin = null, HttpMessageHandler? handler = null, string? appVersion = null)
    {
        _session = session;
        _origin = origin ?? DefaultOrigin;
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = Timeout.InfiniteTimeSpan; // per request, below
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebyarWindows/{appVersion ?? "0"}");
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public Uri Origin
    {
        get => _origin;
        set => _origin = value.IsAbsoluteUri && value.Scheme == Uri.UriSchemeHttps
            ? new Uri(value.GetLeftPart(UriPartial.Authority))
            : throw new ArgumentException("The API origin must be an https URL.", nameof(value));
    }

    public bool HasSession => !string.IsNullOrEmpty(_session.Read());

    /// <summary>Raised on any 401, wherever it comes from, so the app can return to the sign-in screen.</summary>
    public event EventHandler? Unauthorized;

    public Task<T> GetAsync<T>(string path, IEnumerable<KeyValuePair<string, string?>>? query = null, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Get, path, query, body: null, ct);

    public Task<T> PostAsync<T>(string path, object? body = null, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Post, path, query: null, body, ct);

    public Task SendAsync(HttpMethod method, string path, object? body = null, IEnumerable<KeyValuePair<string, string?>>? query = null, CancellationToken ct = default) =>
        SendAsync<JsonElement?>(method, path, query, body, ct, expectBody: false);

    public async Task<byte[]> GetBytesAsync(string path, CancellationToken ct = default)
    {
        using var request = Build(HttpMethod.Get, path, null, null);
        using var response = await Execute(request, TimeSpan.FromSeconds(60), ct).ConfigureAwait(false);
        await ThrowIfFailed(response, ct).ConfigureAwait(false);
        return await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    internal async Task<T> SendAsync<T>(HttpMethod method, string path, IEnumerable<KeyValuePair<string, string?>>? query, object? body, CancellationToken ct, bool expectBody = true)
    {
        using var request = Build(method, path, query, body);
        using var response = await Execute(request, TimeSpan.FromSeconds(20), ct).ConfigureAwait(false);
        await ThrowIfFailed(response, ct).ConfigureAwait(false);
        if (!expectBody) return default!;
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return JsonSerializer.Deserialize<T>(text.Length == 0 ? "null" : text, Json.Options)!;
        }
        catch (JsonException e)
        {
            throw new ApiException(ApiFailure.Decoding, (int)response.StatusCode, inner: e);
        }
    }

    /// <summary>Signs in and keeps the Bearer token. Returns the signed-in user.</summary>
    public async Task<User> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        var result = await PostAsync<LoginResponse>("/api/auth/login", new { email, password, client = "mobile" }, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(result?.SessionToken) || result.User is null) throw new ApiException(ApiFailure.Decoding);
        _session.Write(result.SessionToken);
        return result.User;
    }

    /// <summary>Only a confirmed revocation, or a session the server no longer knows, clears the token.</summary>
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        try
        {
            await SendAsync(HttpMethod.Post, "/api/auth/logout", ct: ct).ConfigureAwait(false);
        }
        catch (ApiException e) when (e.Failure == ApiFailure.Unauthorized)
        {
        }
        _session.Write(null);
    }

    public void DiscardSession() => _session.Write(null);

    /// <summary>
    /// Asks the platform where it lives and moves there if the answer differs,
    /// as the iOS app does at launch. Returns the answer, or null if none came.
    /// </summary>
    public async Task<PlatformOrigins?> RefreshOriginAsync(CancellationToken ct = default)
    {
        try
        {
            var origins = await GetAsync<PlatformOrigins>("/api/platform/origins", ct: ct).ConfigureAwait(false);
            if (origins?.ApiBaseUrl is { } api && Uri.TryCreate(api, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
            {
                Origin = uri;
            }
            return origins;
        }
        catch (ApiException)
        {
            return null;
        }
    }

    private HttpRequestMessage Build(HttpMethod method, string path, IEnumerable<KeyValuePair<string, string?>>? query, object? body)
    {
        if (!path.StartsWith("/api/", StringComparison.Ordinal)) throw new ArgumentException("Only /api/ paths are allowed.", nameof(path));
        var url = new StringBuilder(new Uri(_origin, path).ToString());
        var first = true;
        foreach (var (key, value) in query ?? [])
        {
            if (value is null) continue;
            url.Append(first ? '?' : '&').Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(value));
            first = false;
        }
        var request = new HttpRequestMessage(method, url.ToString());
        if (_session.Read() is { Length: > 0 } token) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body, Json.Options), Encoding.UTF8, "application/json");
        }
        return request;
    }

    private async Task<HttpResponseMessage> Execute(HttpRequestMessage request, TimeSpan timeout, CancellationToken ct)
    {
        // A hung request is worse than a failed one: fail fast enough to show a retry.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            return await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException)
        {
            throw new ApiException(ApiFailure.Transport, inner: e);
        }
    }

    private async Task ThrowIfFailed(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            Unauthorized?.Invoke(this, EventArgs.Empty);
            throw new ApiException(ApiFailure.Unauthorized, 401, body: body);
        }
        string? message = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
                message = err.GetString();
        }
        catch (JsonException)
        {
        }
        throw new ApiException(ApiFailure.Server, (int)response.StatusCode, message, body);
    }

    public void Dispose() => _http.Dispose();

    private sealed record LoginResponse(
        [property: System.Text.Json.Serialization.JsonPropertyName("sessionToken")] string? SessionToken,
        User? User);
}
