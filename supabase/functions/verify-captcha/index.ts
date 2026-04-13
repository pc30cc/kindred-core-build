import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { token, provider } = await req.json();
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "Token required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get captcha secret from runtime config
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: captchaConfig } = await supabase
      .from("app_runtime_config")
      .select("value")
      .eq("key", "captcha_provider")
      .single();

    if (!captchaConfig?.value) {
      return new Response(JSON.stringify({ success: true, message: "No captcha configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const config = captchaConfig.value as Record<string, string>;
    const captchaProvider = provider || config.provider || "turnstile";
    const secret = config.secretKey;

    if (!secret) {
      return new Response(JSON.stringify({ success: false, error: "Captcha secret not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const verifyUrl = captchaProvider === "turnstile"
      ? "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      : "https://www.google.com/recaptcha/api/siteverify";

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";

    const body = new URLSearchParams({
      secret,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
    });

    const verifyRes = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const result = await verifyRes.json();

    if (!result.success) {
      // Log captcha failure
      await supabase.from("security_events").insert({
        event_type: "captcha_failed",
        severity: "warn",
        ip_address: ip || null,
        endpoint: "/verify-captcha",
        metadata: { provider: captchaProvider, errors: result["error-codes"] },
      });
    }

    return new Response(JSON.stringify({ success: !!result.success }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
