import { createServer } from "node:http";
import { spawn } from "child_process";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { networkInterfaces, totalmem, freemem } from "os";
import { initDb, validateToken } from "./db.js";
import { adminHandler, bootstrap, isAdminSession } from "./admin.js";

initDb();
bootstrap();

const httpServer = createServer(adminHandler);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const allowed = (token && validateToken(token)) || isAdminSession(req);
  if (!allowed) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const PORT = process.env.PORT || 8081;
httpServer.listen(PORT, () => {
  const getLocalIP = () => {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "localhost";
  };
  const ip = getLocalIP();
  console.log(`WebSocket: ws://localhost:${PORT}?token=<token>`);
  console.log(`WebSocket: ws://${ip}:${PORT}?token=<token>`);
  console.log(`Admin panel: http://localhost:${PORT}/`);
});

let prevCpu = null;

function getCpuPercent() {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const parts = stat.split("\n")[0].split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    let percent = null;
    if (prevCpu) {
      const deltaIdle = idle - prevCpu.idle;
      const deltaTotal = total - prevCpu.total;
      percent = deltaTotal > 0 ? ((1 - deltaIdle / deltaTotal) * 100).toFixed(1) + "%" : "0%";
    }
    prevCpu = { idle, total };
    return percent ?? "-%";
  } catch {
    return "-%";
  }
}

function fmtBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + "GiB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + "MiB";
  return (bytes / 1024).toFixed(2) + "KiB";
}

function getHostStats() {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  return {
    cpuPercent: getCpuPercent(),
    memTotal: fmtBytes(total),
    memUsed: fmtBytes(used),
    memPercent: ((used / total) * 100).toFixed(1) + "%",
  };
}

// Single shared broadcast loop — one docker process for ALL clients.
// Starts on first connection, stops when last client disconnects.
const INTERVAL = parseInt(process.env.STATS_INTERVAL || "2000", 10);
let broadcastRunning = false;
let broadcastTimer = null;

function scheduleBroadcast() {
  if (broadcastRunning) return;
  broadcastRunning = true;

  function runOnce() {
    if (wss.clients.size === 0) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
      broadcastRunning = false;
      return;
    }

    const proc = spawn("docker", ["stats", "--no-stream", "--format", "{{json .}}"]);
    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.on("close", () => {
      if (wss.clients.size > 0) {
        try {
          const containers = output
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l));
          const payload = JSON.stringify({ containers, host: getHostStats() });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(payload);
          }
        } catch { /* ignore parse errors */ }
      }
      broadcastTimer = setTimeout(runOnce, INTERVAL);
    });
    proc.on("error", () => { broadcastTimer = setTimeout(runOnce, INTERVAL); });
  }

  runOnce();
}

wss.on("connection", (ws) => {
  console.log("Cliente conectado");
  scheduleBroadcast();
  ws.on("close", () => {
    console.log("Cliente desconectado");
  });
});
