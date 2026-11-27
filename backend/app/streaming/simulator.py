
import asyncio
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field


PROJECT_ROOT = Path(__file__).resolve().parents[3]
HLS_DIRECTORY = (PROJECT_ROOT / "video" / "hls").resolve()

CHUNK_SIZE = 16 * 1024

# Default dynamic schedule: (end time in seconds, bandwidth in Mbps).
DEFAULT_DYNAMIC_BANDWIDTH_SCHEDULE = [
    (15, 5.0),
    (30, 2.0),
    (45, 0.5),
    (60, 5.0),
]

# Store the start time and schedule for each dynamic experiment.
SCENARIO_START_TIMES = {}
SCENARIO_SCHEDULES = {}

router = APIRouter()


class SchedulePhase(BaseModel):
    end_time_seconds: int = Field(gt=0)
    bandwidth_mbps: float = Field(ge=0.1, le=100)


class DynamicScheduleRequest(BaseModel):
    schedule: list[SchedulePhase] = Field(min_length=1)


def validate_hls_file(file_path: str):
    """Validate and locate a requested HLS file."""

    requested_file = (HLS_DIRECTORY / file_path).resolve()

    try:
        requested_file.relative_to(HLS_DIRECTORY)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Access denied.",
        )

    if not requested_file.is_file():
        raise HTTPException(
            status_code=404,
            detail="HLS file not found.",
        )

    if requested_file.suffix == ".m3u8":
        return requested_file, "playlist"

    if requested_file.suffix == ".ts":
        return requested_file, "segment"

    raise HTTPException(
        status_code=400,
        detail="Unsupported HLS file type.",
    )


def get_dynamic_bandwidth(
    start_time: float,
    schedule: list[tuple[int, float]],
) -> float:
    """Return the bandwidth configured for the current schedule phase."""

    elapsed = time.perf_counter() - start_time

    for end_time, bandwidth in schedule:
        if elapsed < end_time:
            return bandwidth

    # Continue using the final bandwidth after the schedule ends.
    return schedule[-1][1]


def validate_dynamic_schedule(
    schedule: list[tuple[int, float]],
) -> bool:
    """Validate the time intervals and bandwidth values."""

    if not schedule:
        return False

    previous_end_time = 0

    for end_time, bandwidth in schedule:
        if not isinstance(end_time, int) or end_time <= previous_end_time:
            return False

        if not 0.1 <= bandwidth <= 100:
            return False

        previous_end_time = end_time

    return True


def create_throttled_stream(requested_file: Path, bandwidth_getter):
    """Stream a segment while respecting bandwidth changes over time."""

    async def throttled_file_stream():
        expected_elapsed = 0.0
        start_time = time.perf_counter()

        with requested_file.open("rb") as video_file:
            while True:
                chunk = await asyncio.to_thread(
                    video_file.read,
                    CHUNK_SIZE,
                )

                if not chunk:
                    break

                bandwidth_mbps = bandwidth_getter()
                bytes_per_second = bandwidth_mbps * 1_000_000 / 8

                # Accumulate transfer time using the current bandwidth.
                expected_elapsed += len(chunk) / bytes_per_second

                actual_elapsed = time.perf_counter() - start_time
                delay = expected_elapsed - actual_elapsed

                if delay > 0:
                    await asyncio.sleep(delay)

                yield chunk

    return throttled_file_stream()


@router.post("/dynamic/{scenario_id}/schedule")
async def configure_dynamic_schedule(
    scenario_id: str,
    request: DynamicScheduleRequest,
):
    """Configure a custom bandwidth schedule for an experiment."""

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", scenario_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid scenario ID.",
        )

    schedule = [
        (phase.end_time_seconds, phase.bandwidth_mbps)
        for phase in request.schedule
    ]

    if not validate_dynamic_schedule(schedule):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid schedule. End times must increase and "
                "bandwidth must be between 0.1 and 100 Mbps."
            ),
        )

    if scenario_id in SCENARIO_START_TIMES:
        raise HTTPException(
            status_code=409,
            detail="Cannot change a schedule after the experiment has started.",
        )

    SCENARIO_SCHEDULES[scenario_id] = schedule

    return {
        "message": "Dynamic bandwidth schedule configured successfully.",
        "scenario_id": scenario_id,
        "schedule": [
            {
                "end_time_seconds": end_time,
                "bandwidth_mbps": bandwidth,
            }
            for end_time, bandwidth in schedule
        ],
    }


@router.get("/dynamic/{scenario_id}/{file_path:path}")
async def dynamic_simulated_hls(
    scenario_id: str,
    file_path: str,
):
    """Serve HLS files using an experiment-specific bandwidth schedule."""

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", scenario_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid scenario ID.",
        )

    requested_file, file_type = validate_hls_file(file_path)

    # All requests for this scenario share one start time.
    start_time = SCENARIO_START_TIMES.setdefault(
        scenario_id,
        time.perf_counter(),
    )

    # Use the experiment-specific schedule or the default schedule.
    schedule = SCENARIO_SCHEDULES.get(
        scenario_id,
        DEFAULT_DYNAMIC_BANDWIDTH_SCHEDULE,
    )

    if file_type == "playlist":
        return FileResponse(
            requested_file,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    return StreamingResponse(
        create_throttled_stream(
            requested_file,
            lambda: get_dynamic_bandwidth(start_time, schedule),
        ),
        media_type="video/mp2t",
        headers={
            "Content-Length": str(requested_file.stat().st_size),
            "Cache-Control": "no-store",
        },
    )


@router.get("/{bandwidth_mbps}/{file_path:path}")
async def simulated_hls(
    bandwidth_mbps: float,
    file_path: str,
):
    """Serve HLS files with a fixed bandwidth limit."""

    if not 0.1 <= bandwidth_mbps <= 100:
        raise HTTPException(
            status_code=400,
            detail="Bandwidth must be between 0.1 and 100 Mbps.",
        )

    requested_file, file_type = validate_hls_file(file_path)

    if file_type == "playlist":
        return FileResponse(
            requested_file,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    bytes_per_second = bandwidth_mbps * 1_000_000 / 8

    async def fixed_throttled_stream():
        bytes_sent = 0
        start_time = time.perf_counter()

        with requested_file.open("rb") as video_file:
            while True:
                chunk = await asyncio.to_thread(
                    video_file.read,
                    CHUNK_SIZE,
                )

                if not chunk:
                    break

                bytes_sent += len(chunk)

                expected_elapsed = bytes_sent / bytes_per_second
                actual_elapsed = time.perf_counter() - start_time

                delay = expected_elapsed - actual_elapsed

                if delay > 0:
                    await asyncio.sleep(delay)

                yield chunk

    return StreamingResponse(
        fixed_throttled_stream(),
        media_type="video/mp2t",
        headers={
            "Content-Length": str(requested_file.stat().st_size),
            "Cache-Control": "no-store",
        },
    )
