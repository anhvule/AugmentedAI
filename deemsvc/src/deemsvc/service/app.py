from __future__ import annotations

from fastapi import FastAPI

from .registry import RunRegistry

app = FastAPI(title="deemsvc")
app.state.registry = RunRegistry()


@app.get("/health")
async def health() -> dict:
    return {"ok": True}
