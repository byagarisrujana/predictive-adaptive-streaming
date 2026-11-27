
import pandas as pd

CSV_PATH = "dataset/raw/segment_measurements.csv"

df = pd.read_csv(CSV_PATH)
df["observed_at"] = pd.to_datetime(df["observed_at"])

print("Valid future targets (4–6 second window):\n")

for experiment_id, group in df.groupby("experiment_id"):
    group = group.sort_values("observed_at").reset_index(drop=True)

    valid_count = 0

    for current_time in group["observed_at"]:
        future_times = group.loc[
            group["observed_at"] > current_time,
            "observed_at",
        ]

        intervals = (
            future_times - current_time
        ).dt.total_seconds()

        if intervals.between(4, 6).any():
            valid_count += 1

    print(
        f"Experiment {experiment_id}: "
        f"{valid_count} of {len(group)} observations"
    )
