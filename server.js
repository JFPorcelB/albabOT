// server.js (ESM)
// Requisitos: Node 18+
// npm i express dotenv openai pdf-parse

import "dotenv/config";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import express from "express";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Sirve estáticos desde la raíz del proyecto (para demo.html, index.html, imágenes, etc.)
app.use(express.static(process.cwd()));

const PORT = Number(process.env.PORT || 3000);
const DOCS_DIR = path.resolve("docs");
const KB_PATH = path.resolve("kb_udl.json");

// Config (ajustable por .env)
const TARGET_CHUNKS = clampInt(process.env.TARGET_CHUNKS, 150, 30, 800);
const TOP_K = clampInt(process.env.TOP_K, 10, 3, 20);
const PER_DOC_CAP = clampInt(process.env.PER_DOC_CAP, 3, 1, 10);

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-large";
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utilidades ----------
function clampInt(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeWhitespace(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function chunkByParagraphs(text, chunkSizeChars, overlapChars) {
  const parts = normalizeWhitespace(text).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";

  const push = (t) => {
    const v = t.trim();
    if (v) chunks.push(v);
  };

  for (const p of parts) {
    if (p.length > chunkSizeChars * 1.8) {
      if (cur.trim()) { push(cur); cur = ""; }
      for (let i = 0; i < p.length; i += chunkSizeChars) {
        push(p.slice(i, i + chunkSizeChars));
      }
      continue;
    }

    if ((cur.length + p.length + 2) <= chunkSizeChars) {
      cur += (cur ? "\n\n" : "") + p;
    } else {
      push(cur);
      const tail = cur.slice(Math.max(0, cur.length - overlapChars));
      cur = (tail ? tail + "\n\n" : "") + p;
    }
  }
  push(cur);
  return chunks;
}

function docSignature(files) {
  // firma simple para detectar cambios en docs/
  // (nombre + tamaño + mtimeMs)
  return files
    .map(f => `${f.name}|${f.size}|${f.mtimeMs}`)
    .sort()
    .join("::");
}

async function listDocs() {
  await fsp.mkdir(DOCS_DIR, { recursive: true });
  const names = (await fsp.readdir(DOCS_DIR))
    .filter(n => !n.startsWith("."));

  const files = [];
  for (const name of names) {
    const full = path.join(DOCS_DIR, name);
    const st = await fsp.stat(full);
    if (!st.isFile()) continue;

    const ext = path.extname(name).toLowerCase();
    if (![".pdf", ".txt", ".md"].includes(ext)) continue;

    files.push({ name, full, size: st.size, mtimeMs: st.mtimeMs, ext });
  }
  return files;
}

async function readDocText(file) {
  if (file.ext === ".pdf") {
    const buf = await fsp.readFile(file.full);
    const data = await pdfParse(buf);
    return data.text || "";
  }
  return await fsp.readFile(file.full, "utf8");
}

// ---------- OpenAI helpers ----------
async function embedBatch(texts) {
  const resp = await client.embeddings.create({
    model: EMBED_MODEL,
    input: texts
  });
  return resp.data.map(d => d.embedding);
}

async function buildKB() {
  const files = await listDocs();
  if (!files.length) {
    throw new Error("No hay documentos en /docs (PDF/TXT/MD).");
  }

  const docs = [];
  for (const f of files) {
    const raw = await readDocText(f);
    const cleaned = normalizeWhitespace(raw);
    if (cleaned.length < 80) continue;
    docs.push({ name: f.name, text: cleaned });
  }

  const totalChars = docs.reduce((acc, d) => acc + d.text.length, 0);
  const chunkSizeChars = clampInt(Math.ceil(totalChars / TARGET_CHUNKS), 1400, 800, 3200);
  const overlapChars = clampInt(Math.floor(chunkSizeChars * 0.12), 180, 80, 450);

  // Genera chunks
  const chunks = [];
  for (const d of docs) {
    const ch = chunkByParagraphs(d.text, chunkSizeChars, overlapChars);
    ch.forEach((t, i) => {
      chunks.push({
        id: `${d.name}::${i}`,
        doc: d.name,
        chunkIndex: i,
        text: t
      });
    });
  }

  // Embeddings por lotes
  const embeddings = [];
  const BATCH = 64;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map(c => c.text);
    const embs = await embedBatch(batch);
    embeddings.push(...embs);
  }

  const indexedChunks = chunks.map((c, i) => ({
    ...c,
    embedding: embeddings[i]
  }));

  const kb = {
    meta: {
      createdAt: new Date().toISOString(),
      embedModel: EMBED_MODEL,
      chatModel: CHAT_MODEL,
      targetChunks: TARGET_CHUNKS,
      chunkSizeChars,
      overlapChars,
      docCount: docs.length,
      chunkCount: indexedChunks.length,
      docsSignature: docSignature(await listDocs())
    },
    chunks: indexedChunks
  };

  // backup si existe
  if (fs.existsSync(KB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.copyFile(KB_PATH, path.resolve(`kb_udl_backup_${stamp}.json`));
  }

  await fsp.writeFile(KB_PATH, JSON.stringify(kb), "utf8");
  return kb.meta;
}

function loadKB() {
  if (!fs.existsSync(KB_PATH)) return null;
  return JSON.parse(fs.readFileSync(KB_PATH, "utf8"));
}

async function kbIsStale(kb) {
  if (!kb?.meta?.docsSignature) return true;
  const sig = docSignature(await listDocs());
  return sig !== kb.meta.docsSignature;
}

async function retrieve(kb, query) {
  const qEmb = (await embedBatch([query]))[0];

  const scored = kb.chunks
    .map(c => ({
      doc: c.doc,
      chunkIndex: c.chunkIndex,
      text: c.text,
      score: cosineSimilarity(qEmb, c.embedding)
    }))
    .sort((a, b) => b.score - a.score);

  // DIVERSIDAD: cap por documento, para evitar que se vaya todo a un PDF
  const picked = [];
  const perDoc = new Map();
  for (const s of scored) {
    const count = perDoc.get(s.doc) || 0;
    if (count >= PER_DOC_CAP) continue;
    picked.push(s);
    perDoc.set(s.doc, count + 1);
    if (picked.length >= TOP_K) break;
  }

  return picked;
}

async function answerWithContexts(question, contexts) {
  const system = [
    "Responde SOLO usando los CONTEXTOS entregados.",
    "Si falta info, dilo explícitamente y sugiere qué documento revisar.",
    "Responde con detalle (no telegráfico), usando secciones cuando ayude.",
    "Cita siempre con el formato [Documento | chunk N] al final de oraciones/párrafos relevantes.",
    "No inventes."
  ].join(" ");

  const ctx = contexts.map(c =>
    `### [${c.doc} | chunk ${c.chunkIndex}]\n${c.text}`
  ).join("\n\n");

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `CONTEXTOS:\n${ctx || "(vacío)"}\n\n` +
        `PREGUNTA:\n${question}\n\n` +
        `INSTRUCCIÓN:\nResponde en español.`
    }
  ];

  const resp = await client.responses.create({
    model: CHAT_MODEL,
    input,
    max_output_tokens: 1100
  });

  const out = (resp.output_text || "").trim();
  return out || "No pude generar una respuesta con el material disponible.";
}

