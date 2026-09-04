/**
 * cors-proxy-worker.js
 *
 * The official FPL API doesn't send CORS headers, so a browser page can't
 * call it directly - the request gets blocked before your JS ever sees the
 * response. This worker sits in between: the browser calls this worker,
 * the worker calls the real FPL API server-to-server (no CORS rules apply
 * there), and hands the response back with a CORS header attached.
 *
 * It is a pure pass-through - it doesn't store, log, or modify anything.
 * Whatever path you call on the worker gets called on fantasy.premierleague.com.
 *
 * Deploy (free, ~2 minutes, no credit card):
 *   1. Go to https://dash.cloudflare.com -> sign up / log in
 *   2. Workers & Pages -> Create -> Create Worker
 *   3. Delete the sample code, paste in this whole file, click Deploy
 *   4. Copy the worker's URL (looks like https://something.yourname.workers.dev)
 *   5. Paste that URL into PROXY_BASE at the top of app.js
 */

const UPSTREAM = "https://fantasy.premierleague.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Only ever forward GET requests, and only to the FPL /api/ path -
    // this worker should never be used to reach anywhere else.
    if (request.method !== "GET" || !url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }

    const target = UPSTREAM + url.pathname + url.search;

    try {
      const upstreamResponse = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; FPLNewspaperProxy/1.0)" },
      });
      const body = await upstreamResponse.arrayBuffer();
      return new Response(body, {
        status: upstreamResponse.status,
        headers: {
          "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
          "Cache-Control": "public, max-age=45",
          ...corsHeaders(),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream fetch failed", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}
