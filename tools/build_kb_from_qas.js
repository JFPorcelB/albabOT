// tools/build_kb_from_qas.js
// Convierte 4 archivos Q&A (arrays) -> kb.json con { blocks: [...] }
// Uso:
//   node .\tools\build_kb_from_qas.js --out .\kb.json
// (inputs por defecto: los 4 nombres que tú usas)

const fs = require("fs");
const path = require("path");

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const OUT = argVal("--out", ".\\kb.json");

// Tus 4 archivos (en la raíz del repo, al lado de index.html/chat.html)
const INPUTS = [
  "estrategia_es_QA_50_enriquecido.json",
  "universidades_futuro_QA_50.json",
  "autores_vs_objetivos_QA_50_enriquecido.json",
  "directrices_paises_QA_50_enriquecido.json",
];

function safeReadJSON(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function makeBlock(base, idx, item) {
  const q = normalizeText(pick(item, ["question", "q", "pregunta"]));
  const a = normalizeText(pick(item, ["answer", "answer...", "a", "respuesta"]));
  const variants = pick(item, ["variants", "variantes"]) || [];
  const tags = pick(item, ["tags", "etiquetas"]) || [];

  const doc = normalizeText(pick(item, ["doc", "document", "source_doc"])) || base;
  const section = normalizeText(pick(item, ["source_section", "section", "seccion"])) || "";
  const country = normalizeText(pick(item, ["country", "pais"])) || "";
  const timeframe = normalizeText(pick(item, ["timeframe", "periodo"])) || "";
  const audience = normalizeText(pick(item, ["audience", "publico"])) || "";

  const vText = Array.isArray(variants) && variants.length
    ? variants.map(v => `- ${normalizeText(v)}`).join("\n")
    : "";

  const metaLines = [
    country && `País: ${country}`,
    timeframe && `Periodo: ${timeframe}`,
    section && `Sección: ${section}`,
    audience && `Audiencia: ${audience}`,
    doc && `Documento: ${doc}`,
    Array.isArray(tags) && tags.length && `Tags: ${tags.map(t => normalizeText(t)).join(", ")}`,
  ].filter(Boolean);

  const text =
`Q: ${q}

A: ${a}
${vText ? `\nVariantes:\n${vText}\n` : ""}

${metaLines.length ? `Meta:\n${metaLines.map(x => `- ${x}`).join("\n")}\n` : ""}`.trim();

  return {
    id: `${base}__${String(idx + 1).padStart(3, "0")}`,
    title: q.slice(0, 140),
    source: doc,
    text,
    tags: Array.isArray(tags) ? tags : [],
    meta: { country, timeframe, section, audience, base },
  };
}

function main() {
  const root = process.cwd();
  const blocks = [];

  for (const fname of INPUTS) {
    const full = path.join(root, fname);
    if (!fs.existsSync(full)) {
      console.error(`❌ No encuentro: ${fname} (ruta: ${full})`);
      process.exit(1);
    }
    const data = safeReadJSON(full);
    if (!Array.isArray(data)) {
      console.error(`❌ ${fname} no es un array. (Tu Q&A debe ser [ {question, answer, ...}, ... ])`);
      process.exit(1);
    }
    const base = path.basename(fname, path.extname(fname));
    data.forEach((item, idx) => blocks.push(makeBlock(base, idx, item)));
  }

  const kb = {
    version: 1,
    createdAt: new Date().toISOString(),
    blocks,
  };

  fs.writeFileSync(OUT, JSON.stringify(kb, null, 2), "utf8");
  console.log(`✅ KB generada: ${OUT} | bloques: ${blocks.length}`);
}

main();

