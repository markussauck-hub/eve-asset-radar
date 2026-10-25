
// ---------------------------------------------------------------- Asset Radar
const FORGE = 10000002;
const ASSET_SCOPE = "esi-assets.read_assets.v1";
const STRUCT_SCOPE = "esi-universe.read_structures.v1";
const MAX_TYPES = 400;            // höchstens so viele Item-Typen mit History prüfen (Ladezeit)
const PAR = 6;                    // gleichzeitige ESI-Abfragen
const PAGE = 200;                 // Tabellenzeilen pro "Mehr anzeigen"
const DAY = 86400000;

let SCAN = null;                  // { char, at, positions: [...], types: Map }
let scanToken = 0, sortKey = store.get("sort", "chg"), sortDir = store.get("dir", -1), shown = PAGE;
const HUBS = [
  { name: "Jita",    station: 60003760, region: 10000002 },
  { name: "Amarr",   station: 60008494, region: 10000043 },
  { name: "Dodixie", station: 60011866, region: 10000032 },
  { name: "Rens",    station: 60004588, region: 10000030 },
];
const hubCache = new Map();       // typeId -> { t, hubs: [{ buy, sell }] | null } – 5 Minuten
const hubPending = new Set();
let hubTimer = 0;
const histCache = new Map();      // typeId -> Metrik (1 h)
const nameCache = new Map();      // id -> Name (Typen, Stationen, Systeme, Strukturen)

const fmtShort = (n) => {
  const u = [[1e12, "Bio"], [1e9, "Mrd"], [1e6, "Mio"], [1e3, "Tsd"]].find(([v]) => Math.abs(n) >= v);
  return u ? `${(n / u[0]).toLocaleString("de-DE", { maximumSignificantDigits: 3 })} ${u[1]}` : fmt(Math.round(n));
};
const fmtPrice = (n) => n == null ? "–" : n >= 1e6 ? `${fmtShort(n)} ISK` : fmtIsk(n);
const fmtPct = (p) => p == null ? "–" : `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toLocaleString("de-DE", { maximumFractionDigits: Math.abs(p) < .1 ? 1 : 0 })} %`;

// parallel mit Begrenzung, Fortschritt per Callback
async function pool(items, n, fn, onStep) {
  let i = 0, done = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; }
      onStep?.(++done, items.length);
    }
  }));
  return out;
}

// ESI mit Token (Inventar, Strukturen)
async function esiAuth(url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await EveSSO.accessToken()}` } });
    if (res.ok) return res;
    if (res.status === 401) throw new Error("Token ungültig – bitte neu anmelden");
    if (res.status === 403) { const e = new Error("kein Zugriff"); e.status = 403; throw e; }
    if (attempt >= 3 || ![420, 429, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
    await sleep(1000 * attempt);
  }
}

async function loadAssets(charId) {
  const url = (p) => `${ESI}/characters/${charId}/assets/?datasource=tranquility&page=${p}`;
  const first = await esiAuth(url(1));
  let all = await first.json();
  const pages = Number(first.headers.get("X-Pages")) || 1;
  for (let p = 2; p <= pages; p++) all = all.concat(await (await esiAuth(url(p))).json());
  return all;
}

// Namen für Typen, NPC-Stationen und Systeme (ohne Token, 1000 je Abfrage)
async function resolveNames(ids) {
  const todo = [...new Set(ids)].filter((id) => !nameCache.has(id));
  for (let i = 0; i < todo.length; i += 1000) {
    const chunk = todo.slice(i, i + 1000);
    try {
      const res = await fetch(`${ESI}/universe/names/?datasource=tranquility`, { method: "POST", body: JSON.stringify(chunk), headers: { "Content-Type": "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const e of await res.json()) nameCache.set(e.id, e.name);
    } catch {
      // eine ungültige ID lässt den ganzen Block scheitern -> einzeln nachfragen
      if (chunk.length > 1) await pool(chunk, PAR, (id) => resolveNames([id]));
      else nameCache.set(chunk[0], `#${chunk[0]}`);
    }
  }
}

