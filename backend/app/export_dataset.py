
import csv
import sqlite3
from pathlib import Path


# Locate the project and database directories.
PROJECT_ROOT = Path(__file__).resolve().parents[2]

DATABASE_PATH = (
    PROJECT_ROOT / "backend" / "data" / "experiments.db"
)

OUTPUT_DIRECTORY = PROJECT_ROOT / "dataset" / "raw"

OUTPUT_PATH = (
    OUTPUT_DIRECTORY / "segment_measurements.csv"
)


def export_measurements():
    """Export actual experiment measurements into a CSV file."""

    if not DATABASE_PATH.exists():
        raise FileNotFoundError(
            f"Database not found: {DATABASE_PATH}"
        )

    OUTPUT_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row

    try:
        rows = connection.execute("""
            SELECT
                e.id AS experiment_id,
                e.network_mode,
                e.configured_bandwidth_mbps,
                e.started_at AS experiment_started_at,
                e.ended_at AS experiment_ended_at,

                m.observed_at,
                m.segment_number,
                m.quality_height,
                m.bytes_downloaded,
                m.download_duration_seconds,
                m.throughput_mbps,
                m.ttfb_ms,
                m.buffer_seconds,
                m.playback_position_seconds

            FROM experiments AS e

            INNER JOIN segment_measurements AS m
                ON e.id = m.experiment_id

            WHERE e.ended_at IS NOT NULL

            ORDER BY
                e.id,
                m.observed_at
        """).fetchall()

    finally:
        connection.close()

    if not rows:
        print("No completed experiment measurements found.")
        return

    fieldnames = rows[0].keys()

    with OUTPUT_PATH.open(
        "w",
        newline="",
        encoding="utf-8",
    ) as csv_file:

        writer = csv.DictWriter(
            csv_file,
            fieldnames=fieldnames,
        )

        writer.writeheader()
        writer.writerows(
            [dict(row) for row in rows]
        )

    experiment_ids = sorted({
        row["experiment_id"]
        for row in rows
    })

    print("Dataset export completed successfully.")
    print(f"Output file: {OUTPUT_PATH}")
    print(f"Total measurements: {len(rows)}")
    print(f"Experiments included: {experiment_ids}")


if __name__ == "__main__":
    export_measurements()
