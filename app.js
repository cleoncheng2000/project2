// Free, keyless APIs (both send CORS headers, so this runs as a static site):
//   Transitous (MOTIS) – geocoding + public transport routing, real-time where agencies publish it
//   Open-Meteo Air Quality – current US AQI / PM2.5 / PM10
//   ArriveLah – live LTA bus arrivals for Singapore bus stops
//   data.gov.sg – official NEA 1-hour PM2.5 readings by region
const TRANSIT_API = "https://api.transitous.org/api";
const AIR_API = "https://air-quality-api.open-meteo.com/v1/air-quality";
const BUS_ARRIVAL_API = "https://arrivelah2.busrouter.sg/";
const PM25_API = "https://api.data.gov.sg/v1/environment/pm25";
const SG_CENTER = "1.3521,103.8198"; // biases place search towards Singapore

const $ = (id) => document.getElementById(id);
const state = { from: null, to: null, itineraries: [], air: null, pm25: null, busArrivals: {}, selected: 0 };

// ---------- Place search / autocomplete ----------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function geocode(text) {
  const res = await fetch(`${TRANSIT_API}/v1/geocode?text=${encodeURIComponent(text)}&place=${SG_CENTER}`);
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  return res.json();
}

function placeLabel(p) {
  const area = (p.areas || []).filter((a) => !a.matched).map((a) => a.name);
  return { name: p.name, detail: [...new Set(area)].slice(-3).reverse().join(", ") };
}

function setupAutocomplete(key) {
  const input = $(key);
  const list = $(`${key}-suggest`);
  let results = [];
  let active = -1;

  const choose = (p) => {
    state[key] = p;
    input.value = p.name;
    list.hidden = true;
  };

  const render = () => {
    list.innerHTML = "";
    results.forEach((p, i) => {
      const { name, detail } = placeLabel(p);
      const li = document.createElement("li");
      li.className = i === active ? "active" : "";
      li.innerHTML = `${escapeHtml(name)}<small>${escapeHtml(detail)}</small>`;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(p);
      });
      list.appendChild(li);
    });
    list.hidden = results.length === 0;
  };

  const search = debounce(async (text) => {
    if (text.length < 3) {
      results = [];
      return render();
    }
    try {
      results = (await geocode(text)).slice(0, 6);
      active = -1;
      render();
    } catch {
      /* ignore autocomplete errors; submit will retry */
    }
  }, 300);

  input.addEventListener("input", () => {
    state[key] = null;
    search(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      list.hidden = true;
    }
  });
  input.addEventListener("blur", () => (list.hidden = true));
}