async function structureName(id) {
  if (nameCache.has(id)) return nameCache.get(id);
  let name;
  try { name = (await (await esiAuth(`${ESI}/universe/structures/${id}/?datasource=tranquility`)).json()).name; }
  catch { name = `Struktur #${id} (Name nicht freigegeben)`; }
  nameCache.set(id, name);
  return name;
}

// Preis-Trend aus der Jita-History
async function trend(typeId) {
  const hit = histCache.get(typeId);
  if (hit && Date.now() - hit.t < 3600000) return hit.m;
  const rows = await (await esiGet(`${ESI}/markets/${FORGE}/history/?datasource=tranquility&type_id=${typeId}`)).json();
  const m = { now: null, base: null, chg: null, spark: [], lastDate: null };
  if (rows.length) {
    const last = rows[rows.length - 1], lastT = Date.parse(last.date);
    m.lastDate = last.date;
    const wavg = (rs) => { const v = rs.reduce((a, r) => a + r.volume, 0); return v ? rs.reduce((a, r) => a + r.average * r.volume, 0) / v : null; };
    const inRange = (from, to) => rows.filter((r) => { const t = Date.parse(r.date); return t > lastT - from * DAY && t <= lastT - to * DAY; });
    if (Date.now() - lastT < 8 * DAY) m.now = wavg(inRange(2, 0));
    m.base = wavg(inRange(30, 7));
    if (m.now != null && m.base) m.chg = m.now / m.base - 1;
    m.spark = inRange(30, -1).map((r) => r.average);
  }
  histCache.set(typeId, { t: Date.now(), m });
  return m;
}

// Live-Preise an den 4 Handelszentren (nur Orders direkt an der Station, wie im Price Checker)
async function hubPrices(typeId) {
  if (typeId === 44992) return null;                        // PLEX: nur im globalen PLEX-Markt
  return Promise.all(HUBS.map(async (h) => {
    const url = (p) => `${ESI}/markets/${h.region}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${p}`;
    const first = await esiGet(url(1));
    let orders = await first.json();
    const pages = Number(first.headers.get("X-Pages")) || 1;
    for (let p = 2; p <= pages; p++) orders = orders.concat(await (await esiGet(url(p))).json());
    orders = orders.filter((o) => o.location_id === h.station);
    const buys = orders.filter((o) => o.is_buy_order).map((o) => o.price), sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price);
    return { buy: buys.length ? Math.max(...buys) : null, sell: sells.length ? Math.min(...sells) : null };
  }));
}

// fehlende Hub-Preise für die angezeigten Typen nachladen; Tabelle wird gebündelt neu gezeichnet
function ensureHubs(types) {
  const fresh = (t) => { const c = hubCache.get(t); return c && Date.now() - c.t < 5 * 60000; };
  const todo = [...new Set(types)].filter((t) => !hubPending.has(t) && !fresh(t));
  if (!todo.length) return;
  todo.forEach((t) => hubPending.add(t));
  pool(todo, 3, async (t) => {
    try { hubCache.set(t, { t: Date.now(), hubs: await hubPrices(t) }); }
    catch (e) { hubCache.set(t, { t: Date.now(), hubs: undefined, error: String(e.message || e) }); }
    finally { hubPending.delete(t); }
  }, () => { clearTimeout(hubTimer); hubTimer = setTimeout(render, 300); });
}

const fmtHub = (n) => n == null ? "–" : n >= 1e6 ? fmtShort(n) : n.toLocaleString("de-DE", { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });

