// Replaces the old "cadetflow-push" function on launch day (deploy under that name, verify_jwt off).
// The sign-in version of the site uses "cadetflow-api"; this stops old copies of the page from
// sending parade notifications to everyone.
Deno.serve((req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  return new Response(JSON.stringify({ error: "CadetFlow was updated. Reload the page." }), { status: 410, headers });
});
