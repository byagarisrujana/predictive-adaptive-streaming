from fastapi import FastAPI

app = FastAPI(
    title="Predictive Adaptive Video Streaming API",
    description="Backend API for AI-based adaptive video streaming optimization.",
    version="1.0.0"
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