function hubCell(r, i, sc) {
  const c = hubCache.get(r.type);
  if (!c) return `<td class="hub hide-s${sc}"><span class="dim">…</span></td>`;
  if (c.hubs === null) return i === 0 ? `<td class="hub plex hide-s${sc}" colspan="4"><span class="dim">nur im globalen PLEX-Markt</span></td>` : "";
  if (!c.hubs) return `<td class="hub hide-s${sc}"><span class="dim" title="${esc(c.error || "")}">Fehler</span></td>`;
  const h = c.hubs[i], best = Math.max(...c.hubs.map((x) => x.buy ?? -1));
  return `<td class="hub hide-s${sc}" title="${HUBS[i].name}: höchstes Buy (Sofortverkauf) ${fmtHub(h.buy)} ISK · niedrigstes Sell ${fmtHub(h.sell)} ISK">
        <span class="hb${h.buy != null && h.buy === best && best > 0 ? " best" : ""}">${fmtHub(h.buy)}</span><span class="hs">${fmtHub(h.sell)}</span></td>`;
}

function hubMobile(r) {
  const c = hubCache.get(r.type);
  if (!c) return `<td class="hubs-m"><span class="dim">Hub-Preise laden …</span></td>`;
  if (c.hubs === null) return `<td class="hubs-m"><span class="dim">Hubs: nur im globalen PLEX-Markt</span></td>`;
  if (!c.hubs) return `<td class="hubs-m"><span class="dim">Hub-Preise: Fehler</span></td>`;
  const best = Math.max(...c.hubs.map((x) => x.buy ?? -1));
  return `<td class="hubs-m">${c.hubs.map((h, i) => `<span class="${h.buy != null && h.buy === best && best > 0 ? "best" : ""}"><i>${HUBS[i].name}</i>${fmtHub(h.buy)}</span>`).join("")}</td>`;
}

