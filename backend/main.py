import socket
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI  # noqa: E402

import auth  # noqa: E402
import capture  # noqa: E402
import checklist  # noqa: E402
import docs  # noqa: E402
import extract  # noqa: E402
import pipeline  # noqa: E402
import report  # noqa: E402
import storage  # noqa: E402
import visits  # noqa: E402
import voice  # noqa: E402


@asynccontextmanager
async def lifespan(app):
    storage.ensure_dirs()
    pipeline.start_worker()  # processes recorded pieces in the background
    yield


app = FastAPI(title="SiteSense API", lifespan=lifespan)

# Phase 1: before the visit
app.include_router(auth.router)
app.include_router(visits.router)
app.include_router(docs.router)
app.include_router(extract.router)
app.include_router(checklist.router)
# Phase 2: during and right after the visit
app.include_router(voice.router)
app.include_router(capture.router)
# Phase 3: after the visit
app.include_router(report.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/network")
def network():
    """This laptop's address on the local wifi, so a phone can open the visit pages."""
    ip = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the wifi interface
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    return {"lan_ip": ip}
