// Cliente WebSocket para mostrar stats en tabla en consola
// Uso:
//   node index.js [ws://host:puerto] --token <api-token> [--sort cpu|mem] [--filter regex] [--insecure]
// Ejemplos:
//   node index.js --token abc123
//   node index.js ws://localhost:8081 --token abc123 --sort mem
//   node index.js ws://192.168.1.10:8081 --token abc123 --filter api- --sort cpu

import WebSocket from "ws";

// ---------- Parseo simple de argumentos ----------
const argv = process.argv.slice(2);
let WS_URL = "ws://149.50.140.57:8081";
let SORT = "cpu";        // cpu | mem
let FILTER = null;       // regex string
let INSECURE = false;    // para wss auto-firmado (no recomendado)
let TOKEN = null;        // token de API requerido

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("ws://") || a.startsWith("wss://")) WS_URL = a;
    else if (a === "--sort") { SORT = (argv[i + 1] || "cpu").toLowerCase(); i++; }
    else if (a === "--filter") { FILTER = argv[i + 1] || null; i++; }
    else if (a === "--insecure") { INSECURE = true; }
    else if (a === "--token") { TOKEN = argv[i + 1] || null; i++; }
}
if (!["cpu", "mem"].includes(SORT)) SORT = "cpu";

if (!TOKEN) {
    console.error("Error: se requiere --token <api-token>");
    console.error("Crea un token en el panel admin: http://localhost:8082");
    process.exit(1);
}

const filterRegex = FILTER ? new RegExp(FILTER, "i") : null;

// ---------- Utilidades de formato ----------
const pctToNumber = (s) => {
    const n = parseFloat(String(s).replace("%", "").trim());
    return Number.isFinite(n) ? n : 0;
};

const pad = (str, width) => {
    str = String(str);
    if (str.length >= width) return str;
    return str + " ".repeat(width - str.length);
};

function parseMemBytes(s) {
    const m = String(s).match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const map = { b:1, kib:1024, mib:1024**2, gib:1024**3, tib:1024**4, kb:1e3, mb:1e6, gb:1e9, tb:1e12 };
    return v * (map[m[2].toLowerCase()] || 1);
}

function fmtBytes(b) {
    if (b >= 1024**3) return (b / 1024**3).toFixed(2) + "GiB";
    if (b >= 1024**2) return (b / 1024**2).toFixed(2) + "MiB";
    return (b / 1024).toFixed(2) + "KiB";
}

function buildTable(rows, totalRow) {
    const headers = ["NAME", "CPU", "MEM USAGE", "%MEM"];
    const matrix = [headers, ...rows, totalRow];

    const widths = headers.map((_, colIdx) =>
        Math.max(...matrix.map(r => String(r[colIdx] ?? "").length))
    );

    const line = (arr) => arr.map((v, i) => pad(v, widths[i])).join("  ");
    const sepLen = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 2;

    const out = [];
    out.push(line(headers));
    out.push("-".repeat(sepLen));
    rows.forEach(r => out.push(line(r)));
    out.push("-".repeat(sepLen));
    out.push(line(totalRow));
    return out.join("\n");
}

function clearScreen() {
    process.stdout.write("\x1bc"); // clear pantalla
}

function renderTable({ containers, host }) {
    let parsed = Array.isArray(containers) ? containers : [];

    if (filterRegex) {
        parsed = parsed.filter(d => filterRegex.test(d.Name || d.Container || d.ID || ""));
    }

    const rows = parsed.map(d => [
        d.Name || d.Container || d.ID || "",
        d.CPUPerc || "0%",
        d.MemUsage || "",
        d.MemPerc || "0%",
    ]);

    const totalCpu = parsed.reduce((s, d) => s + pctToNumber(d.CPUPerc), 0);
    const totalMem = parsed.reduce((s, d) => s + parseMemBytes((d.MemUsage || "").split("/")[0].trim()), 0);
    const totalRow = [`TOTAL (${parsed.length})`, totalCpu.toFixed(1) + "%", fmtBytes(totalMem), "—"];

    clearScreen();
    const now = new Date();
    console.log(`Docker Stats (WS): ${WS_URL}  —  Ordenado por ${SORT.toUpperCase()} desc`);
    console.log(`Actualizado: ${now.toISOString().replace('T', ' ').slice(0, 19)}`);
    if (host) {
        console.log(`Host  CPU: ${host.cpuPercent}   RAM: ${host.memUsed} / ${host.memTotal} (${host.memPercent})`);
    }
    console.log();
    console.log(buildTable(rows, totalRow));
}

// ---------- Parsing robusto del mensaje ----------
function parseMessage(msg) {
    const s = msg.toString();
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return { containers: parsed, host: null };
        if (parsed.containers) return { containers: parsed.containers, host: parsed.host || null };
        return { containers: [parsed], host: null };
    } catch {
        const lines = s.split("\n").map(l => l.trim()).filter(Boolean);
        const arr = [];
        for (const ln of lines) {
            try { arr.push(JSON.parse(ln)); } catch { /* ignore */ }
        }
        return { containers: arr, host: null };
    }
}

// ---------- Conexión con reconexión ----------
let backoff = 1000; // ms
const maxBackoff = 10000;

function connect() {
    const url = `${WS_URL}?token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(url, {
        rejectUnauthorized: !INSECURE, // para wss
    });

    ws.on("open", () => {
        backoff = 1000;
        // console.log("Conectado al WS.");
    });

    ws.on("message", (data) => {
        const parsed = parseMessage(data);
        if (parsed.containers.length || parsed.host) renderTable(parsed);
    });

    ws.on("error", () => {
        // silencio para no llenar la consola
    });

    ws.on("close", () => {
        // Reintento exponencial
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
    });
}

connect();
