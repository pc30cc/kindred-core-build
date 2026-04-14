import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Verify caller is admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) throw new Error("Not authenticated");

    // Check caller has admin role
    const { data: hasAdmin } = await supabaseAdmin.rpc("has_role", {
      _user_id: caller.id,
      _role: "admin",
    });
    if (!hasAdmin) throw new Error("Insufficient permissions");

    const { action, userId, ...params } = await req.json();

    switch (action) {
      case "list_users": {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({
          page: params.page || 1,
          perPage: params.perPage || 100,
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({
            users: data.users.map((u: any) => ({
              id: u.id,
              email: u.email,
              phone: u.phone,
              banned_until: u.banned_until,
              created_at: u.created_at,
              last_sign_in_at: u.last_sign_in_at,
              email_confirmed_at: u.email_confirmed_at,
              phone_confirmed_at: u.phone_confirmed_at,
              user_metadata: u.user_metadata,
            })),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "create_user": {
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: params.email,
          password: params.password,
          email_confirm: params.emailConfirm ?? true,
          user_metadata: { full_name: params.fullName || "" },
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true, user: { id: data.user.id, email: data.user.email } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "reset_password": {
        const { data, error } = await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email: params.email,
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true, link: data?.properties?.action_link }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "update_password": {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          password: params.password,
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "disable_user": {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          ban_duration: params.disable ? "876000h" : "none",
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "confirm_email": {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          email_confirm: true,
        });
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "delete_user": {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
        if (error) throw error;
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        throw new Error("Unknown action: " + action);
    }
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
