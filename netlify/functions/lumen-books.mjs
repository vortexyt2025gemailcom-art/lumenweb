import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";

// Huella del código de dueño (la misma que usa la página). Si creas la variable
// LUMEN_OWNER_TOKEN en Netlify, se usa esa en lugar de esta.
const OWNER = process.env.LUMEN_OWNER_TOKEN || "9c4b0ca6b8825e902855d52cc9c250e732c20a7b7d9c9fc583a16de5230b915e";
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rid = n => Array.from(randomBytes(n), b => ABC[b % 32]).join("");
const st = name => getStore({ name, consistency: "strong" });
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const okId = v => /^[A-Za-z0-9_-]{1,64}$/.test(String(v || ""));
const readAll = async s => { const { blobs } = await s.list(); return (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean); };

export default async (req) => {
  const u = new URL(req.url), a = u.searchParams.get("action"), id = u.searchParams.get("id") || "", m = req.method;
  const owner = req.headers.get("x-lumen-owner") === OWNER;
  try {
    if (a === "list" && m === "GET")
      return json((await readAll(st("meta"))).sort((x, y) => (x.created_at || 0) - (y.created_at || 0)));

    if (a === "chunk" && m === "GET") {
      const part = Number(u.searchParams.get("part") || 0);
      if (!okId(id) || !Number.isInteger(part) || part < 0) return json({ error: "bad request" }, 400);
      const [data, meta] = await Promise.all([st("chunks").get(id + "/" + part, { type: "arrayBuffer" }), st("meta").get(id, { type: "json" })]);
      if (!data) return json({ error: "not found" }, 404);
      return new Response(data, { headers: { "content-type": (meta && meta.mime_type) || "application/octet-stream", "cache-control": "public, max-age=300" } });
    }

    if (a === "upload-chunk" && m === "POST") {
      if (!owner) return json({ error: "unauthorized" }, 401);
      const fd = await req.formData(), bid = String(fd.get("id") || ""), part = Number(fd.get("part") || 0), file = fd.get("file");
      if (!okId(bid) || !file || !Number.isInteger(part) || part < 0 || part > 999) return json({ error: "bad request" }, 400);
      await st("chunks").set(bid + "/" + part, await file.arrayBuffer());
      return json({ ok: true });
    }

    if (a === "save-meta" && m === "POST") {
      if (!owner) return json({ error: "unauthorized" }, 401);
      const b = await req.json();
      if (!okId(b.id)) return json({ error: "bad request" }, 400);
      const meta = {
        id: String(b.id), type: b.type === "pdf" ? "pdf" : "html", title: String(b.title || "").slice(0, 200),
        price: String(b.price || "0"), cover: String(b.cover || ""), access_code: String(b.access_code || ""),
        is_public: true, chunks: Math.max(1, Number(b.chunks) || 1), size: Number(b.size) || 0,
        mime_type: String(b.mime_type || "application/octet-stream"), original_name: String(b.original_name || ""),
        created_at: Number(b.created_at) || Date.now()
      };
      await st("meta").setJSON(meta.id, meta);
      return json({ ok: true });
    }

    if (a === "delete" && m === "DELETE") {
      if (!owner) return json({ error: "unauthorized" }, 401);
      if (!okId(id)) return json({ error: "bad request" }, 400);
      const c = st("chunks"), { blobs } = await c.list({ prefix: id + "/" });
      await Promise.all(blobs.map(b => c.delete(b.key)));
      await st("meta").delete(id);
      return json({ ok: true });
    }

    if (a === "generate-code" && m === "POST") {
      if (!owner) return json({ error: "unauthorized" }, 401);
      const { book } = await req.json();
      if (!okId(book) || !(await st("meta").get(String(book), { type: "json" }))) return json({ error: "not found" }, 404);
      const code = rid(10);
      await st("codes").setJSON(code, { code, book: String(book), used: false, created: Date.now() });
      return json({ code });
    }

    if (a === "redeem-code" && m === "POST") {
      const { code } = await req.json(), k = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const c = k && await st("codes").get(k, { type: "json" });
      if (!c) return json({ error: "not found" }, 404);
      if (c.used) return json({ error: "used" }, 409);
      const book = await st("meta").get(c.book, { type: "json" });
      if (!book) return json({ error: "not found" }, 404);
      await st("codes").setJSON(k, { ...c, used: true, used_at: Date.now() });
      return json({ book });
    }

    if (a === "reviews" && m === "GET")
      return json((await readAll(st("reviews"))).sort((x, y) => y.ts - x.ts).map(({ author_key, ts, ...r }) => r));

    if (a === "review" && m === "POST") {
      const b = await req.json(), stars = Math.round(Number(b.stars));
      if (!(stars >= 1 && stars <= 5)) return json({ error: "bad request" }, 400);
      const r = { id: rid(12), stars, comment: String(b.comment || "").slice(0, 600), email: String(b.email || "Usuario").slice(0, 80), date: String(b.date || "").slice(0, 40), author_key: String(b.author_key || "").slice(0, 64), ts: Date.now() };
      await st("reviews").setJSON(r.id, r);
      return json({ id: r.id });
    }

    if (a === "delete-review" && m === "DELETE") {
      const s = st("reviews"), r = okId(id) && await s.get(id, { type: "json" });
      if (!r) return json({ error: "not found" }, 404);
      const au = req.headers.get("x-lumen-author");
      if (!owner && !(au && au === r.author_key)) return json({ error: "unauthorized" }, 401);
      await s.delete(id);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e && e.message) || e) }, 500);
  }
};
