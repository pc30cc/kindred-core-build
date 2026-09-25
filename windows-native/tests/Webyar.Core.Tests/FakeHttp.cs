using System.Net;
using System.Text;

namespace Webyar.Core.Tests;

/// <summary>Answers requests from a routing function and records what was asked.</summary>
internal sealed class FakeHttp : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, string?, Task<HttpResponseMessage>> _respond;
    public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = [];

    public FakeHttp(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route) =>
        _respond = (request, body) =>
        {
            var (status, json) = route(request, body);
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        };

    /// <summary>Full control of the answer: headers, a 304, a delay.</summary>
    public FakeHttp(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) => _respond = (request, _) => respond(request);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        lock (Requests) Requests.Add((request, body));
        return await _respond(request, body);
    }
}
