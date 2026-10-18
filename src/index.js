// AI 導入專案管理：Cloudflare Worker（密碼登入 + /api + 靜態網頁）
const COLLS = new Set(["projects", "items", "sprints", "settings"]);
const MAX_BODY = 256 * 1024;
const COOKIE = "aipm_session";
const SESSION_DAYS = 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.APP_PASSWORD) {
      if (url.pathname.startsWith("/api/")) return json({ error: "not_configured" }, 503);
      return page("尚未設定密碼", "<p>請依 README 執行 <code>npx wrangler secret put APP_PASSWORD</code> 設定登入密碼，再重新整理。</p>", 503);
    }

    if (url.pathname === "/login") return handleLogin(request, env, url);
    if (url.pathname === "/logout") return redirect("/login", clearCookie(url));

    const authed = await verifySession(request, env);
    if (!authed) {
      if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return redirect("/login");
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

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
          ).bind(coll, id, JSON.stringify(body), new Date().toISOString(), "owner").run();
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

/* ---------- 密碼登入 ---------- */
async function handleLogin(request, env, url) {
  if (request.method === "GET") {
    if (await verifySession(request, env)) return redirect("/");
    return loginPage(url.searchParams.has("err"));
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });

  let pw = "";
  try { pw = String((await request.formData()).get("password") || ""); } catch {}
  const ok = await safeEqual(pw, env.APP_PASSWORD);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // 放慢暴力嘗試
    return redirect("/login?err=1");
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = exp + "." + (await sign(String(exp), env.APP_PASSWORD));
  const cookie = `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
  return redirect("/", cookie);
}

async function verifySession(request, env) {
  const raw = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!/^\d+$/.test(exp || "") || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await sign(exp, env.APP_PASSWORD));
}

const enc = new TextEncoder();
async function sign(msg, password) {
  // 簽章金鑰由密碼衍生：改密碼即讓所有舊登入失效
  const keyBytes = await crypto.subtle.digest("SHA-256", enc.encode("ai-pm-session:" + password));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length === b.length;
}

function clearCookie(url) {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
}
function redirect(to, cookie) {
  const headers = { location: to, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}
function page(title, bodyHtml, status = 200) {
  return new Response(
    `<!DOCTYPE html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}｜AI 導入專案管理</title>
<style>
:root{--bg:#F1EAE0;--surface:#FBF8F3;--ink:#2A2118;--muted:#79695A;--line:#D9CDBC;--accent:#7B4F2A;--danger:#9C3B2C;--danger-soft:#F4DDD6;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#1A1410;--surface:#241C16;--ink:#ECE2D4;--muted:#A79684;--line:#3B2F26;--accent:#D4A878;--danger:#E88B78;--danger-soft:#3C1F19;color-scheme:dark}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;padding:16px;box-sizing:border-box}
.card{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
h1{font-size:1.3rem;margin:0 0 4px;font-family:"Noto Serif TC","Songti TC",serif}.sub{color:var(--muted);margin:0 0 18px;font-size:.9rem}
label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:6px}
input{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:inherit;background:transparent;color:inherit}
button{margin-top:14px;width:100%;border:0;border-radius:8px;padding:11px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{background:var(--danger-soft);color:var(--danger);border-radius:8px;padding:8px 12px;font-size:.9rem;margin-bottom:14px}
code{font-size:.9em}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}
function loginPage(err) {
  return page(
    "登入",
    `<h1>AI Projects</h1><p class="sub">請輸入密碼以繼續</p>
${err ? '<div class="err">密碼不正確，請再試一次。</div>' : ""}
<form method="post" action="/login"><label for="pw">密碼</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required><button type="submit">登入</button></form>`,
    err ? 401 : 200
  );
}
