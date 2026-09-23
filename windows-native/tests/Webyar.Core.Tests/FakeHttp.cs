using System.Net;
using System.Text;

namespace Webyar.Core.Tests;

/// <summary>Answers requests from a routing function and records what was asked.</summary>
internal sealed class FakeHttp : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, string?, (HttpStatusCode, string)> _route;
    public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = [];

    public FakeHttp(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route) => _route = route;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        Requests.Add((request, body));
        var (status, json) = _route(request, body);
        return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }
}
