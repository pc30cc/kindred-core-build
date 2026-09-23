using System.Security.Cryptography;
using System.Text;
using Webyar.Core.Api;

namespace Webyar.App.Services;

/// <summary>
/// The session token, encrypted with DPAPI for the current Windows user — the
/// desktop counterpart of the iOS Keychain. Another user, or the file copied
/// to another machine, cannot read it.
/// </summary>
public sealed class DpapiSessionStore : ISessionStore
{
    private static readonly byte[] Entropy = "Webyar.Session.v1"u8.ToArray();
    private string? _cached;
    private bool _loaded;

    public string? Read()
    {
        if (_loaded) return _cached;
        _loaded = true;
        try
        {
            if (File.Exists(AppPaths.Session))
            {
                var bytes = ProtectedData.Unprotect(File.ReadAllBytes(AppPaths.Session), Entropy, DataProtectionScope.CurrentUser);
                _cached = Encoding.UTF8.GetString(bytes);
            }
        }
        catch (Exception e) when (e is CryptographicException or IOException)
        {
            Log.Error("read session", e);
            _cached = null;
        }
        return _cached;
    }

    public void Write(string? token)
    {
        _cached = token;
        _loaded = true;
        try
        {
            if (token is null)
            {
                if (File.Exists(AppPaths.Session)) File.Delete(AppPaths.Session);
                return;
            }
            File.WriteAllBytes(AppPaths.Session, ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e) when (e is CryptographicException or IOException)
        {
            Log.Error("write session", e);
        }
    }
}
