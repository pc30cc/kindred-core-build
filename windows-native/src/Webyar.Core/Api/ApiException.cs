namespace Webyar.Core.Api;

public enum ApiFailure
{
    /// <summary>No answer: offline, DNS, TLS, timeout.</summary>
    Transport,
    /// <summary>401 — the session is gone. The only failure that signs the operator out.</summary>
    Unauthorized,
    /// <summary>Any other non-2xx. A 403 means "not this", never "sign out".</summary>
    Server,
    /// <summary>A 2xx whose body is not what the model expects.</summary>
    Decoding,
}

public sealed class ApiException : Exception
{
    public ApiException(ApiFailure failure, int? status = null, string? serverMessage = null, string? body = null, Exception? inner = null)
        : base(serverMessage ?? failure.ToString(), inner)
    {
        Failure = failure;
        Status = status;
        ServerMessage = serverMessage;
        Body = body;
    }

    public ApiFailure Failure { get; }
    public int? Status { get; }
    /// <summary>The server's own `error` string, when it sent one.</summary>
    public string? ServerMessage { get; }
    public string? Body { get; }
}