function spark(vals, chg) {
  if (vals.length < 2) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals), w = 90, h = 24;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 2 - (hi > lo ? (v - lo) / (hi - lo) : .5) * (h - 4)).toFixed(1)}`).join(" ");
  const col = chg == null ? "var(--muted)" : chg >= 0 ? "var(--pos)" : "var(--neg)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

const isStation = (id) => id >= 60000000 && id < 64000000;
const isSystem = (id) => id >= 30000000 && id < 33000000;

async function scan(force = false) {
  const st = EveSSO.state();
  if (!st.char || !EveSSO.hasScope(ASSET_SCOPE)) return;
  const token = ++scanToken;
  const minVal = Number($("minval").value);
  $("prog").hidden = false; prog(0);
  Sound.computeStart();
  try {
    // 1) Inventar
    setStatus(`Lade Inventar von ${st.char.name} …`, "busy");
    if (force || !SCAN || SCAN.char !== st.char.id || Date.now() - SCAN.at > 15 * 60000) {
      const assets = await loadAssets(st.char.id);
      if (token !== scanToken) return;
      SCAN = { char: st.char.id, at: Date.now(), assets };
    }
    const assets = SCAN.assets;
    const byItem = new Map(assets.map((a) => [a.item_id, a]));

    // 2) Ort bestimmen: Container/Schiffe bis zur Station/Struktur hochlaufen
    const groups = new Map();
    for (const a of assets) {
      if (a.is_blueprint_copy) continue;
      let cur = a, parent = null;
      for (let i = 0; i < 12 && byItem.has(cur.location_id); i++) { cur = byItem.get(cur.location_id); parent ??= cur; }
      const loc = cur.location_id;
      const key = `${a.type_id}:${loc}`;
      const g = groups.get(key) || { type: a.type_id, loc, qty: 0, via: new Set(), assembled: false, flag: cur.location_flag };
      g.qty += a.quantity;
      if (parent) g.via.add(parent.type_id);
      if (a.is_singleton) g.assembled = true;
      groups.set(key, g);
    }

    // 3) Grobwert über ESI-Durchschnittspreise -> nur relevante Typen per History prüfen
    setStatus("Lade Durchschnittspreise …", "busy");
    const prices = new Map((await (await esiGet(`${ESI}/markets/prices/?datasource=tranquility`)).json()).map((p) => [p.type_id, p.average_price ?? p.adjusted_price ?? 0]));
    const typeVal = new Map();
    for (const g of groups.values()) typeVal.set(g.type, (typeVal.get(g.type) || 0) + g.qty * (prices.get(g.type) || 0));
    const cand = [...typeVal.entries()].filter(([, v]) => v >= minVal && v > 0).sort((a, b) => b[1] - a[1]);
    const skipped = Math.max(0, cand.length - MAX_TYPES);
    const types = cand.slice(0, MAX_TYPES).map(([t]) => t);
    const typeSet = new Set(types);

    // 4) Namen
    setStatus("Löse Namen auf …", "busy");
    const pos = [...groups.values()].filter((g) => typeSet.has(g.type));
    await resolveNames([...types, ...pos.flatMap((g) => [...g.via]),
      ...pos.map((g) => g.loc).filter((l) => isStation(l) || isSystem(l))]);
    const structs = [...new Set(pos.map((g) => g.loc).filter((l) => l > 1e12))];
    if (structs.length) {
      if (EveSSO.hasScope(STRUCT_SCOPE)) await pool(structs, PAR, structureName);
      else structs.forEach((id) => nameCache.set(id, `Struktur #${id}`));
    }
    if (token !== scanToken) return;

    // 5) Preistrend je Typ
    const metrics = new Map();
    await pool(types, PAR, async (t) => metrics.set(t, await trend(t)), (d, n) => {
      if (token !== scanToken) return;
      prog(d / n); setStatus(`Prüfe Preistrends … ${d} / ${n}`, "busy");
      if (d % 4 === 0) Sound.blip?.();
    });
    if (token !== scanToken) return;

    SCAN.rows = pos.map((g) => {
      const m = metrics.get(g.type) || {};
      const price = m.now ?? null;
      const locName = g.loc === 2004 ? "Asset Safety"
        : isSystem(g.loc) ? `${nameCache.get(g.loc) || g.loc} (im All)`
        : nameCache.get(g.loc) || (g.loc > 1e12 ? `Struktur #${g.loc}` : `#${g.loc}`);
      return {
        type: g.type, name: nameCache.get(g.type) || `#${g.type}`, loc: locName,
        via: [...g.via].map((t) => nameCache.get(t) || `#${t}`), assembled: g.assembled, qty: g.qty,
        price, value: price != null ? price * g.qty : null, chg: m.chg ?? null,
        est: g.qty * (prices.get(g.type) || 0),           // Grobwert (ESI-Durchschnitt), falls kein Jita-Preis
        gain: price != null && m.base ? (price - m.base) * g.qty : null, spark: m.spark || [], error: m.error,
      };
    });
    SCAN.skipped = skipped; SCAN.checked = types.length;
    shown = PAGE;
    render();
    const errs = SCAN.rows.filter((r) => r.error).length;
    Sound.computeStop(errs ? "err" : "ok");
    const t = new Date(SCAN.at).toLocaleTimeString("de-DE");
    setStatus(`Bereit · ${fmt(assets.length)} Inventar-Einträge · ${fmt(types.length)} Item-Typen geprüft` +
      (skipped ? ` (weitere ${fmt(skipped)} unter dem Wert der Top ${MAX_TYPES} übersprungen)` : "") +
      (errs ? ` · ${errs} Preisabfragen fehlgeschlagen` : "") + ` · Inventar geladen ${t}`, errs ? "warn" : "ok");
  } catch (e) {
    Sound.computeStop("err");
    if (token === scanToken) setStatus(`Fehler: ${String(e.message || e)}`, "err");
  } finally {
    if (token === scanToken) $("prog").hidden = true;
  }
}

function prog(f) { $("prog").firstElementChild.style.width = `${Math.round(f * 100)}%`; }

