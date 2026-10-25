# EVE Asset Radar

Drittes LincolnSoft-Tool neben [EVE Price Checker](https://github.com/markussauck-hub/eve-price-checker) und [EVE Invention Helper](https://github.com/markussauck-hub/eve-invention-helper):
liest nach dem EVE-Login das Inventar des Charakters (alle Stationen, Strukturen, Container, Schiffe) und zeigt, welche Items gerade im Preis gestiegen sind.

- **Preis** = Jita-Tagesdurchschnitt (Market History The Forge) der letzten 2 Handelstage
- **Trend** = Vergleich mit dem Ø der Tage 8–30 davor, **Zuwachs** = Menge × Preisänderung
- geprüft werden nur Item-Typen ab einem Mindestwert (Standard 10 Mio ISK, höchstens 400 Typen)
- Klick auf ein Item öffnet die Hub-Preise im Price Checker

## Login

EVE SSO mit PKCE, komplett im Browser – geteilt mit den anderen Tools (gleicher Callback: Price Checker).
Scopes: `esi-skills.read_skills.v1`, `esi-assets.read_assets.v1`, `esi-universe.read_structures.v1`.
Die zusätzlichen Scopes müssen in der EVE-Developer-App freigeschaltet sein (GitHub- **und** lincolnsoft.de-App).

## Aufbau

`index.html` wird aus dem Price Checker (Styles, Header, Sound, EVE-SSO) und den Teilen in `src/` erzeugt:

    python src/assemble.py ../eve-price-checker/web/index.html index.html
