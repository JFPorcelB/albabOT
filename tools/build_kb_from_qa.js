// tools/build_kb_from_qa.js
// Construye kb_udl.json a partir de archivos *_QA_*.json (solo QAs)
// Uso:
//   node .\tools\build_kb_from_qa.js --out .\kb_udl.json
//   node .\tools\build_kb_from_qa.js --out .\kb_udl.json --in a.json b.json c.json d.json
//
// Por defecto busca en la carpeta actual todos los .json que:
//   - contengan "QA" en el nombre (case-insensitive)
//   - NO empiecen con "kb_"

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { out: "kb_udl.json", dir: process.cwd(), inFiles: [] };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--in") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.inFiles.push(argv[++i]);
    }
  }
  return args;
}

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  // Limpia BOM si existiera
  const text = raw.replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function normalizeQaItem(item) {
  if (!item || typeof item !== "object") return null;

  const question = (item.question || item.q || "").toString().trim();
  const answer = (item.answer || item.a || "").toString().trim();

  if (!question || !answer) return null;

  const variants = Array.isArray(item.variants) ? item.variants : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];

  return {
    question,
    answer,
    variants,
    tags,
    doc: item.doc || item.document || item.sourceDoc || null,
    source_section: item.source_section || item.section || null,
    country: item.country || null,
    timeframe: item.timeframe || null,
    audience: item.audience || null,
  };
}

function fileBaseName(fp) {
  return path.basename(fp).replace(/\.json$/i, "");
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const key = (b.question + "\n" + b.answer).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.dir);

  let inputs = args.inFiles && args.inFiles.length ? args.inFiles : null;

  if (!inputs) {
    const all = fs.readdirSync(rootDir);
    inputs = all
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .filter((f) => /qa/i.test(f))
      .filter((f) => !/^kb_/i.test(f))
      .map((f) => path.join(rootDir, f));
  } else {
    inputs = inputs.map((f) => path.isAbsolute(f) ? f : path.join(rootDir, f));
  }

  if (!inputs.length) {
    console.error("No encontré archivos QA. Asegúrate de tener archivos tipo *_QA_*.json en la carpeta.");
    process.exit(1);
  }

  const blocks = [];
  let totalQa = 0;

  for (const fp of inputs) {
    if (!fs.existsSync(fp)) {
      console.warn("⚠️ No existe:", fp);
      continue;
    }

    const data = safeReadJson(fp);
    const base = fileBaseName(fp);

    // esperamos array de QAs
    const arr = Array.isArray(data) ? data
      : Array.isArray(data.items) ? data.items
      : Array.isArray(data.qa) ? data.qa
      : null;

    if (!arr) {
      console.warn(`⚠️ ${base}: el JSON no es un array (ni tiene .items/.qa). Se salta.`);
      continue;
    }

    let nOk = 0;
    arr.forEach((item, idx) => {
      const qa = normalizeQaItem(item);
      if (!qa) return;

      nOk++;
      totalQa++;

      const id = `${base}_${String(idx + 1).padStart(3, "0")}`;

      // Importante: "text" incluye P+R para que el buscador encuentre mejor
      blocks.push({
        id,
        title: qa.question,
        question: qa.question,
        answer: qa.answer,
        text: `${qa.question}\n\n${qa.answer}`,
        variants: qa.variants,
        tags: qa.tags,
        source: qa.doc || base,
        source_section: qa.source_section,
        country: qa.country,
        timeframe: qa.timeframe,
        audience: qa.audience,
        dataset: base,
        type: "qa",
      });
    });

    console.log(`✅ ${base}: ${nOk} QAs`);
  }

  const finalBlocks = dedupeBlocks(blocks);

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(rootDir, args.out);
  fs.writeFileSync(outPath, JSON.stringify(finalBlocks, null, 2), "utf8");

  console.log("—");
  console.log(`Listo: ${finalBlocks.length} bloques -> ${outPath}`);
}

main();



