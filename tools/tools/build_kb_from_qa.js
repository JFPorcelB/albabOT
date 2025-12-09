const fs = require("fs");
const path = require("path");

// tools/build_kb_from_qa.js
// Genera kb_udl.json SOLO desde tus archivos QA (sin usar el kb viejo).


function stripBOM(s) {
    return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJSON(p) {
    const raw = stripBOM(fs.readFileSync(p, "utf8"));
    return JSON.parse(raw);
}

function fileLabel(fp) {
    return path.basename(fp).replace(/\.json$/i, "");
}

function pick(obj, keys) {
    for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
}

function asArray(x) {
    if (Array.isArray(x)) return x;
    // soporta algunos formatos alternativos
    if (x && Array.isArray(x.items)) return x.items;
    if (x && Array.isArray(x.qas)) return x.qas;
    if (x && Array.isArray(x.data)) return x.data;
    if (x && Array.isArray(x.blocks)) return x.blocks;
    return [];
}

function truncate(s, n) {
    s = String(s || "").trim().replace(/\s+/g, " ");
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}

function slug(s) {
    return String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
}

function normalizeTags(item) {
    const tags = pick(item, ["tags", "t", "keywords"]) || [];
    if (Array.isArray(tags)) return tags.map(String);
    if (typeof tags === "string") return tags.split(",").map(s => s.trim()).filter(Boolean);
    return [];
}

function buildText(item, src) {
    const q = pick(item, ["question", "q", "pregunta"]) || "";
    const a = pick(item, ["answer", "a", "respuesta"]) || "";
    const variants = pick(item, ["variants", "variantes"]) || [];
    const doc = pick(item, ["doc", "documento"]) || src;
    const section = pick(item, ["source_section", "section", "seccion"]) || "";
    const country = pick(item, ["country", "pais"]) || "";
    const timeframe = pick(item, ["timeframe"]) || "";
    const audience = pick(item, ["audience"]) || "";
    const tags = normalizeTags(item);

    const lines = [];
    lines.push(`Fuente: ${doc}`);
    if (section) lines.push(`Sección: ${section}`);
    if (country) lines.push(`País: ${country}`);
    if (timeframe) lines.push(`Periodo: ${timeframe}`);
    if (audience) lines.push(`Audiencia: ${audience}`);
    if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
    lines.push("");
    lines.push(`Pregunta: ${String(q).trim()}`);
    lines.push("");
    lines.push(`Respuesta: ${String(a).trim()}`);

    if (Array.isArray(variants) && variants.length) {
        const v = variants.map(x => String(x).trim()).filter(Boolean);
        if (v.length) {
            lines.push("");
            lines.push(`Variantes (para búsqueda): ${v.join(" | ")}`);
        }
    }

    return lines.join("\n");
}

function main() {
    const args = process.argv.slice(2);

    const outArgIdx = args.indexOf("--out");
    const outPath = outArgIdx >= 0 ? args[outArgIdx + 1] : "kb_udl.json";

    const idArgIdx = args.indexOf("--id");
    const kbId = idArgIdx >= 0 ? args[idArgIdx + 1] : "udalba_jornada_directiva";

    const createdArgIdx = args.indexOf("--created");
    const created = createdArgIdx >= 0 ? args[createdArgIdx + 1] : new Date().toISOString().slice(0, 10);

    // Si pasas --files, usa esa lista. Si no, usa defaults.
    const filesArgIdx = args.indexOf("--files");
    let files = [];
    if (filesArgIdx >= 0) {
        files = args.slice(filesArgIdx + 1).filter(s => !s.startsWith("--"));
    } else {
        files = [
            "directrices_paises_QA_50_enriquecido.json",
            "universidades_futuro_QA_50.json",
            "estrategia_es_QA_50_enriquecido.json",
            "autores_vs_objetivos_QA_50_enriquecido.json",
        ];
    }

    const blocks = [];
    const seen = new Set();

    for (const f of files) {
        const fp = path.resolve(process.cwd(), f);
        if (!fs.existsSync(fp)) {
            console.warn(`[WARN] No existe: ${f} (se omite)`);
            continue;
        }

        const src = fileLabel(fp);
        const json = readJSON(fp);
        const items = asArray(json);

        if (!items.length) {
            console.warn(`[WARN] ${f} no trae una lista (se omite)`);
            continue;
        }

        items.forEach((item, idx) => {
            const q = pick(item, ["question", "q", "pregunta"]) || "";
            const a = pick(item, ["answer", "a", "respuesta"]) || "";
            const key = `${String(q).trim()}|||${String(a).trim()}`.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            const doc = pick(item, ["doc"]) || src;
            const tags = normalizeTags(item);

            const idBase = pick(item, ["id"]) ?? (idx + 1);
            const blockId = `qa_${slug(doc)}_${idBase}`;

            blocks.push({
                id: blockId,
                title: `QA — ${truncate(q, 80)}`,
                tags: Array.from(new Set([src, ...(tags || [])])),
                source: doc,
                page_start: null,
                page_end: null,
                text: buildText(item, src),
            });
        });
    }

    const kb = {
        kb_id: kbId,
        created,
        blocks,
    };

    fs.writeFileSync(path.resolve(process.cwd(), outPath), JSON.stringify(kb, null, 2), "utf8");
    console.log(`[OK] KB creada: ${outPath}`);
    console.log(`[OK] Bloques: ${blocks.length}`);
}

main();