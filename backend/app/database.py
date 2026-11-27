
import sqlite3
from pathlib import Path


# Store the database outside the application source directory.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATABASE_DIRECTORY = PROJECT_ROOT / "data"
DATABASE_PATH = DATABASE_DIRECTORY / "experiments.db"


def get_connection():
    """Create and return a connection to the SQLite database."""
    DATABASE_DIRECTORY.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row

    return connection


def initialize_database():
    """Create tables and safely migrate existing experiment databases."""

    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS experiments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL,
                configured_bandwidth_mbps REAL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                algorithm TEXT NOT NULL DEFAULT 'unknown',
                rebuffering_event_count INTEGER NOT NULL DEFAULT 0,
                total_rebuffering_seconds REAL NOT NULL DEFAULT 0,
                quality_switch_count INTEGER NOT NULL DEFAULT 0
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS segment_measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_id INTEGER NOT NULL,
                observed_at TEXT NOT NULL,
                segment_number TEXT,
                quality_height INTEGER,
                bytes_downloaded INTEGER NOT NULL,
                download_duration_seconds REAL NOT NULL,
                throughput_mbps REAL NOT NULL,
                ttfb_ms REAL,
                buffer_seconds REAL,
                playback_position_seconds REAL,
                FOREIGN KEY (experiment_id)
                    REFERENCES experiments (id)
                    ON DELETE CASCADE
            )
        """)

        # Safely add new columns to databases created by earlier versions.
        existing_columns = {
            row["name"]
            for row in connection.execute(
                "PRAGMA table_info(experiments)"
            ).fetchall()
        }

        migrations = {
            "algorithm": (
                "ALTER TABLE experiments "
                "ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'unknown'"
            ),
            "rebuffering_event_count": (
                "ALTER TABLE experiments "
                "ADD COLUMN rebuffering_event_count INTEGER NOT NULL DEFAULT 0"
            ),
            "total_rebuffering_seconds": (
                "ALTER TABLE experiments "
                "ADD COLUMN total_rebuffering_seconds REAL NOT NULL DEFAULT 0"
            ),
            "quality_switch_count": (
                "ALTER TABLE experiments "
                "ADD COLUMN quality_switch_count INTEGER NOT NULL DEFAULT 0"
            ),
        }

        for column_name, migration_sql in migrations.items():
            if column_name not in existing_columns:
                connection.execute(migration_sql)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS
            idx_measurements_experiment_time
            ON segment_measurements (experiment_id, observed_at)
        """)

        connection.commit()