function render() {
  if (!SCAN?.rows) return;
  const q = $("q").value.trim().toLowerCase();
  const onlyUp = $("onlyup").checked, upMin = Number($("upmin").value) / 100;
  // Mindestwert gilt auch je Zeile: Kleinstapel einer wertvollen Sorte (z. B. 24 Stück Erz) werden ausgeblendet
  const minVal = Number($("minval").value);
  const big = (r) => (r.value ?? r.est) >= minVal;
  const small = SCAN.rows.filter((r) => !big(r)).length;
  let rows = SCAN.rows.filter((r) => big(r) && (!q || r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q))
    && (!onlyUp || (r.chg != null && r.chg >= upMin)));
  const val = (r) => sortKey === "name" || sortKey === "loc" ? r[sortKey].toLowerCase()
    : /^h\d$/.test(sortKey) ? hubCache.get(r.type)?.hubs?.[Number(sortKey[1])]?.buy ?? null : r[sortKey];
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });

  $("sortsel").value = `${sortKey}:${sortDir}`;
  document.querySelectorAll("#rt th[data-k]").forEach((th) => {
    if (th.dataset.k === sortKey) th.setAttribute("aria-sort", sortDir < 0 ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
  });

  const cls = (v) => v == null ? "dim" : v >= 0 ? "pos" : "neg";
  const sc = (k) => k === sortKey ? " sorted" : "";      // Sortierspalte hervorheben
  $("rows").innerHTML = rows.slice(0, shown).map((r) => `
    <tr>
      <td class="it${sc("name")}"><a href="${PC_URL}#${r.type}" title="Hub-Preise im Price Checker"><img src="https://images.evetech.net/types/${r.type}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${esc(r.name)}</a>${r.assembled ? `<span class="tag" title="zusammengebaut – vor dem Verkauf umpacken">ASSEMBLED</span>` : ""}</td>
      <td class="loc${sc("loc")}">${esc(r.loc)}${r.via.length ? `<span class="via">in ${esc(r.via.join(", "))}</span>` : ""}</td>
      <td class="qty${sc("qty")}">${fmt(r.qty)}<span class="unit"> Stk</span></td>
      <td class="hide-s${sc("price")}">${fmtPrice(r.price)}</td>
      ${HUBS.map((_, i) => hubCell(r, i, sc(`h${i}`))).join("")}
      <td class="val${sc("value")}">${r.value == null ? "–" : `${fmtShort(r.value)} ISK`}</td>
      <td class="chg ${cls(r.chg)}${sc("chg")}">${r.error ? `<span class="dim" title="${esc(r.error)}">Fehler</span>` : r.price == null ? `<span class="v dim" title="in den letzten Tagen nicht in The Forge gehandelt">kein Handel</span>` : fmtPct(r.chg)}</td>
      <td class="hide-s ${cls(r.gain)}${sc("gain")}">${r.gain == null ? "–" : `${r.gain >= 0 ? "+" : "−"}${fmtShort(Math.abs(r.gain))} ISK`}</td>
      <td class="hide-s spark-col">${spark(r.spark, r.chg)}</td>
      ${hubMobile(r)}
    </tr>`).join("") || `<tr><td colspan="12" class="dim" style="text-align:center;padding:18px">Keine Treffer${onlyUp ? " – Filter „nur Anstiege“ lockern?" : ""}</td></tr>`;
  $("more").innerHTML = (rows.length > shown ? `<button class="btn-ghost" id="more-btn" type="button">${fmt(rows.length - shown)} WEITERE ANZEIGEN</button>` : "")
    + (small ? `<div class="small" style="margin-top:8px">${fmt(small)} Stapel unter dem Mindestwert von ${fmtShort(minVal)} ISK ausgeblendet</div>` : "");
  $("more-btn")?.addEventListener("click", () => { shown += PAGE; render(); });
  ensureHubs(rows.slice(0, shown).map((r) => r.type));

  // Kacheln rechnen mit dem, was die Tabelle zeigt (Suche, Mindestwert, „nur Anstiege“); bei aktivem Filter mit Gesamtwert
  const sums = (rs) => rs.reduce((a, r) => ({ v: a.v + (r.value ?? 0), g: a.g + (r.gain ?? 0) }), { v: 0, g: 0 });
  const cur = sums(rows), tot = sums(SCAN.rows), filtered = rows.length !== SCAN.rows.length;
  const signed = (n) => `${n >= 0 ? "+" : "−"}${fmtShort(Math.abs(n))} ISK`;
  const of = (txt) => filtered ? `<span class="tot">von ${txt} gesamt</span>` : "";
  const top = rows.filter((r) => r.chg != null).sort((a, b) => b.chg - a.chg)[0];
  $("s-n-k").textContent = filtered ? "Positionen angezeigt" : "Positionen geprüft";
  $("s-n").innerHTML = fmt(rows.length) + of(fmt(SCAN.rows.length));
  $("s-val").innerHTML = `${fmtShort(cur.v)} ISK` + of(`${fmtShort(tot.v)} ISK`);
  $("s-gain").innerHTML = `<span class="${cls(cur.g)}">${signed(cur.g)}</span>` + of(signed(tot.g));
  $("s-top").innerHTML = top ? `<span class="${cls(top.chg)}">${fmtPct(top.chg)}</span> ${esc(top.name)}` : "–";
  $("s-top").title = top ? `${top.name} · ${top.loc}` : "";
}

