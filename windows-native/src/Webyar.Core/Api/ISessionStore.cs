namespace Webyar.Core.Api;

/// <summary>
/// Where the Bearer session token lives between launches. The app stores it
/// encrypted with DPAPI for the current Windows user; tests keep it in memory.
/// </summary>
public interface ISessionStore
{
    string? Read();
    void Write(string? token);
}

public sealed class MemorySessionStore : ISessionStore
{
    private string? _token;
    public MemorySessionStore(string? token = null) => _token = token;
    public string? Read() => _token;
    public void Write(string? token) => _token = token;
}
