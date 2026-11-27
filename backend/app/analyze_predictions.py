
import pandas as pd
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

DATASET_PATH = (
    PROJECT_ROOT
    / "dataset"
    / "processed"
    / "prediction_dataset.csv"
)

df = pd.read_csv(DATASET_PATH)

df["absolute_change_mbps"] = (
    df["target_throughput_mbps"]
    - df["throughput_mbps_current"]
).abs()

df["percentage_change"] = (
    df["absolute_change_mbps"]
    / df["throughput_mbps_current"]
) * 100

print("Throughput stability analysis\n")

print(
    df.groupby("experiment_id").agg(
        sample_count=("experiment_id", "count"),
        current_mean=("throughput_mbps_current", "mean"),
        future_mean=("target_throughput_mbps", "mean"),
        mean_absolute_change=("absolute_change_mbps", "mean"),
        mean_percentage_change=("percentage_change", "mean"),
    ).round(4).to_string()
)

print("\nOverall:")
print(
    df[
        [
            "throughput_mbps_current",
            "target_throughput_mbps",
            "absolute_change_mbps",
        ]
    ].describe().round(4).to_string()
)
