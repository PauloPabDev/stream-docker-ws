import { createServer } from "node:http";
import { spawn } from "child_process";
import { WebSocketServer } from "ws";
import { networkInterfaces } from "os";
import { initDb, validateToken } from "./db.js";
import { adminHandler, bootstrap } from "./admin.js";

initDb();
bootstrap();

const httpServer = createServer(adminHandler);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  if (!token || !validateToken(token)) {
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

wss.on("connection", (ws) => {
  console.log("Cliente conectado");

  const sendStats = () => {
    const dockerStats = spawn("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
    ]);

    let output = "";
    dockerStats.stdout.on("data", (data) => {
      output += data.toString();
    });

    dockerStats.on("close", () => {
      const lines = output
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      ws.send(JSON.stringify(lines));
    });
  };

  const interval = setInterval(sendStats, 1000);

  ws.on("close", () => {
    clearInterval(interval);
    console.log("Cliente desconectado");
  });
});
