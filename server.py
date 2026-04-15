"""Review API + static UI for the fleet safety demo."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Fleet Safety Review API")

app.mount("/thumbnails", StaticFiles(directory=DATA_DIR / "thumbnails"), name="thumbnails")
app.mount("/media", StaticFiles(directory=DATA_DIR), name="media")


def _load(name: str):
    path = DATA_DIR / name
    if not path.exists():
        raise HTTPException(404, f"{name} not found — run analyze.py first")
    return json.loads(path.read_text())


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/events")
def events(risk_level: str | None = None, event_type: str | None = None):
    items = _load("events.json")
    if risk_level:
        items = [e for e in items if e["risk_level"] == risk_level]
    if event_type:
        items = [e for e in items if e["event_type"] == event_type]
    return items


@app.get("/api/events/{event_id}")
def event(event_id: str):
    for ev in _load("events.json"):
        if ev["event_id"] == event_id:
            return ev
    raise HTTPException(404, "event not found")


@app.get("/api/summary")
def summary():
    return _load("summary.json")
