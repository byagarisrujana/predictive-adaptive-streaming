
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from database import get_connection


router = APIRouter(prefix="/experiments", tags=["Experiments"])


class ExperimentCreate(BaseModel):
    network_mode: Literal["normal", "simulated", "dynamic"]
    algorithm: Literal["ai", "hls_auto", "manual"]
    configured_bandwidth_mbps: float | None = Field(
        default=None,
        gt=0,
        le=100,
    )


class SegmentMeasurement(BaseModel):
    observed_at: datetime
    segment_number: str | None = None
    quality_height: int | None = Field(default=None, gt=0)
    bytes_downloaded: int = Field(gt=0)
    download_duration_seconds: float = Field(gt=0)
    throughput_mbps: float = Field(gt=0)
    ttfb_ms: float | None = Field(default=None, ge=0)
    buffer_seconds: float | None = Field(default=None, ge=0)
    playback_position_seconds: float | None = Field(
        default=None,
        ge=0,
    )


class RebufferingMeasurement(BaseModel):
    duration_seconds: float = Field(gt=0)


def experiment_exists(connection, experiment_id: int):
    """Check whether an experiment exists."""
    return connection.execute(
        """
        SELECT id, ended_at
        FROM experiments
        WHERE id = ?
        """,
        (experiment_id,),
    ).fetchone()


def validate_active_experiment(connection, experiment_id: int):
    """Check whether an experiment exists and is still active."""
    experiment = experiment_exists(connection, experiment_id)

    if experiment is None:
        raise HTTPException(
            status_code=404,
            detail="Experiment not found.",
        )

    if experiment["ended_at"] is not None:
        raise HTTPException(
            status_code=409,
            detail="Experiment has already been stopped.",
        )

    return experiment


@router.post("")
def start_experiment(experiment: ExperimentCreate):
    """Create a new experiment session."""

    if (
        experiment.network_mode == "normal"
        and experiment.configured_bandwidth_mbps is not None
    ):
        raise HTTPException(
            status_code=400,
            detail="Normal network experiments must not specify a bandwidth limit.",
        )

    if (
        experiment.network_mode == "simulated"
        and experiment.configured_bandwidth_mbps is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Simulated experiments require a configured bandwidth.",
        )

    if (
        experiment.network_mode == "dynamic"
        and experiment.configured_bandwidth_mbps is not None
    ):
        raise HTTPException(
            status_code=400,
            detail="Dynamic experiments use a scheduled bandwidth and must not specify a fixed limit.",
        )

    started_at = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO experiments (
                network_mode,
                configured_bandwidth_mbps,
                algorithm,
                started_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                experiment.network_mode,
                experiment.configured_bandwidth_mbps,
                experiment.algorithm,
                started_at,
            ),
        )

        experiment_id = cursor.lastrowid

    return {
        "message": "Experiment started successfully.",
        "experiment_id": experiment_id,
        "network_mode": experiment.network_mode,
        "algorithm": experiment.algorithm,
        "configured_bandwidth_mbps": experiment.configured_bandwidth_mbps,
        "started_at": started_at,
    }


