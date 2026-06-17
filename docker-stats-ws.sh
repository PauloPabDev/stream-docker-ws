#!/usr/bin/env bash
# Muestra en tabla los stats recibidos por WebSocket (JSON array) sin websocat.
# Requisitos: python3 + venv (estándar en la mayoría de distros).
# Uso: ./docker-stats-ws.sh [ws://host:puerto] [--sort cpu|mem]
set -Eeuo pipefail

WS_URL="${1:-ws://localhost:8081}"
SORT_BY="${2:---sort cpu}"
SORT_KEY="${SORT_BY#--sort }"   # cpu | mem
[[ "$SORT_KEY" =~ ^(cpu|mem)$ ]] || SORT_KEY="cpu"

VENV_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/docker-stats-ws-venv"
PYBIN="$VENV_DIR/bin/python"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ Necesitas python3 instalado." >&2; exit 1
fi

if [[ ! -x "$PYBIN" ]]; then
  echo "⚙️  Creando venv en $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
  "$PYBIN" -m pip install --upgrade pip >/dev/null
  "$PYBIN" -m pip install websocket-client >/dev/null
fi

# Ejecuta el cliente Python embebido
exec "$PYBIN" - "$WS_URL" "$SORT_KEY" <<'PY'
import sys, json, time, os, signal, re
from datetime import datetime
from websocket import WebSocketApp

WS_URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8081"
SORT_KEY = sys.argv[2] if len(sys.argv) > 2 else "cpu"  # 'cpu' o 'mem'

def pct_to_float(s):
    try:
        return float(str(s).strip().rstrip('%'))
    except Exception:
        return 0.0

def clear():
    # Limpia pantalla
    sys.stdout.write("\033c")
    sys.stdout.flush()

def format_table(rows):
    headers = ["NAME","CPU","MEM USAGE","%MEM","NET I/O","BLOCK I/O","PIDs"]
    # Cálculo de anchos
    cols = list(zip(*([headers] + rows))) if rows else [headers]
    widths = [max(len(str(x)) for x in col) for col in cols]
    def fmt_line(vals): return "  ".join(str(v).ljust(w) for v, w in zip(vals, widths))
    out = [fmt_line(headers)]
    out.append("-" * (sum(widths) + 2*(len(widths)-1)))
    out.extend(fmt_line(r) for r in rows)
    return "\n".join(out)

last_print = 0

def handle_message(message):
    global last_print
    try:
        data = json.loads(message)
        if not isinstance(data, list):
            data = [data]
    except Exception:
        return
    parsed = []
    for d in data:
        name = d.get("Name") or d.get("Container") or d.get("ID","")
        cpu = d.get("CPUPerc","0%")
        memu = d.get("MemUsage","")
        memp = d.get("MemPerc","0%")
        netio = d.get("NetIO","")
        blkio = d.get("BlockIO","")
        pids = str(d.get("PIDs",""))
        parsed.append({
            "name": name, "cpu": cpu, "memu": memu, "memp": memp,
            "net": netio, "blk": blkio, "pids": pids,
            "_cpu": pct_to_float(cpu), "_mem": pct_to_float(memp)
        })
    key = (lambda r: r["_cpu"]) if SORT_KEY == "cpu" else (lambda r: r["_mem"])
    parsed.sort(key=key, reverse=True)
    rows = [[p["name"], p["cpu"], p["memu"], p["memp"], p["net"], p["blk"], p["pids"]] for p in parsed]

    clear()
    print(f"Docker Stats (WebSocket): {WS_URL}   —   Ordenado por {SORT_KEY.upper()} desc")
    print("Actualizado:", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print()
    print(format_table(rows))
    print("\nCtrl+C para salir", flush=True)

def run():
    backoff = 1
    while True:
        try:
            app = WebSocketApp(
                WS_URL,
                on_message=lambda ws, msg: handle_message(msg),
                on_error=lambda ws, err: None,
                on_close=lambda ws, code, msg: None,
            )
            # Mantener vivo con pings
            app.run_forever(ping_interval=20, ping_timeout=10)
        except KeyboardInterrupt:
            break
        except Exception:
            pass
        # Reintento exponencial hasta 10s
        time.sleep(backoff)
        backoff = min(backoff * 2, 10)

def sigint_handler(sig, frame):
    clear()
    sys.exit(0)

signal.signal(signal.SIGINT, sigint_handler)

if __name__ == "__main__":
    run()
PY
