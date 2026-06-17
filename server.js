import { spawn } from "child_process";
import { WebSocketServer } from "ws";
import { networkInterfaces } from "os";

const wss = new WebSocketServer({ port: 8081 });
console.log("✅ WebSocket en ws://localhost:8081");

// Obtener la IP local
const getLocalIP = () => {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

const localIP = getLocalIP();
console.log(`🌐 WebSocket también disponible en ws://${localIP}:8081`);

wss.on("connection", (ws) => {
  console.log("Cliente conectado!");

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
        .map((l) => JSON.parse(l)); // ahora sí es JSON válido
      ws.send(JSON.stringify(lines));
    });
  };

  // enviar cada 1s
  const interval = setInterval(sendStats, 1000);

  ws.on("close", () => {
    clearInterval(interval);
    console.log("Cliente desconectado");
  });
});
