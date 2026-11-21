
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from streaming.simulator import router as simulator_router

# Locate the project's generated HLS video directory.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
HLS_DIRECTORY = PROJECT_ROOT / "video" / "hls"

app = FastAPI(
    title="Predictive Adaptive Video Streaming API",
    description="Backend API for AI-based adaptive video streaming optimization.",
    version="1.0.0"
)
app.include_router(simulator_router, prefix="/simulated-hls")
# Allow the React development server to communicate with FastAPI.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve HLS playlists and video segments over HTTP.
app.mount(
    "/hls",
    StaticFiles(directory=str(HLS_DIRECTORY)),
    name="hls"
)


@app.get("/")
def root():
    return {
        "message": "Predictive Adaptive Streaming Backend is running!",
        "status": "success"
    }


@app.get("/health")
def health_check():
    return {
        "status": "healthy"
    }
