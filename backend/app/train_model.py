from pathlib import Path
import joblib
import pandas as pd
import numpy as np
from pathlib import Path
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from xgboost import XGBRegressor


PROJECT_ROOT = Path(__file__).resolve().parents[2]

DATASET_PATH = (
    PROJECT_ROOT
    / "dataset"
    / "processed"
    / "prediction_dataset.csv"
)

OUTPUT_PATH = (
    PROJECT_ROOT
    / "dataset"
    / "processed"
    / "model_evaluation.csv"
)
MODEL_PATH = (
    PROJECT_ROOT
    / "backend"
    / "app"
    / "models"
    / "throughput_model.joblib"
)

FEATURES = [
    "throughput_mbps_current",
    "download_duration_seconds_current",
    "ttfb_ms_current",
    "buffer_seconds_current",
    "quality_height_current",
]

TARGET = "target_throughput_mbps"
GROUP = "experiment_id"


def evaluate_models():

    df = pd.read_csv(DATASET_PATH)

    if df[FEATURES + [TARGET, GROUP]].isnull().any().any():
        raise ValueError("Missing values found in model data.")

    X = df[FEATURES]
    y = df[TARGET]
    groups = df[GROUP]

    models = {
        "Linear Regression": make_pipeline(
            StandardScaler(),
            LinearRegression(),
        ),

        "Random Forest": RandomForestRegressor(
            n_estimators=50,
            max_depth=3,
            min_samples_leaf=2,
            random_state=42,
        ),

        "XGBoost": XGBRegressor(
            n_estimators=30,
            max_depth=2,
            learning_rate=0.05,
            objective="reg:squarederror",
            random_state=42,
            n_jobs=1,
        ),
    }

    logo = LeaveOneGroupOut()

    predictions = {
        "experiment_id": groups.to_numpy(),
        "actual_throughput_mbps": y.to_numpy(),
        "baseline_prediction_mbps": X[
            "throughput_mbps_current"
        ].to_numpy(),
    }

    for model_name in models:
        predictions[model_name] = np.full(len(df), np.nan)

    print("Leave-One-Experiment-Out evaluation")
    print("------------------------------------")

    for train_index, test_index in logo.split(X, y, groups):

        X_train = X.iloc[train_index]
        X_test = X.iloc[test_index]

        y_train = y.iloc[train_index]

        test_experiment = groups.iloc[test_index].iloc[0]

        print(
            f"\nTesting Experiment {test_experiment}: "
            f"{len(test_index)} samples"
        )

        for model_name, model in models.items():

            model.fit(X_train, y_train)

            predicted = np.clip(model.predict(X_test), 0.1, None)

            predictions[model_name][test_index] = predicted

            print(
                f"{model_name}: "
                f"MAE = "
                f"{mean_absolute_error(y.iloc[test_index], predicted):.4f} Mbps"
            )

    results = []

    actual = predictions["actual_throughput_mbps"]

    all_models = {
        "Naive Baseline": predictions["baseline_prediction_mbps"],
        **{
            name: predictions[name]
            for name in models
        },
    }

    print("\n\nOverall out-of-experiment results")
    print("------------------------------------")

    for model_name, predicted in all_models.items():

        mae = mean_absolute_error(actual, predicted)

        rmse = np.sqrt(
            mean_squared_error(actual, predicted)
        )

        results.append({
            "model": model_name,
            "MAE_mbps": mae,
            "RMSE_mbps": rmse,
        })

        print(
            f"{model_name}: "
            f"MAE = {mae:.4f} Mbps, "
            f"RMSE = {rmse:.4f} Mbps"
        )

    prediction_df = pd.DataFrame(predictions)

    prediction_df["prediction_horizon_seconds"] = df[
        "prediction_horizon_seconds"
    ].to_numpy()

    prediction_df.to_csv(
        OUTPUT_PATH,
        index=False,
    )

    print(f"\nEvaluation predictions saved to: {OUTPUT_PATH}")

    print(
    f"\nIMPORTANT: These are preliminary results from "
    f"only {groups.nunique()} independent experiments. "
    "Do not interpret them as validated model performance."
)
def train_final_model():

    df = pd.read_csv(DATASET_PATH)

    X = df[FEATURES]
    y = df[TARGET]

    final_model = make_pipeline(
        StandardScaler(),
        LinearRegression(),
    )

    final_model.fit(X, y)

    MODEL_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    joblib.dump(final_model, MODEL_PATH)

    print("\nFinal Linear Regression model trained.")
    print(f"Model saved to: {MODEL_PATH}")
    print(f"Training samples: {len(df)}")
if __name__ == "__main__":
    evaluate_models()
    train_final_model()