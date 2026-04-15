"""Capture representative screenshots for the README."""
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
OUT = Path(__file__).parent / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
        )

        # --- 1. Admin screenshot ---
        print("Capturing admin page…")
        page = ctx.new_page()
        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        time.sleep(25)
        page.screenshot(path=str(OUT / "admin.png"), full_page=False)
        print(f"  Saved admin.png")
        page.close()

        # --- 2. Dashboard screenshot ---
        print("Capturing dashboard page…")
        page = ctx.new_page()
        page.goto(f"{BASE}/dashboard", wait_until="domcontentloaded")
        time.sleep(15)
        page.screenshot(path=str(OUT / "dashboard.png"), full_page=False)
        print(f"  Saved dashboard.png")

        # --- 3. Tests screenshot (trigger test run, wait, capture with drawer open) ---
        print("Triggering test run…")
        resp = page.request.post(f"{BASE}/api/tests/run")
        print(f"  Test run response: {resp.status}")
        
        # Wait for tests to complete
        for i in range(30):
            time.sleep(2)
            status_resp = page.request.get(f"{BASE}/api/tests/status")
            status = status_resp.json()
            state = status.get("status", "idle")
            progress = status.get("progress", 0)
            total = status.get("total", 0)
            print(f"  Test status: {state} ({progress}/{total})")
            if state in ("passed", "failed"):
                break
        
        # Open the test drawer by clicking the test badge
        time.sleep(1)
        page.reload(wait_until="domcontentloaded")
        time.sleep(3)
        
        # Click the test badge to open the test drawer
        test_badge = page.locator("text=Passed").first
        if test_badge.is_visible():
            test_badge.click()
            time.sleep(1)
        else:
            # Try clicking via the tests badge area
            badge = page.locator("[class*='testBadge'], [class*='TestBadge']").first
            if badge.is_visible():
                badge.click()
                time.sleep(1)
        
        page.screenshot(path=str(OUT / "tests.png"), full_page=False)
        print(f"  Saved tests.png")
        page.close()
        
        browser.close()
        print("Done!")

if __name__ == "__main__":
    main()
