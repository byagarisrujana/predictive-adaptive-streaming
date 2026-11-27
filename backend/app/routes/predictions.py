
from pathlib import Path

import joblib
import pandas as pd

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter(
    prefix="/predictions",
    tags=["AI Predictions"],
)

APP_DIRECTORY = Path(__file__).resolve().parents[1]

MODEL_PATH = (
    APP_DIRECTORY
    / "models"
    / "throughput_model.joblib"
)
# Load the trained model once when the API module is imported.
try:
    model = joblib.load(MODEL_PATH)
except Exception as error:
    raise RuntimeError(
        f"Could not load the trained model: {MODEL_PATH}"
    ) from error


class ThroughputPredictionRequest(BaseModel):
    throughput_mbps_current: float = Field(gt=0)
    download_duration_seconds_current: float = Field(gt=0)
    ttfb_ms_current: float = Field(ge=0)
    buffer_seconds_current: float = Field(ge=0)
    quality_height_current: int = Field(gt=0)


@router.post("/throughput")
def predict_throughput(data: ThroughputPredictionRequest):

    features = pd.DataFrame([{
        "throughput_mbps_current": data.throughput_mbps_current,
        "download_duration_seconds_current": (
            data.download_duration_seconds_current
        ),
        "ttfb_ms_current": data.ttfb_ms_current,
        "buffer_seconds_current": data.buffer_seconds_current,
        "quality_height_current": data.quality_height_current,
    }])

    try:
        prediction = float(model.predict(features)[0])
        prediction = max(0.1, prediction)

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail="Throughput prediction failed.",
        ) from error

    return {
        "predicted_throughput_mbps": round(prediction, 4),
        "prediction_horizon_seconds": 5.0,
        "model": "Linear Regression",
    }