// ---------- Rutas ----------
app.get("/", (req, res) => {
  // fuerza el demo “como antes”
  res.sendFile(path.resolve("demo.html"));
});

app.get("/api/status", async (req, res) => {
  const files = await listDocs();
  const kb = loadKB();
  res.json({
    docs: files.map(f => f.name),
    hasKB: !!kb,
    meta: kb?.meta || null
  });
});

app.post("/api/build", async (req, res) => {
  try {
    const meta = await buildKB();
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body?.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "Falta message." });

    let kb = loadKB();
    if (!kb) {
      // auto-build si no existe
      await buildKB();
      kb = loadKB();
    } else if (await kbIsStale(kb)) {
      // auto-rebuild si cambió /docs
      await buildKB();
      kb = loadKB();
    }

    const contexts = await retrieve(kb, message);
    const answer = await answerWithContexts(message, contexts);

    // MUY importante: NO devolvemos kb completo (evita que se “meta” al chat)
    res.json({
      ok: true,
      answer,
      sources: contexts.map(c => ({
        doc: c.doc,
        chunkIndex: c.chunkIndex,
        score: Number(c.score.toFixed(4)),
        snippet: c.text.replace(/\s+/g, " ").slice(0, 240) + (c.text.length > 240 ? "…" : "")
      })),
      meta: kb.meta
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ ALBABOT demo en http://localhost:${PORT}`);
});