@router.post("/{experiment_id}/measurements")
def save_measurement(
    experiment_id: int,
    measurement: SegmentMeasurement,
):
    """Save one completed HLS segment measurement."""

    with get_connection() as connection:
        validate_active_experiment(connection, experiment_id)

        cursor = connection.execute(
            """
            INSERT INTO segment_measurements (
                experiment_id,
                observed_at,
                segment_number,
                quality_height,
                bytes_downloaded,
                download_duration_seconds,
                throughput_mbps,
                ttfb_ms,
                buffer_seconds,
                playback_position_seconds
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                experiment_id,
                measurement.observed_at.isoformat(),
                measurement.segment_number,
                measurement.quality_height,
                measurement.bytes_downloaded,
                measurement.download_duration_seconds,
                measurement.throughput_mbps,
                measurement.ttfb_ms,
                measurement.buffer_seconds,
                measurement.playback_position_seconds,
            ),
        )

        measurement_id = cursor.lastrowid

    return {
        "message": "Segment measurement saved successfully.",
        "measurement_id": measurement_id,
        "experiment_id": experiment_id,
    }


@router.post("/{experiment_id}/rebuffering")
def record_rebuffering(
    experiment_id: int,
    measurement: RebufferingMeasurement,
):
    """Record one completed rebuffering event."""

    with get_connection() as connection:
        validate_active_experiment(connection, experiment_id)

        connection.execute(
            """
            UPDATE experiments
            SET
                rebuffering_event_count = rebuffering_event_count + 1,
                total_rebuffering_seconds =
                    total_rebuffering_seconds + ?
            WHERE id = ?
            """,
            (
                measurement.duration_seconds,
                experiment_id,
            ),
        )

    return {
        "message": "Rebuffering event recorded successfully.",
        "experiment_id": experiment_id,
        "duration_seconds": measurement.duration_seconds,
    }


@router.post("/{experiment_id}/quality-switch")
def record_quality_switch(experiment_id: int):
    """Record one actual playback quality switch."""

    with get_connection() as connection:
        validate_active_experiment(connection, experiment_id)

        connection.execute(
            """
            UPDATE experiments
            SET quality_switch_count = quality_switch_count + 1
            WHERE id = ?
            """,
            (experiment_id,),
        )

        row = connection.execute(
            """
            SELECT quality_switch_count
            FROM experiments
            WHERE id = ?
            """,
            (experiment_id,),
        ).fetchone()

    return {
        "message": "Quality switch recorded successfully.",
        "experiment_id": experiment_id,
        "quality_switch_count": row["quality_switch_count"],
    }


@router.post("/{experiment_id}/stop")
def stop_experiment(experiment_id: int):
    """Stop an experiment and record its end time."""

    ended_at = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        experiment = experiment_exists(connection, experiment_id)

        if experiment is None:
            raise HTTPException(
                status_code=404,
                detail="Experiment not found.",
            )

        if experiment["ended_at"] is not None:
            raise HTTPException(
                status_code=409,
                detail="Experiment has already been stopped.",
            )

        connection.execute(
            """
            UPDATE experiments
            SET ended_at = ?
            WHERE id = ?
            """,
            (ended_at, experiment_id),
        )

    return {
        "message": "Experiment stopped successfully.",
        "experiment_id": experiment_id,
        "ended_at": ended_at,
    }


@router.get("")
def get_experiments():
    """Retrieve experiment history with evaluation metrics."""

    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                e.id,
                e.network_mode,
                e.configured_bandwidth_mbps,
                e.algorithm,
                e.rebuffering_event_count,
                e.total_rebuffering_seconds,
                e.quality_switch_count,
                e.started_at,
                e.ended_at,
                COUNT(m.id) AS measurement_count
            FROM experiments AS e
            LEFT JOIN segment_measurements AS m
                ON e.id = m.experiment_id
            GROUP BY e.id
            ORDER BY e.id DESC
            """
        ).fetchall()

    return [dict(row) for row in rows]


@router.get("/{experiment_id}/measurements")
def get_experiment_measurements(experiment_id: int):
    """Retrieve all segment measurements for a specific experiment."""

    with get_connection() as connection:
        experiment = connection.execute(
            """
            SELECT id
            FROM experiments
            WHERE id = ?
            """,
            (experiment_id,),
        ).fetchone()

        if experiment is None:
            raise HTTPException(
                status_code=404,
                detail="Experiment not found.",
            )

        rows = connection.execute(
            """
            SELECT
                id,
                experiment_id,
                observed_at,
                segment_number,
                quality_height,
                bytes_downloaded,
                download_duration_seconds,
                throughput_mbps,
                ttfb_ms,
                buffer_seconds,
                playback_position_seconds
            FROM segment_measurements
            WHERE experiment_id = ?
            ORDER BY observed_at ASC
            """,
            (experiment_id,),
        ).fetchall()

    return [dict(row) for row in rows]
