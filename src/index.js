// AI 導入專案管理：Cloudflare Worker（提供 /api 與靜態網頁）
const COLLS = new Set(["projects", "items", "sprints", "settings"]);
const MAX_BODY = 256 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const user = await verifyAccess(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    // 寫入只接受同一網址發出的請求
    if (request.method !== "GET") {
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return json({ error: "forbidden" }, 403);
    }

    try {
      if (url.pathname === "/api/data" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT coll, id, body FROM docs").all();
        const out = { projects: [], items: [], sprints: [], settings: {} };
        for (const r of results) {
          let body;
          try { body = JSON.parse(r.body); } catch { continue; }
          if (r.coll === "settings") out.settings[r.id] = body;
          else if (out[r.coll]) out[r.coll].push({ ...body, id: r.id });
        }
        return json(out);
      }

      const m = url.pathname.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_\-]{1,100})$/);
      if (m && COLLS.has(m[1])) {
        const [, coll, id] = m;
        if (request.method === "PUT") {
          const text = await request.text();
          if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
          let body;
          try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
          if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_body" }, 400);
          delete body.id;
          await env.DB.prepare(
            "INSERT INTO docs (coll, id, body, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5) " +
              "ON CONFLICT(coll, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
          ).bind(coll, id, JSON.stringify(body), new Date().toISOString(), user.email || "").run();
          return json({ ok: true });
        }
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM docs WHERE coll = ?1 AND id = ?2").bind(coll, id).run();
          return json({ ok: true });
        }
        return json({ error: "method_not_allowed" }, 405);
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500);
    }
  },
};

/* ---------- Cloudflare Access 登入驗證 ---------- */
let jwksCache = { at: 0, team: "", keys: [] };

function teamUrl(v) {
  v = String(v || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(v) ? v : "https://" + v;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(team) {
  if (jwksCache.team === team && Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(team + "/cdn-cgi/access/certs");
  if (!r.ok) return [];
  const { keys = [] } = await r.json();
  jwksCache = { at: Date.now(), team, keys };
  return keys;
}

export async function verifyAccess(request, env) {
  // 只在本機開發（.dev.vars）時使用，正式環境不要設定
  if (env.DEV_ALLOW_NO_AUTH === "true") return { email: "dev@localhost" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const [h, p, s] = parts;
    const header = b64urlToJson(h);
    const payload = b64urlToJson(p);
    const team = teamUrl(env.TEAM_DOMAIN);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.POLICY_AUD)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 60) return null;
    if (payload.iss && teamUrl(payload.iss) !== team) return null;
    if (header.alg !== "RS256") return null;
    const jwk = (await getKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(h + "." + p));
    return ok ? { email: payload.email || "" } : null;
  } catch {
    return null;
  }
}
