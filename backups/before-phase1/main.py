from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
import asyncio
import json
import time
import uuid
import random

app = FastAPI()

# In-memory player store. Protected by players_lock for concurrency.
players = {}
players_lock = asyncio.Lock()

TICK_RATE = 20  # ticks per second
TICK_INTERVAL = 1.0 / TICK_RATE
SPEED = 120.0  # pixels per second


@app.get("/status")
async def status():
    async with players_lock:
        return {"status": "ok", "players": len(players)}


@app.post("/join")
async def join():
    """Simple lobby join: returns a short player id and ws url hint."""
    pid = str(uuid.uuid4())[:8]
    return {"player_id": pid, "ws_url": "ws://localhost:8000/ws"}


@app.get("/")
async def index():
    return FileResponse("index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    # Allow client to provide desired player_id via query, otherwise assign one.
    pid = websocket.query_params.get("player_id") or str(uuid.uuid4())[:8]

    spawn_x = random.randint(50, 650)
    spawn_y = random.randint(50, 450)

    async with players_lock:
        players[pid] = {
            "id": pid,
            "x": float(spawn_x),
            "y": float(spawn_y),
            "facing": "down",
            "state": "idle",
            "input": {"up": False, "down": False, "left": False, "right": False},
            "ws": websocket,
        }

    # Send init message with assigned id
    await websocket.send_json({"type": "init", "id": pid})

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except Exception:
                continue

            if msg.get("type") == "input":
                inp = msg.get("input", {})
                async with players_lock:
                    if pid in players:
                        players[pid]["input"] = {
                            "up": bool(inp.get("up", False)),
                            "down": bool(inp.get("down", False)),
                            "left": bool(inp.get("left", False)),
                            "right": bool(inp.get("right", False)),
                        }
    except WebSocketDisconnect:
        async with players_lock:
            if pid in players:
                try:
                    # remove websocket and player
                    del players[pid]
                except Exception:
                    pass


@app.on_event("startup")
async def start_tick_loop():
    asyncio.create_task(tick_loop())


async def tick_loop():
    """Main server tick: update player positions and broadcast state."""
    while True:
        t0 = time.time()
        snapshot = []
        # Update positions
        async with players_lock:
            for p in players.values():
                inp = p.get("input", {})
                dx = (1 if inp.get("right") else 0) - (1 if inp.get("left") else 0)
                dy = (1 if inp.get("down") else 0) - (1 if inp.get("up") else 0)
                if dx != 0 or dy != 0:
                    p["state"] = "walking"
                    mag = (dx * dx + dy * dy) ** 0.5
                    if mag != 0:
                        vx = dx / mag * SPEED * TICK_INTERVAL
                        vy = dy / mag * SPEED * TICK_INTERVAL
                        p["x"] += vx
                        p["y"] += vy
                        # clamp to a simple world bounds
                        p["x"] = max(0, min(800, p["x"]))
                        p["y"] = max(0, min(600, p["y"]))
                        # update facing based on movement
                        if abs(vx) > abs(vy):
                            p["facing"] = "right" if vx > 0 else "left"
                        else:
                            p["facing"] = "down" if vy > 0 else "up"
                else:
                    p["state"] = "idle"

            # prepare snapshot
            for p in players.values():
                snapshot.append({
                    "id": p["id"],
                    "x": p["x"],
                    "y": p["y"],
                    "facing": p["facing"],
                    "state": p["state"],
                })

            # broadcast to all websockets
            webs = [p["ws"] for p in players.values() if p.get("ws")]

        if webs:
            msg = {"type": "state", "players": snapshot}
            for ws in webs:
                try:
                    await ws.send_json(msg)
                except Exception:
                    # ignore send errors; cleanup happens on disconnect
                    pass

        elapsed = time.time() - t0
        await asyncio.sleep(max(0, TICK_INTERVAL - elapsed))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level="info")
