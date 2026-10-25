"""Baut index.html des Asset Radars aus dem Price Checker (Styles, Header, Sound, EVE-SSO) + eigenen Teilen.

    python src/assemble.py ../eve-price-checker/web/index.html index.html
"""
import re
import sys
from pathlib import Path

src, out = Path(sys.argv[1]).read_text(encoding="utf-8"), Path(sys.argv[2])
here = Path(__file__).parent


def between(start, end, text=src, incl_end=False):
    i = text.index(start)
    j = text.index(end, i + len(start))
    return text[i:j + (len(end) if incl_end else 0)]


def sub1(text, old, new):
    assert text.count(old) == 1, f"nicht eindeutig/fehlt: {old[:60]!r}"
    return text.replace(old, new)


# ---- Kopf + Styles
head = src[:src.index("</style>")]
head = re.sub(r"<title>.*?</title>", "<title>EVE Asset Radar</title>", head)
head = re.sub(r'<meta name="description" content=".*?">',
              '<meta name="description" content="EVE Online: Dein Inventar auf allen Stationen – welche Items sind gerade im Preis gestiegen?">', head)

# ---- Header
header = between("<header>", "</header>", incl_end=True)
header = re.sub(r"<h1>.*?</h1>", "<h1>EVE ASSET RADAR</h1>", header)
header = re.sub(r'<div class="subtitle" id="hublist"></div>', '<div class="subtitle">Dein Inventar · Preistrend Jita</div>', header)
header = re.sub(r'<a class="btn-ghost" id="to-tool".*?</a>',
                '<a class="btn-ghost" id="to-pc" href="https://markussauck-hub.github.io/eve-price-checker/" title="Zum EVE Price Checker"><span class="arrow">⇄</span>PRICE CHECKER</a>\n'
                '        <a class="btn-ghost" id="to-ih" href="https://markussauck-hub.github.io/eve-invention-helper/" title="Zum EVE Invention Helper"><span class="arrow">⇄</span>INVENTION HELPER</a>',
                header, flags=re.S)

backdrop = between('<div class="nebula"', '<div class="app">', incl_end=True)

# ---- Skript-Bausteine
helpers = between("// ---------------------------------------------------------------- Helfer", "// ---------------------------------------------------------------- Zustand")
helpers = helpers.replace('"epc." + key', '"ear." + key')
set_status = between("function setStatus(", "\n}\n", incl_end=True)
sky = between("// ---------------------------------------------------------------- Sternenfeld", "// ---------------------------------------------------------------- ESI")
esi_get = between("async function esiGet(", "\n}\n", incl_end=True)
sound = between("// ---------------------------------------------------------------- Sound", "// ---------------------------------------------------------------- EVE SSO")
sso = between("// ---------------------------------------------------------------- EVE SSO", "\n})();\n", incl_end=True)

# EVE SSO: zusätzliche Scopes (Inventar, Strukturnamen), Scope-Prüfung, Hinweistexte
sso = sub1(sso, 'const SCOPE = "esi-skills.read_skills.v1";',
           'const SCOPE = "esi-skills.read_skills.v1 esi-assets.read_assets.v1 esi-universe.read_structures.v1";')
sso = sub1(sso, "  function emit(fresh = false) {",
           "  // Scopes stehen im Access-Token (JWT, Claim \"scp\")\n"
           "  function scopes() { try { const s = jwt(auth.access).scp; return Array.isArray(s) ? s : s ? [s] : []; } catch { return []; } }\n\n"
           "  function emit(fresh = false) {")
sso = re.sub(r"<li>Berechtigung: .*?</li>",
             "<li>Berechtigungen: <b>nur lesen</b> – Skills (<code>esi-skills.read_skills.v1</code>), Inventar (<code>esi-assets.read_assets.v1</code>) "
             "und Namen von Spieler-Strukturen (<code>esi-universe.read_structures.v1</code>). Kein Zugriff auf Wallet, Mails oder Standort, "
             "und nichts kann verschoben oder verkauft werden – CCP zeigt dir die Liste vor der Bestätigung an.</li>", sso)
sso = re.sub(r"Token und Skills bleiben im", "Token, Skills und Inventar bleiben im", sso)
sso = re.sub(r'(<a href="https://github.com/markussauck-hub/eve-invention-helper/blob/main/index.html"[^>]*>Invention Helper</a>)',
             r'\1 · <a href="https://github.com/markussauck-hub/eve-asset-radar/blob/main/index.html" target="_blank" rel="noopener">Asset Radar</a>', sso)
sso = re.sub(r'<div class="foot">Der Login ist freiwillig.*?</div>',
             '<div class="foot">Ohne Login kann das Asset Radar nichts anzeigen. Price Checker und Invention Helper funktionieren auch ohne.</div>', sso)
sso = re.sub(r'title="Optional: Skills deines Charakters automatisch übernehmen \(nur Lesezugriff auf Skills\)"',
             'title="Inventar deines Charakters lesen (nur Lesezugriff)"', sso)
sso = sub1(sso, "    ready, login, logout, state,", "    ready, login, logout, state, accessToken,\n    hasScope(s) { return !!auth && scopes().includes(s); },")

consts = '''// ---------------------------------------------------------------- Konstanten
const ESI = "https://esi.evetech.net/latest";
const ON_LINCOLNSOFT = /(^|\\.)lincolnsoft\\.de$/.test(location.hostname);
const PC_URL = ON_LINCOLNSOFT ? "/price-checker/" : "https://markussauck-hub.github.io/eve-price-checker/";
const IH_URL = ON_LINCOLNSOFT ? "/invention-helper/" : "https://markussauck-hub.github.io/eve-invention-helper/";
document.getElementById("to-pc").setAttribute("href", PC_URL);
document.getElementById("to-ih").setAttribute("href", IH_URL);
if (ON_LINCOLNSOFT) document.getElementById("to-home")?.setAttribute("href", "/");
const STATUS = { ok: "var(--pos)", busy: "var(--accent)", warn: "var(--warn)", err: "var(--neg)" };
'''

page = (head + (here / "radar.css").read_text(encoding="utf-8") + "</style>\n</head>\n<body>\n" + backdrop + "\n  " + header
        + '\n  <div class="rule"></div>\n\n' + (here / "body.html").read_text(encoding="utf-8") + "</div>\n\n<script>\n\"use strict\";\n\n"
        + consts + "\n" + helpers + set_status + "\n\n" + sky + "// ---------------------------------------------------------------- ESI\n"
        + esi_get + "\n" + sound + sso + "\n" + (here / "radar.js").read_text(encoding="utf-8") + "</script>\n</body>\n</html>\n")
out.write_text(page, encoding="utf-8")
print(f"{out}: {len(page) // 1024} KB")
