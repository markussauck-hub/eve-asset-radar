"""Prüft die veröffentlichte Seite ohne Login: lädt fehlerfrei, zeigt die Freigabe-Karte,
und die ESI-Abfragen, die das Radar ohne Token macht, funktionieren aus dem Browser (CORS).

    python tests/live_check.py https://markussauck-hub.github.io/eve-asset-radar/
"""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1].rstrip("/") + "/"
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1366, "height": 860})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(url)
    pg.wait_for_function("document.querySelector('#status').textContent !== 'Lade …'", timeout=30000)
    gate = pg.is_visible("#gate")
    status = pg.text_content("#status")
    esi = pg.evaluate("""async () => {
      const h = await fetch('https://esi.evetech.net/latest/markets/10000002/history/?datasource=tranquility&type_id=34');
      const p = await fetch('https://esi.evetech.net/latest/markets/19000001/history/?datasource=tranquility&type_id=44992');
      const n = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
        { method: 'POST', body: '[60003760,44992]', headers: { 'Content-Type': 'application/json' } });
      return { history: h.status + ' / ' + (await h.json()).length + ' Tage', plex: p.status + ' / ' + (await p.json()).length + ' Tage', names: n.status + ' / ' + (await n.json()).map(x => x.name).join(', ') };
    }""")
    pg.screenshot(path="live.png", full_page=True)
    b.close()

lines = [f"Freigabe-Karte sichtbar: {gate}", f"Status: {status}", f"History Tritanium (The Forge): {esi['history']}", f"History PLEX (globaler PLEX-Markt): {esi['plex']}", f"Namen: {esi['names']}"]
print("\n".join(lines))
ok = not errors and gate and esi["history"].startswith("200") and not esi["history"].startswith("200 / 0 ") and not esi["plex"].startswith("200 / 0 ") and esi["names"].startswith("200")
msg = "%0A".join(lines + ([f"JS-Fehler: {errors}"] if errors else []))
print(f"::{'notice' if ok else 'error'} title=Live-Test::{msg}")
sys.exit(0 if ok else 1)
