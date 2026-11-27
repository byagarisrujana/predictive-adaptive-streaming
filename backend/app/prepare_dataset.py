
import pandas as pd
from pathlib import Path


# Project paths
PROJECT_ROOT = Path(__file__).resolve().parents[2]

INPUT_PATH = (
    PROJECT_ROOT / "dataset" / "raw" / "segment_measurements.csv"
)

OUTPUT_DIRECTORY = (
    PROJECT_ROOT / "dataset" / "processed"
)

OUTPUT_PATH = (
    OUTPUT_DIRECTORY / "prediction_dataset.csv"
)

# Accept future observations between 4.5 and 5.5 seconds.
MIN_HORIZON_SECONDS = 4.5
MAX_HORIZON_SECONDS = 5.5

# Experiment 5 was affected by a reported Wi-Fi interruption.
DISTURBED_EXPERIMENTS = {5}


def prepare_dataset():
    """Create timestamp-based future throughput prediction labels."""

    if not INPUT_PATH.exists():
        raise FileNotFoundError(
            f"Raw dataset not found: {INPUT_PATH}"
        )

    df = pd.read_csv(INPUT_PATH)

    df["observed_at"] = pd.to_datetime(
        df["observed_at"],
        utc=True,
    )

    df = df.sort_values(
        ["experiment_id", "observed_at"]
    ).reset_index(drop=True)

    prepared_rows = []

    # Features available at the time of prediction.
    feature_columns = [
        "throughput_mbps",
        "download_duration_seconds",
        "bytes_downloaded",
        "ttfb_ms",
        "buffer_seconds",
        "playback_position_seconds",
        "quality_height",
    ]

    for experiment_id, group in df.groupby("experiment_id"):

        group = group.sort_values(
            "observed_at"
        ).reset_index(drop=True)

        for current_index, current_row in group.iterrows():

            future_rows = group.iloc[current_index + 1:].copy()

            if future_rows.empty:
                continue

            future_rows["horizon_seconds"] = (
                future_rows["observed_at"]
                - current_row["observed_at"]
            ).dt.total_seconds()

            # Keep only actual observations close to five seconds ahead.
            candidates = future_rows[
                future_rows["horizon_seconds"].between(
                    MIN_HORIZON_SECONDS,
                    MAX_HORIZON_SECONDS,
                )
            ].copy()

            if candidates.empty:
                continue

            # Select the actual future observation closest to five seconds.
            candidates["distance_from_five_seconds"] = (
                candidates["horizon_seconds"] - 5.0
            ).abs()

            target_row = candidates.sort_values(
                "distance_from_five_seconds"
            ).iloc[0]

            result = {
                "experiment_id": int(experiment_id),
                "observed_at": current_row["observed_at"].isoformat(),
                "target_observed_at": target_row["observed_at"].isoformat(),
                "prediction_horizon_seconds": target_row["horizon_seconds"],
                "target_throughput_mbps": target_row["throughput_mbps"],
                "data_quality_flag": (
    "potentially_disturbed"
    if experiment_id in DISTURBED_EXPERIMENTS
    else "dynamic_simulation"
    if current_row["network_mode"] == "dynamic"
    else "controlled_simulation"
),
            }

            # Copy only information available at prediction time.
            for column in feature_columns:
                result[f"{column}_current"] = current_row[column]

            prepared_rows.append(result)

    OUTPUT_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    prepared_df = pd.DataFrame(prepared_rows)

    if prepared_df.empty:
        raise ValueError(
            "No valid prediction targets were found."
        )

    prepared_df.to_csv(
        OUTPUT_PATH,
        index=False,
    )

    print("Prediction dataset created successfully.")
    print(f"Output file: {OUTPUT_PATH}")
    print(f"Total prediction samples: {len(prepared_df)}")

    print("\nSamples per experiment:")
    print(
        prepared_df.groupby("experiment_id").size().to_string()
    )

    print("\nData quality:")
    print(
        prepared_df.groupby("data_quality_flag").size().to_string()
    )

    print("\nPrediction horizon statistics:")
    print(
        prepared_df["prediction_horizon_seconds"]
        .describe()
        .round(3)
        .to_string()
    )


if __name__ == "__main__":
    prepare_dataset()
