"""Capture a representative admin screenshot with multiple detections."""
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
OUT = Path(__file__).parent / "docs" / "screenshots"

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
        )
        page = ctx.new_page()
        page.goto(f"{BASE}/", wait_until="domcontentloaded")

        best_path = OUT / "admin.png"
        best_count = 0

        for attempt in range(8):
            time.sleep(8)
            # Check detection count by reading page content
            counters = page.query_selector_all("[class*='counterValue'], [class*='statValue']")
            det_el = page.locator("text=/^\\d+$/ >> nth=0").first
            
            # Just take a screenshot and check via the API
            resp = page.request.get(f"{BASE}/api/live/status")
            status = resp.json()
            
            # Take screenshot
            tmp = OUT / f"admin_attempt_{attempt}.png"
            page.screenshot(path=str(tmp), full_page=False)
            print(f"  Attempt {attempt}: events={status.get('event_count', 0)}, frames={status.get('frames_read', 0)}")

            # Keep the latest one (most data accumulated)
            if attempt >= 4:
                import shutil
                shutil.copy(str(tmp), str(best_path))
                print(f"  -> Saved as admin.png")
                # Clean up attempts
                for i in range(attempt + 1):
                    (OUT / f"admin_attempt_{i}.png").unlink(missing_ok=True)
                break

            tmp.unlink(missing_ok=True)

        browser.close()
        print("Done!")

if __name__ == "__main__":
    main()