async function resolvePlace(key) {
  if (state[key]) return state[key];
  const text = $(key).value.trim();
  const found = await geocode(text);
  if (!found.length) throw new Error(`Couldn't find "${text}". Try a more specific name.`);
  state[key] = found[0];
  return found[0];
}

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Geolocation isn't supported by this browser.", true);
  setStatus("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.from = { name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude };
      $("from").value = "My location";
      setStatus("");
    },
    (err) => setStatus(`Couldn't get your location: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- Data fetching ----------

async function planTrip(from, to, when) {
  const params = new URLSearchParams({
    fromPlace: `${from.lat},${from.lon}`,
    toPlace: `${to.lat},${to.lon}`,
    numItineraries: "5",
  });
  if (when) params.set("time", new Date(when).toISOString());
  const res = await fetch(`${TRANSIT_API}/v4/plan?${params}`);
  if (!res.ok) throw new Error(`Route planning failed (${res.status})`);
  return res.json();
}

async function airQuality(places) {
  const params = new URLSearchParams({
    latitude: places.map((p) => p.lat.toFixed(4)).join(","),
    longitude: places.map((p) => p.lon.toFixed(4)).join(","),
    current: "us_aqi,pm2_5,pm10",
  });
  const res = await fetch(`${AIR_API}?${params}`);
  if (!res.ok) throw new Error(`Air quality lookup failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

// Official NEA 1-hour PM2.5: Singapore is split into 5 regions; use the one nearest each place.
async function neaPm25(places) {
  const res = await fetch(PM25_API);
  if (!res.ok) throw new Error(`PM2.5 lookup failed (${res.status})`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  return places.map((p) => {
    let best, bestDist = Infinity;
    for (const r of data.region_metadata) {
      const d = (r.label_location.latitude - p.lat) ** 2 + (r.label_location.longitude - p.lon) ** 2;
      if (d < bestDist) [best, bestDist] = [r.name, d];
    }
    // ~0.3° (~33 km) from the nearest region centre means the place isn't in Singapore
    if (bestDist > 0.09) return null;
    const value = item.readings.pm25_one_hourly?.[best];
    return value == null ? null : { region: best, value, time: item.timestamp };
  });
}

// Live LTA bus arrivals for every Singapore bus boarding stop across the itineraries.
async function loadBusArrivals() {
  const codes = new Set();
  for (const it of state.itineraries)
    for (const l of it.legs)
      if (l.mode === "BUS" && l.from.stopId?.startsWith("sg-") && l.from.stopCode) codes.add(l.from.stopCode);
  await Promise.all(
    [...codes].map(async (code) => {
      try {
        const res = await fetch(`${BUS_ARRIVAL_API}?id=${encodeURIComponent(code)}`);
        if (res.ok) state.busArrivals[code] = { services: (await res.json()).services || [], fetched: Date.now() };
      } catch {
        /* live data is a bonus; schedules still show */
      }
    })
  );
}

// ---------- Air quality & mask advice ----------

// Both scales map onto shared severity tiers so one mask rule covers them:
// 0 good · 1 moderate · 2 unhealthy for sensitive groups · 3 unhealthy · 4 very unhealthy/hazardous
const AQI_LEVELS = [
  { max: 50, label: "Good", tier: 0, color: "var(--good)" },
  { max: 100, label: "Moderate", tier: 1, color: "var(--moderate)" },
  { max: 150, label: "Unhealthy for sensitive groups", tier: 2, color: "var(--usg)" },
  { max: 200, label: "Unhealthy", tier: 3, color: "var(--unhealthy)" },
  { max: 300, label: "Very unhealthy", tier: 4, color: "var(--very)" },
  { max: Infinity, label: "Hazardous", tier: 4, color: "var(--hazard)" },
];
// NEA 1-hour PM2.5 bands (µg/m³)
const PM25_BANDS = [
  { max: 55, label: "Band I (Normal)", tier: 0, color: "var(--good)" },
  { max: 150, label: "Band II (Elevated)", tier: 2, color: "var(--usg)" },
  { max: 250, label: "Band III (High)", tier: 3, color: "var(--unhealthy)" },
  { max: Infinity, label: "Band IV (Very high)", tier: 4, color: "var(--hazard)" },
];
const aqiLevel = (aqi) => AQI_LEVELS.find((l) => aqi <= l.max);
const pm25Band = (v) => PM25_BANDS.find((b) => v <= b.max);

// Prefer the official NEA 1-hour PM2.5; fall back to the Open-Meteo US AQI estimate (e.g. outside Singapore).
function placeAir(i) {
  const nea = state.pm25?.[i];
  if (nea) {
    const band = pm25Band(nea.value);
    return { ...band, badge: `PM2.5 ${nea.value}`, source: `NEA 1-h PM2.5 (${nea.region})` };
  }
  const aqi = state.air?.[i]?.current?.us_aqi;
  if (aqi == null) return null;
  return { ...aqiLevel(aqi), badge: `AQI ${aqi}`, source: "US AQI estimate" };
}

function maskAdvice(tier, walkMin, sensitive) {
  if (tier == null) return { verdict: "Unknown", text: "Air quality data unavailable." };
  if (tier === 0)
    return { verdict: "No mask needed", text: "Air quality is good. Enjoy the walk." };
  if (tier === 1)
    return sensitive && walkMin >= 15
      ? { verdict: "Optional mask", text: `Moderate air and ~${walkMin} min of walking. As a sensitive person, consider a mask.` }
      : { verdict: "No mask needed", text: "Air quality is acceptable for most people." };
  if (tier === 2)
    return sensitive || walkMin >= 20
      ? { verdict: "Wear a mask", text: `Air is unhealthy for sensitive groups${walkMin ? ` and you'll walk ~${walkMin} min` : ""}. An N95/KF94 mask is recommended outdoors.` }
      : { verdict: "Mask recommended if you're sensitive", text: `Short walk (~${walkMin} min) — most people are fine, but a mask is a sensible precaution.` };
  if (tier === 3)
    return { verdict: "Wear an N95 mask", text: "Air is unhealthy for everyone. Wear a well-fitted N95/KF94 when walking outside." };
  return { verdict: "Wear an N95 mask & limit walking", text: "Very unhealthy air. Wear an N95, minimise time outdoors, and consider a route with less walking." };
}

function renderAir() {
  const labels = ["Start", "Destination"];
  const rows = labels
    .map((label, i) => {
      const c = state.air?.[i]?.current || {};
      const lvl = placeAir(i);
      const badge = lvl
        ? `<span class="aqi-badge" style="background:${lvl.color}" title="${lvl.label}">${lvl.badge}</span>`
        : `<span class="muted">No data</span>`;
      return `<div class="aqi-row">
        <div><strong>${label}</strong>
          <div class="muted">${lvl ? `${lvl.source} · ${lvl.label}` : ""}</div>
          <div class="muted">Model estimate: US AQI ${c.us_aqi ?? "–"} · PM2.5 ${c.pm2_5 ?? "–"} · PM10 ${c.pm10 ?? "–"} µg/m³</div>
        </div>
        ${badge}
      </div>`;
    })
    .join("");
  const neaTime = state.pm25?.find(Boolean)?.time;
  const updated = neaTime
    ? `NEA reading for ${new Date(neaTime).toLocaleString([], { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" })} SGT`
    : state.air?.[0]?.current?.time ? `estimate for ${state.air[0].current.time.replace("T", " ")} UTC` : "";
  $("air").innerHTML = `<h3>Air quality</h3>${rows}<p class="muted">${updated}</p>`;
}

const worstTier = () => {
  const tiers = [0, 1].map(placeAir).filter(Boolean).map((l) => l.tier);
  return tiers.length ? Math.max(...tiers) : null;
};

function renderMask() {
  const it = state.itineraries[state.selected];
  const walkMin = it ? Math.round(walkSeconds(it) / 60) : 0;
  const { verdict, text } = maskAdvice(worstTier(), walkMin, $("sensitive").checked);
  const basis = state.pm25?.some(Boolean) ? "NEA 1-hour PM2.5" : "US AQI";
  $("mask").innerHTML = `<h3>Should I wear a mask?</h3>
    <div class="mask-verdict">${verdict}</div>
    <p>${text}</p>
    <p class="muted">Based on the worse ${basis} reading of start/destination and ${walkMin} min of walking on the selected route.</p>`;
}

$("sensitive").addEventListener("change", () => state.air && renderMask());

// ---------- Itineraries ----------

const walkSeconds = (it) => it.legs.filter((l) => l.mode === "WALK").reduce((s, l) => s + l.duration, 0);

const MODE_ICON = {
  WALK: "🚶", BUS: "🚌", SUBWAY: "🚇", METRO: "🚇", TRAM: "🚊", RAIL: "🚆", REGIONAL_RAIL: "🚆",
  HIGHSPEED_RAIL: "🚄", LONG_DISTANCE: "🚆", NIGHT_RAIL: "🚆", SUBURBAN: "🚆", COACH: "🚌",
  FERRY: "⛴️", FUNICULAR: "🚞", AERIAL_LIFT: "🚡", AIRPLANE: "✈️", BIKE: "🚲", CAR: "🚗",
};

function fmtTime(iso, tz) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz });
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function legChip(l) {
  const icon = MODE_ICON[l.mode] || "🚍";
  if (l.mode === "WALK") return `<span class="chip">${icon} ${Math.round(l.duration / 60)}′</span>`;
  const bg = l.routeColor ? `background:#${l.routeColor};color:#${l.routeTextColor || "fff"};border-color:transparent` : "";
  return `<span class="chip" style="${bg}">${icon} ${escapeHtml(l.routeShortName || l.displayName || l.mode)}</span>`;
}

function legDetail(l, tz) {
  const t = fmtTime(l.startTime, tz);
  if (l.mode === "WALK") {
    const dist = l.distance ? ` (${Math.round(l.distance)} m)` : "";
    return `${t} · 🚶 Walk ${fmtDur(l.duration)}${dist} to ${escapeHtml(l.to.name === "END" ? "destination" : l.to.name)}`;
  }
  const delayMin = Math.round((new Date(l.startTime) - new Date(l.scheduledStartTime)) / 60000);
  const live = l.realTime
    ? ` <span class="live">Live</span>${delayMin > 0 ? ` <span class="delay">+${delayMin} min</span>` : ""}`
    : "";
  const stops = l.intermediateStops ? ` · ${l.intermediateStops.length + 1} stops` : "";
  const bus = liveBusText(l);
  return `${t} · ${MODE_ICON[l.mode] || "🚍"} <strong>${escapeHtml(l.routeShortName || l.displayName || l.mode)}</strong>
    ${l.headsign ? `towards ${escapeHtml(l.headsign)}` : ""} from <strong>${escapeHtml(l.from.name)}</strong>
    to <strong>${escapeHtml(l.to.name)}</strong> (${fmtDur(l.duration)}${stops})${live}${bus}`;
}

const BUS_LOAD = { SEA: "seats available", SDA: "standing room", LSD: "limited standing" };

function liveBusText(l) {
  if (l.mode !== "BUS") return "";
  const stop = state.busArrivals[l.from.stopCode];
  if (!stop) return "";
  const svc = stop.services.find((s) => s.no === l.routeShortName);
  if (!svc) return `<div class="muted">No live arrivals for bus ${escapeHtml(l.routeShortName)} at stop ${escapeHtml(l.from.stopCode)} right now.</div>`;
  const elapsed = Date.now() - stop.fetched;
  // ArriveLah's "subsequent" often repeats next2, so dedupe by arrival time.
  const buses = [svc.next, svc.subsequent, svc.next2, svc.next3]
    .filter((b) => b?.time)
    .filter((b, i, arr) => arr.findIndex((x) => x.time === b.time) === i);
  const parts = buses.slice(0, 3).map((b) => {
    const min = Math.max(0, Math.round((b.duration_ms - elapsed) / 60000));
    return `${min === 0 ? "Arr" : `${min} min`}${b.load ? ` (${BUS_LOAD[b.load] || b.load})` : ""}`;
  });
  return `<div><span class="live">Live</span> Bus ${escapeHtml(svc.no)} at stop ${escapeHtml(l.from.stopCode)}: ${parts.join(" · ")}</div>`;
}

function renderItineraries() {
  const ol = $("itineraries");
  ol.innerHTML = "";
  state.itineraries.forEach((it, i) => {
    const tz = it.legs[0]?.from?.tz || it.legs.find((l) => l.from?.tz)?.from?.tz;
    const hasLive = it.legs.some((l) => l.realTime || (l.mode === "BUS" && state.busArrivals[l.from.stopCode]));
    const li = document.createElement("li");
    li.className = "itin" + (i === state.selected ? " selected" : "");
    li.innerHTML = `
      <div class="itin-head">
        <span class="itin-time">${fmtTime(it.startTime, tz)} → ${fmtTime(it.endTime, tz)}</span>
        <span>${fmtDur(it.duration)} · ${it.transfers} transfer${it.transfers === 1 ? "" : "s"} · 🚶 ${Math.round(walkSeconds(it) / 60)} min${hasLive ? ' · <span class="live">Live</span>' : ""}</span>
      </div>
      <div class="chips">${it.legs.map(legChip).join('<span class="muted">›</span>')}</div>
      <ol class="legs">${it.legs.map((l) => `<li>${legDetail(l, tz)}</li>`).join("")}</ol>`;
    li.addEventListener("click", () => selectItinerary(i));
    ol.appendChild(li);
  });
}

function selectItinerary(i) {
  state.selected = i;
  document.querySelectorAll(".itin").forEach((el, j) => el.classList.toggle("selected", j === i));
  renderMask();
  drawRoute(state.itineraries[i]);
}

// ---------- Map ----------

let map, routeLayer;

function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const coords = [];
  let lat = 0, lon = 0, i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

function drawRoute(it) {
  if (!window.L) return;
  if (!map) {
    map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
  }
  routeLayer?.remove();
  routeLayer = L.featureGroup().addTo(map);
  const pts = [[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]];
  if (it) {
    for (const l of it.legs) {
      if (!l.legGeometry?.points) continue;
      const line = decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 5);
      const walk = l.mode === "WALK";
      L.polyline(line, {
        color: walk ? "#666" : l.routeColor ? `#${l.routeColor}` : "#1f6feb",
        weight: walk ? 4 : 6,
        dashArray: walk ? "4 8" : null,
      }).addTo(routeLayer);
    }
  }
  L.marker(pts[0]).bindTooltip("Start").addTo(routeLayer);
  L.marker(pts[1]).bindTooltip("Destination").addTo(routeLayer);
  map.fitBounds(routeLayer.getBounds(), { padding: [24, 24] });
}

// ---------- Main ----------

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("go");
  btn.disabled = true;
  setStatus("Finding places…");
  try {
    const [from, to] = await Promise.all([resolvePlace("from"), resolvePlace("to")]);
    setStatus("Planning routes and checking air quality…");
    const [plan, air, pm25] = await Promise.all([
      planTrip(from, to, $("when").value),
      airQuality([from, to]).catch(() => [{}, {}]),
      neaPm25([from, to]).catch(() => null),
    ]);
    state.itineraries = plan.itineraries || [];
    state.air = air;
    state.pm25 = pm25;
    state.busArrivals = {};
    state.selected = 0;

    $("results").hidden = false;
    renderAir();
    renderItineraries();
    renderMask();
    drawRoute(state.itineraries[0]);

    // Live bus arrivals only make sense for trips leaving now.
    if (!$("when").value) loadBusArrivals().then(() => {
      renderItineraries();
    });

    setStatus(
      state.itineraries.length
        ? `${state.itineraries.length} route${state.itineraries.length > 1 ? "s" : ""} found. Tap a route for step-by-step details.`
        : "No public transport routes found for this trip and time.",
      !state.itineraries.length
    );
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    btn.disabled = false;
  }
});

setupAutocomplete("from");
setupAutocomplete("to");
