
import asyncio
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse


PROJECT_ROOT = Path(__file__).resolve().parents[3]
HLS_DIRECTORY = (PROJECT_ROOT / "video" / "hls").resolve()

CHUNK_SIZE = 16 * 1024

router = APIRouter()


@router.get("/{bandwidth_mbps}/{file_path:path}")
async def simulated_hls(
    bandwidth_mbps: float,
    file_path: str,
):
    """
    Serve HLS playlists normally and throttle actual video
    segment downloads to the requested bandwidth.
    """

    if not 0.1 <= bandwidth_mbps <= 100:
        raise HTTPException(
            status_code=400,
            detail="Bandwidth must be between 0.1 and 100 Mbps.",
        )

    requested_file = (HLS_DIRECTORY / file_path).resolve()

    # Prevent requests from accessing files outside the HLS directory.
    try:
        requested_file.relative_to(HLS_DIRECTORY)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied.")

    if not requested_file.is_file():
        raise HTTPException(status_code=404, detail="HLS file not found.")

    if requested_file.suffix == ".m3u8":
        return FileResponse(
            requested_file,
            media_type="application/vnd.apple.mpegurl",
        )

    if requested_file.suffix != ".ts":
        raise HTTPException(
            status_code=400,
            detail="Unsupported HLS file type.",
        )

    bytes_per_second = bandwidth_mbps * 1_000_000 / 8

    async def throttled_file_stream():
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

                # Pace each chunk according to the configured
                # bandwidth rather than sending the file immediately.
                expected_elapsed = bytes_sent / bytes_per_second
                actual_elapsed = time.perf_counter() - start_time

                delay = expected_elapsed - actual_elapsed

                if delay > 0:
                    await asyncio.sleep(delay)

                yield chunk

    return StreamingResponse(
        throttled_file_stream(),
        media_type="video/mp2t",
        headers={
            "Content-Length": str(requested_file.stat().st_size),
            "Cache-Control": "no-store",
        },
    )
