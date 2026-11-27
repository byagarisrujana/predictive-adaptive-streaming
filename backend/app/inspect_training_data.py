
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

print("Dataset shape:", df.shape)

print("\nColumns:")
for column in df.columns:
    print("-", column)

print("\nSamples per experiment:")
print(df.groupby("experiment_id").size())

print("\nTarget throughput statistics:")
print(
    df["target_throughput_mbps"]
    .describe()
    .round(3)
)

print("\nPrediction horizon statistics:")
print(
    df["prediction_horizon_seconds"]
    .describe()
    .round(3)
)

print("\nFirst five samples:")
print(df.head().to_string(index=False))
