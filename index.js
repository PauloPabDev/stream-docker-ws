// Cliente WebSocket para mostrar stats en tabla en consola
// Uso:
//   node client.js [ws://host:puerto] [--sort cpu|mem] [--filter regex] [--insecure]
// Ejemplos:
//   node client.js
//   node client.js ws://localhost:8081 --sort mem
//   node client.js ws://192.168.1.10:8081 --filter api- --sort cpu
//   node client.js wss://tu-dominio:8081 --cacert /ruta/ca.pem (usa proxy/terminación TLS delante del WS)

import WebSocket from "ws";

// ---------- Parseo simple de argumentos ----------
const argv = process.argv.slice(2);
let WS_URL = "ws://149.50.140.57:8081";
let SORT = "cpu";        // cpu | mem
let FILTER = null;       // regex string
let INSECURE = false;    // para wss auto-firmado (no recomendado)

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("ws://") || a.startsWith("wss://")) WS_URL = a;
    else if (a === "--sort") { SORT = (argv[i + 1] || "cpu").toLowerCase(); i++; }
    else if (a === "--filter") { FILTER = argv[i + 1] || null; i++; }
    else if (a === "--insecure") { INSECURE = true; }
}
if (!["cpu", "mem"].includes(SORT)) SORT = "cpu";

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

function buildTable(rows) {
    const headers = ["NAME", "CPU", "MEM USAGE", "%MEM"];
    const matrix = [headers, ...rows];

    // calcular anchos por columna
    const widths = headers.map((_, colIdx) =>
        Math.max(...matrix.map(r => String(r[colIdx] ?? "").length))
    );

    const line = (arr) => arr.map((v, i) => pad(v, widths[i])).join("  ");
    const sepLen = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 2;

    const out = [];
    out.push(line(headers));
    out.push("-".repeat(sepLen));
    rows.forEach(r => out.push(line(r)));
    return out.join("\n");
}

function clearScreen() {
    process.stdout.write("\x1bc"); // clear pantalla
}

function renderTable(dataArray) {
    // dataArray: [{Name, CPUPerc, MemUsage, MemPerc, NetIO, BlockIO, PIDs}, ...]
    let parsed = Array.isArray(dataArray) ? dataArray : [dataArray];

    // Filtro opcional por nombre/ID
    if (filterRegex) {
        parsed = parsed.filter(d => filterRegex.test(d.Name || d.Container || d.ID || ""));
    }

    // Orden
    // parsed.sort((a, b) => {
    //     const av = SORT === "cpu" ? pctToNumber(a.CPUPerc) : pctToNumber(a.MemPerc);
    //     const bv = SORT === "cpu" ? pctToNumber(b.CPUPerc) : pctToNumber(b.MemPerc);
    //     return bv - av; // desc
    // });

    // Filas
    const rows = parsed.map(d => [
        d.Name || d.Container || d.ID || "",
        d.CPUPerc || "0%",
        d.MemUsage || "",
        d.MemPerc || "0%",
    ]);

    clearScreen();
    const now = new Date();
    console.log(`Docker Stats (WS): ${WS_URL}  —  Ordenado por ${SORT.toUpperCase()} desc`);
    console.log(`Actualizado: ${now.toISOString().replace('T', ' ').slice(0, 19)}`);
    console.log();
    console.log(buildTable(rows));
}

// ---------- Parsing robusto del mensaje ----------
function parseMessage(msg) {
    // Soporta:
    //  - Un array JSON (tu caso): [ {...}, {...} ]
    //  - Varias líneas con objetos JSON por línea
    //  - Un solo objeto JSON
    const s = msg.toString();
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        // intentar línea por línea
        const lines = s.split("\n").map(l => l.trim()).filter(Boolean);
        const arr = [];
        for (const ln of lines) {
            try { arr.push(JSON.parse(ln)); } catch { /* ignore */ }
        }
        return arr.length ? arr : [];
    }
}

// ---------- Conexión con reconexión ----------
let backoff = 1000; // ms
const maxBackoff = 10000;

function connect() {
    const ws = new WebSocket(WS_URL, {
        rejectUnauthorized: !INSECURE, // para wss
    });

    ws.on("open", () => {
        backoff = 1000;
        // console.log("Conectado al WS.");
    });

    ws.on("message", (data) => {
        const arr = parseMessage(data);
        if (arr.length) renderTable(arr);
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
