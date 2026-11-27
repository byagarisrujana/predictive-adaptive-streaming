
import sqlite3
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATABASE_PATH = PROJECT_ROOT / "backend" / "data" / "experiments.db"
FRONTEND_URL = "http://localhost:5173"


def print_latest_experiment():
    if not DATABASE_PATH.exists():
        print("Database not found.")
        return

    connection = sqlite3.connect(DATABASE_PATH)

    try:
        experiment = connection.execute(
            """
            SELECT id, network_mode, started_at, ended_at
            FROM experiments
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()

        if not experiment:
            print("No experiment found.")
            return

        experiment_id = experiment[0]

        count = connection.execute(
            """
            SELECT COUNT(*)
            FROM segment_measurements
            WHERE experiment_id = ?
            """,
            (experiment_id,),
        ).fetchone()[0]

        print("\n========== EXPERIMENT RESULT ==========")
        print(f"Experiment ID: {experiment_id}")
        print(f"Network mode: {experiment[1]}")
        print(f"Started at: {experiment[2]}")
        print(f"Ended at: {experiment[3]}")
        print(f"Measurements saved: {count}")
        print("=======================================\n")

    finally:
        connection.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        page = browser.new_page()

        try:
            print("Opening the streaming dashboard...")
            page.goto(FRONTEND_URL, wait_until="domcontentloaded")

            page.locator("#network-mode").wait_for(state="visible")

            print("Selecting Dynamic Network...")
            page.locator("#network-mode").select_option("dynamic")

            print("Starting experiment...")
            page.get_by_role(
                "button", name="Start Experiment"
            ).click()

            page.get_by_text(
                "Recording experiment #", exact=False
            ).wait_for(timeout=15000)

            print("Experiment started.")

            video = page.locator("video")
            video.wait_for(state="visible")

            page.wait_for_function(
                "() => document.querySelector('video')?.readyState >= 1",
                timeout=30000,
            )

            print("Starting video playback...")

            video.evaluate("""
                async (element) => {
                    element.muted = true;
                    await element.play();
                }
            """)

            print("Collecting segment measurements...")

            page.wait_for_function(
                "() => document.querySelector('video')?.ended === true",
                timeout=100000,
            )

            print("Video playback completed.")

        except PlaywrightTimeoutError as error:
            print(f"Playback or page timeout: {error}")

        except Exception as error:
            print(f"Automation error: {error}")

        finally:
            try:
                stop_button = page.get_by_role(
                    "button", name="Stop Experiment"
                )

                if stop_button.is_enabled():
                    print("Stopping experiment...")
                    stop_button.click()
                    page.wait_for_timeout(3000)

            except Exception as error:
                print(f"Could not stop through dashboard: {error}")

            browser.close()

            print_latest_experiment()


if __name__ == "__main__":
    main()
