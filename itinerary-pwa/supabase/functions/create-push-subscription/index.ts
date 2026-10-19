import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("Unauthorized", { status: 401 });
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) return Response.json({ error: "Invalid subscription" }, { status: 400 });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);
  const { error } = await serviceClient.from("push_subscriptions").upsert({
    user_id: user.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth,
    expiration_time: body.expirationTime ? new Date(body.expirationTime).toISOString() : null,
    user_agent: typeof body.userAgent === "string" ? body.userAgent.slice(0, 500) : null,
  }, { onConflict: "endpoint" });
  if (error) return Response.json({ error: "Could not save subscription" }, { status: 500 });
  return Response.json({ ok: true });
});
