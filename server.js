import { createServer, request as httpRequest } from "node:http";
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

// --- Host CPU via /proc/stat ---
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

function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + "GiB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + "MiB";
  if (b >= 1024) return (b / 1024).toFixed(2) + "KiB";
  return b + "B";
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

// --- Docker API over Unix socket (no subprocess) ---
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: DOCKER_SOCKET, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function parseContainerStats(container, s) {
  const name = (container.Names?.[0] ?? container.Id?.slice(0, 12) ?? "?").replace(/^\//, "");

  // CPU % — delta between current and previous sample
  const cpuDelta =
    (s.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (s.cpu_stats?.system_cpu_usage ?? 0) -
    (s.precpu_stats?.system_cpu_usage ?? 0);
  const numCpus =
    s.cpu_stats?.online_cpus ??
    s.cpu_stats?.cpu_usage?.percpu_usage?.length ??
    1;
  const cpuPct = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  // Memory (exclude page cache)
  const cache =
    s.memory_stats?.stats?.cache ??
    s.memory_stats?.stats?.inactive_file ??
    0;
  const memUsage = Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
  const memLimit = s.memory_stats?.limit ?? 0;
  const memPct = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

  // Network I/O — sum all interfaces
  const nets = Object.values(s.networks ?? {});
  const netRx = nets.reduce((a, n) => a + (n.rx_bytes ?? 0), 0);
  const netTx = nets.reduce((a, n) => a + (n.tx_bytes ?? 0), 0);

  // Block I/O
  const blk = s.blkio_stats?.io_service_bytes_recursive ?? [];
  const blkRead = blk
    .filter((x) => x.op?.toLowerCase() === "read")
    .reduce((a, x) => a + (x.value ?? 0), 0);
  const blkWrite = blk
    .filter((x) => x.op?.toLowerCase() === "write")
    .reduce((a, x) => a + (x.value ?? 0), 0);

  return {
    Name: name,
    CPUPerc: cpuPct.toFixed(2) + "%",
    MemUsage: fmtBytes(memUsage) + " / " + fmtBytes(memLimit),
    MemPerc: memPct.toFixed(2) + "%",
    NetIO: fmtBytes(netRx) + " / " + fmtBytes(netTx),
    BlockIO: fmtBytes(blkRead) + " / " + fmtBytes(blkWrite),
    PIDs: String(s.pids_stats?.current ?? 0),
  };
}

async function getDockerStats() {
  const containers = await dockerGet("/containers/json");
  if (!containers.length) return [];

  // Fetch all container stats in parallel — one-shot=true returns immediately
  // without waiting for a 1s delta window (Docker API v1.41+)
  const results = await Promise.allSettled(
    containers.map(async (c) => {
      const s = await dockerGet(
        `/containers/${c.Id}/stats?stream=false&one-shot=true`
      );
      return parseContainerStats(c, s);
    })
  );

  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

// --- Shared broadcast loop ---
// Single loop shared by all clients. Stops when no clients are connected.
const INTERVAL = parseInt(process.env.STATS_INTERVAL || "2000", 10);
let broadcastRunning = false;
let broadcastTimer = null;

function scheduleBroadcast() {
  if (broadcastRunning) return;
  broadcastRunning = true;

  async function runOnce() {
    if (wss.clients.size === 0) {
      broadcastTimer = null;
      broadcastRunning = false;
      return;
    }

    try {
      const containers = await getDockerStats();
      const payload = JSON.stringify({ containers, host: getHostStats() });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
      }
    } catch { /* ignore transient errors */ }

    broadcastTimer = setTimeout(runOnce, INTERVAL);
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
