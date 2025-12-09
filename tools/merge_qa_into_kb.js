#!/usr/bin/env node
/**
 * Merge QA JSON files into an existing kb_udl.json as extra "blocks".
 * Works whether kb_udl.json is:
 *   - an Array of blocks
 *   - an Object containing { blocks: [...] }
 *
 * Usage (append):
 *   node .\tools\merge_qa_into_kb.js .\kb_udl.json .\qa1.json .\qa2.json ...
 *
 * Usage (replace existing blocks):
 *   node .\tools\merge_qa_into_kb.js --mode=replace .\kb_udl.json .\qa1.json ...
 */

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function norm(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function detectContainer(kb) {
  // returns { rootType: "array"|"object", blocks, setBlocks(newBlocks) }
  if (Array.isArray(kb)) {
    return {
      rootType: "array",
      blocks: kb,
      setBlocks: (newBlocks) => newBlocks,
    };
  }
  if (kb && typeof kb === "object") {
    if (Array.isArray(kb.blocks)) {
      return {
        rootType: "object",
        blocks: kb.blocks,
        setBlocks: (newBlocks) => {
          kb.blocks = newBlocks;
          return kb;
        },
      };
    }
  }
  // fallback: wrap as object
  const wrapped = { blocks: Array.isArray(kb) ? kb : [] };
  return {
    rootType: "object",
    blocks: wrapped.blocks,
    setBlocks: (newBlocks) => {
      wrapped.blocks = newBlocks;
      return wrapped;
    },
  };
}

function pickKey(sample, candidates, fallback) {
  for (const k of candidates) {
    if (sample && Object.prototype.hasOwnProperty.call(sample, k)) return k;
  }
  return fallback;
}

function buildQaBlockSchema(existingBlocks) {
  const sample = existingBlocks && existingBlocks.length ? existingBlocks[0] : {};
  const textKey = pickKey(sample, ["text", "content", "chunk", "body"], "text");
  const docKey  = pickKey(sample, ["doc", "source", "fuente", "file", "document"], "doc");
  const pageKey = pickKey(sample, ["p", "page", "pages", "pagina"], "p");
  const idKey   = pickKey(sample, ["id", "key", "uid"], "id");
  const tagsKey = pickKey(sample, ["tags", "etiquetas"], "tags");
  const typeKey = pickKey(sample, ["type", "kind"], "type");
  return { textKey, docKey, pageKey, idKey, tagsKey, typeKey };
}

function topicFromFilename(fp) {
  const base = path.basename(fp).toLowerCase();
  if (base.includes("estrategia")) return { topic: "estrategia_es", doc: "Estrategia ES.pdf" };
  if (base.includes("universidades") || base.includes("futuro")) return { topic: "debate_universidades_futuro", doc: "Debate universidades del futuro.pdf" };
  if (base.includes("autores")) return { topic: "autores_vs_objetivos", doc: "Autores vs Objetivos.pdf" };
  if (base.includes("directrices") || base.includes("paises") || base.includes("países")) return { topic: "directrices_paises", doc: "Directrices (paises).pdf" };
  return { topic: base.replace(/\.json$/i, ""), doc: "QA (sin doc)" };
}

function qaToBlock(qa, schema, topicInfo, n) {
  const q = qa.question || "";
  const variants = Array.isArray(qa.variants) ? qa.variants : [];
  const tags = Array.isArray(qa.tags) ? qa.tags : [];

  // Mezclamos pregunta + variantes + tags en el texto para ayudar al buscador por keywords
  const text =
`Q: ${q}
${variants.length ? `\nVariantes: ${variants.join(" | ")}` : ""}
${tags.length ? `\nTags: ${tags.join(", ")}` : ""}

A: ${qa.answer || ""}`.trim();

  const block = {};
  block[schema.idKey] = `qa-${topicInfo.topic}-${String(n).padStart(3, "0")}`;
  block[schema.typeKey] = "qa";
  block[schema.docKey] = topicInfo.doc;

  // Si viene alguna sección/capítulo en los enriquecidos, la guardamos en "p"
  const sec = qa.source_section || qa.source || qa.section || "";
  block[schema.pageKey] = sec ? String(sec) : "";

  block[schema.textKey] = text;

  if (schema.tagsKey) block[schema.tagsKey] = tags;

  // metadata para depurar (no afecta el chat)
  block._qa_meta = {
    topic: topicInfo.topic,
    question: q,
  };

  return block;
}

function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find(a => a.startsWith("--mode="));
  const mode = modeArg ? modeArg.split("=")[1] : "append";
  const cleanArgs = args.filter(a => !a.startsWith("--mode="));

  if (cleanArgs.length < 2) {
    console.error("Uso: node tools/merge_qa_into_kb.js [--mode=append|replace] <kb_udl.json> <qa1.json> [qa2.json] ...");
    process.exit(1);
  }

  const kbPath = cleanArgs[0];
  const qaPaths = cleanArgs.slice(1);

  const kb = readJson(kbPath);
  const container = detectContainer(kb);
  const schema = buildQaBlockSchema(container.blocks);

  // Dedupe por pregunta normalizada (si ya existe un Q: igual, no lo duplicamos)
  const existingKeys = new Set();
  for (const b of container.blocks) {
    const t = b[schema.textKey] || "";
    const m = String(t).match(/^\s*Q:\s*(.+)$/m);
    if (m && m[1]) existingKeys.add(norm(m[1]));
  }

  let newBlocks = mode === "replace" ? [] : [...container.blocks];
  let added = 0;

  for (const qp of qaPaths) {
    const qaList = readJson(qp);
    if (!Array.isArray(qaList)) {
      console.warn(`Saltando ${qp}: no es una lista JSON (array).`);
      continue;
    }
    const topicInfo = topicFromFilename(qp);

    for (const qa of qaList) {
      const qkey = norm(qa.question || "");
      if (!qkey) continue;
      if (existingKeys.has(qkey)) continue;

      const block = qaToBlock(qa, schema, topicInfo, added + 1);
      newBlocks.push(block);
      existingKeys.add(qkey);
      added++;
    }
  }

  // Backup automático antes de escribir
  const backupPath = `${kbPath}.bak_${nowStamp()}`;
  fs.copyFileSync(kbPath, backupPath);

  const out = container.setBlocks(newBlocks);
  writeJson(kbPath, out);

  console.log(`✅ Listo. Añadidos: ${added} QA-bloques.`);
  console.log(`🧷 Backup: ${backupPath}`);
  console.log(`📦 Total bloques ahora: ${newBlocks.length}`);
  console.log(`ℹ️ Modo: ${mode}`);
}

main();