// ---- Ansicht je nach Login-Zustand
function gate() {
  const st = EveSSO.state();
  const ok = st.char && EveSSO.hasScope(ASSET_SCOPE);
  $("gate").hidden = !!ok;
  $("view").hidden = !ok;
  if (!ok) {
    $("gate-title").textContent = st.char ? `${st.char.name}: Inventar noch nicht freigegeben` : "Was liegt bei dir herum – und ist gerade mehr wert?";
    $("gate-login").textContent = st.char ? "INVENTAR FREIGEBEN" : "MIT EVE ANMELDEN & INVENTAR FREIGEBEN";
    $("gate-note").textContent = st.char ? "Die bisherige Anmeldung erlaubt nur Skills lesen. Einmal neu bestätigen genügt." : "";
    setStatus(st.error ? `Anmeldung: ${st.error}` : st.char ? "Inventar-Freigabe fehlt" : "Nicht angemeldet", st.error ? "err" : "warn");
  }
  return ok;
}

$("gate-login").addEventListener("click", () => EveSSO.login());
$("rescan").addEventListener("click", () => { histCache.clear(); hubCache.clear(); scan(true); });
$("minval").value = String(store.get("minval", "1e7"));
$("minval").addEventListener("change", () => { store.set("minval", $("minval").value); scan(); });
$("onlyup").checked = !!store.get("onlyup", false);
$("upmin").value = store.get("upmin", 10);
$("onlyup").addEventListener("change", () => { store.set("onlyup", $("onlyup").checked); render(); });
$("upmin").addEventListener("input", () => { store.set("upmin", Number($("upmin").value)); if ($("onlyup").checked) render(); });
$("q").addEventListener("input", () => { shown = PAGE; render(); });
document.querySelectorAll("#rt th[data-k]").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = k === "name" || k === "loc" ? 1 : -1; }
  store.set("sort", sortKey); store.set("dir", sortDir); render();
}));

$("sortsel").addEventListener("change", () => {
  const [k, d] = $("sortsel").value.split(":"); sortKey = k; sortDir = Number(d);
  store.set("sort", sortKey); store.set("dir", sortDir); render();
});

let lastChar = null;
EveSSO.onChange((st) => {
  const ok = gate();
  const id = st.char?.id ?? null;
  if (ok && (id !== lastChar || !SCAN)) { lastChar = id; SCAN = null; scan(); }
  if (!ok) { lastChar = null; SCAN = null; }
});
