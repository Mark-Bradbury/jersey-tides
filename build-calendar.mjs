// Builds docs/tides.ics: St Helier tides with surf, sail, wind, weather and sea temperature,
// picking the best Jersey surf spot for the 3 hours before each high tide.
// Run on a schedule by GitHub Actions so subscribed calendars stay current.
import { stations } from "@neaps/tide-database";
import { useStation } from "@neaps/tide-predictor";
import SunCalc from "suncalc";
import fs from "fs";

const DAYS = 7;                       // how far ahead to publish (forecasts run about 7 days)
const ALERT_HOURS = 3;                // reminder before high tide
const TZ = "Europe/Jersey";
const HOME = { lat: 49.2, lon: -2.2 };

// Surf spots. facing = compass direction the beach looks out to sea.
// swellDir = best swell direction, exposure = share of open-sea swell that reaches it,
// tide = which part of the tide it works on.
const SPOTS = [
  { name: "Watersplash (St Ouen's Bay)", facing: 285, swellDir: 270, exposure: 1.0, tide: "any", min: 0.4 },
  { name: "Les Brayes (St Ouen's Bay)", facing: 280, swellDir: 265, exposure: 0.95, tide: "mid", min: 0.4 },
  { name: "Petit Port (reef by Corbière, experienced only)", facing: 290, swellDir: 250, exposure: 0.9, tide: "high", min: 1.4 },
  { name: "Plémont", facing: 340, swellDir: 315, exposure: 0.75, tide: "low", min: 0.8 },
  { name: "Grève de Lecq", facing: 0, swellDir: 315, exposure: 0.6, tide: "low", min: 1.0 },
  { name: "St Brelade's Bay", facing: 200, swellDir: 225, exposure: 0.45, tide: "mid", min: 1.5 },
];

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const angle = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };
const hm = d => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const day = d => d.toLocaleDateString("en-GB", { weekday: "short", timeZone: TZ });
const r1 = x => (Math.round(x * 10) / 10).toFixed(1);

function windState(windFrom, facing) {
  const offshoreFrom = (facing + 180) % 360;           // wind blowing from the land
  const a = angle(windFrom, offshoreFrom);
  if (a <= 35) return "offshore";
  if (a <= 80) return "cross-offshore";
  if (a <= 110) return "cross-shore";
  if (a <= 150) return "cross-onshore";
  return "onshore";
}
function surfFeel(h) {
  if (h < 0.3) return "flat"; if (h < 0.5) return "ankle to knee high"; if (h < 0.7) return "knee to waist high";
  if (h < 0.9) return "about waist high"; if (h < 1.1) return "waist to chest high"; if (h < 1.4) return "about chest high";
  if (h < 1.8) return "chest to head high"; return "overhead";
}
function sea(state, mph, period) {
  if (mph < 4) return ["glassy", "Glassy"];
  const good = state === "offshore" || state === "cross-offshore";
  if (state === "onshore" || (state === "cross-onshore" && mph >= 10)) return ["choppy", "Choppy and blown out"];
  if (good && mph <= 18) return ["clean", period >= 10 ? "Clean, with lined-up groundswell" : "Clean but short-period, so a bit weak"];
  if (good) return ["bumpy", "Strong offshore: clean faces but hard to paddle into"];
  return ["bumpy", mph < 8 ? "Fairly clean, light texture" : "Bumpy and a little textured"];
}
const WMO = { 0:"clear",1:"mostly clear",2:"partly cloudy",3:"overcast",45:"fog",48:"fog",51:"drizzle",53:"drizzle",55:"drizzle",61:"light rain",63:"rain",65:"heavy rain",80:"showers",81:"showers",82:"heavy showers",95:"thunderstorms" };

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function main() {
  const start = new Date(), end = new Date(+start + DAYS * 864e5);
  const st = stations.find(s => s.name === "St Helier Jersey");
  const tides = useStation(st).getExtremesPrediction({ start: new Date(+start - 864e5), end }).extremes;

  const wx = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${HOME.lat}&longitude=${HOME.lon}&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph&timezone=GMT&forecast_days=${DAYS + 1}`);
  const mar = await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=49.21&longitude=-2.30&hourly=wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature&timezone=GMT&forecast_days=${DAYS + 1}`);
  const at = (src, t) => {
    if (!src?.hourly?.time) return null;
    const ms = src.hourly.time.map(x => Date.parse(x + "Z"));
    let best = 0, bd = Infinity; ms.forEach((m, i) => { const d = Math.abs(m - t); if (d < bd) { bd = d; best = i; } });
    if (bd > 2 * 36e5) return null;
    const o = {}; for (const k of Object.keys(src.hourly)) o[k] = src.hourly[k][best]; return o;
  };

  const issued = start.toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const L = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Tideline//Jersey surf and sail//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "X-WR-CALNAME:Jersey Tides and Surf","X-WR-TIMEZONE:Europe/Jersey","REFRESH-INTERVAL;VALUE=DURATION:PT3H","X-PUBLISHED-TTL:PT3H"];
  const esc = s => s.replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");
  const fold = line => { const b = Buffer.from(line); const parts = []; let i = 0;
    while (b.length - i > 73) { let c = i + 73; while ((b[c] & 0xC0) === 0x80) c--; parts.push(b.subarray(i, c)); i = c; }
    parts.push(b.subarray(i)); return parts.map(p => p.toString()).join("\r\n "); };
  const ics = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const stamp = ics(start);

  tides.forEach((e, idx) => {
    if (e.time < start || e.time > end) return;
    const t = e.time, h = r1(e.level);
    const uid = `tideline-sthelier-${ics(new Date(Math.round(+t / 6e4) * 6e4))}@tideline`;
    const base = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `SEQUENCE:${Math.floor(+start / 1000 / 3600)}`,
      `DTSTART:${ics(t)}`, `DTEND:${ics(new Date(+t + 30 * 6e4))}`, "LOCATION:St Helier\\, Jersey", "TRANSP:TRANSPARENT"];
    if (e.low) {
      L.push(...base, fold("SUMMARY:" + esc(`▼ Low tide ${hm(t)} (${h} m)`)),
        fold("DESCRIPTION:" + esc(`LOW TIDE ${hm(t)}, ${h} m above chart datum (St Helier)\n\nUpdated ${issued}.`)), "END:VEVENT");
      return;
    }
    const s = new Date(+t - ALERT_HOURS * 36e5), ebb = new Date(+t + ALERT_HOURS * 36e5);
    const mid = +t - 1.5 * 36e5;
    const w0 = at(wx, +s), w1 = at(wx, mid), m1 = at(mar, mid);
    const light = SunCalc.getPosition(s, HOME.lat, HOME.lon).altitude > -0.0145 || SunCalc.getPosition(new Date(mid), HOME.lat, HOME.lon).altitude > -0.0145;
    const sun = SunCalc.getTimes(t, HOME.lat, HOME.lon);
    const prev = tides[idx - 1], range = prev ? Math.abs(e.level - prev.level) : null;
    const phase = range == null ? "" : range > 9 ? "Spring tides, very large range and strong streams." : range < 5.5 ? "Neap tides, small range." : "Mid-cycle between springs and neaps.";
    const lines = [`HIGH TIDE ${hm(t)}, ${h} m above chart datum (St Helier)`, ""];
    let title = `▲ High tide ${hm(t)} (${h} m) · surf ${hm(s)}${day(s) !== day(t) ? " " + day(s) : ""}`;

    if (m1 && w1 && m1.swell_wave_height != null) {
      const sh = m1.swell_wave_height ?? m1.wave_height, sp = m1.swell_wave_period, sd = m1.swell_wave_direction;
      const mph = w1.wind_speed_10m, wdir = w1.wind_direction_10m;
      const scored = SPOTS.map(spot => {
        const a = angle(sd, spot.swellDir);
        const size = a >= 100 ? 0 : sh * spot.exposure * Math.max(0.2, Math.cos(a * Math.PI / 180));
        const ws = windState(wdir, spot.facing);
        const windPts = { offshore: 2, "cross-offshore": 1.5, "cross-shore": 0, "cross-onshore": -1.5, onshore: -2.5 }[ws] * Math.min(1, mph / 12);
        const tidePts = spot.tide === "high" ? 1 : spot.tide === "any" ? 0.5 : spot.tide === "mid" ? 0.2 : -2.5;
        const score = (size >= spot.min ? 2 : size >= spot.min * 0.7 ? 0 : -3) + size * 2 + windPts + tidePts;
        return { spot, size, ws, score };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0], others = scored.slice(1, 3);
      const [word, cond] = sea(best.ws, mph, sp);
      const surfable = best.size >= 0.3 && best.score > 0;
      title += surfable ? ` · ${r1(best.size)} m ${word} · ${best.spot.name.split(" (")[0]}` : " · flat";
      lines.push(`SURF: ${hm(s)}–${hm(t)} on the flooding tide`,
        `Swell: ${r1(sh)} m at ${Math.round(sp)} s from the ${compass(sd)}`,
        `Surf height (estimate): ${surfFeel(best.size)}`,
        `Wind: ${Math.round(mph)} mph from the ${compass(wdir)}, gusting ${Math.round(w1.wind_gusts_10m)} mph (${best.ws} at the pick)`,
        `Conditions: ${surfable ? cond : "Too small to be worth it"}`,
        `Best spot in Jersey: ${surfable ? best.spot.name : "Nowhere worthwhile"}`,
        `Also considered: ${others.map(o => `${o.spot.name.split(" (")[0]} (${o.ws}${o.spot.tide === "low" ? ", a low-tide spot" : ""})`).join("; ")}`);
      if (m1.sea_surface_temperature != null) lines.push(`Sea temperature: ${r1(m1.sea_surface_temperature)}°C`);
    } else {
      lines.push(`SURF: ${hm(s)}–${hm(t)} on the flooding tide`, "Surf forecast not available yet for this date. It will appear here once it's within range.");
    }
    lines.push("", `SAIL: ${hm(s)}–${hm(t)} on the flood or ${hm(t)}–${hm(ebb)} on the ebb`, "");
    if (w0) lines.push(`WEATHER at ${hm(s)}: ${WMO[w0.weather_code] ?? "mixed"}, ${Math.round(w0.temperature_2m)}°C, ${w0.precipitation_probability ?? 0}% chance of rain`);
    lines.push(`LIGHT: ${light ? "daylight" : "after dark"} (sunrise ${hm(sun.sunrise)}, sunset ${hm(sun.sunset)})`);
    if (phase) lines.push(`TIDES: ${phase}`);
    lines.push("", `Updated ${issued}. Tides: St Helier harmonic prediction (TICON-4). Weather, swell and sea temperature: Open-Meteo. Not for navigation.`);
    L.push(...base, fold("SUMMARY:" + esc(title)), fold("DESCRIPTION:" + esc(lines.join("\n"))),
      "BEGIN:VALARM", "ACTION:DISPLAY", fold("DESCRIPTION:" + esc(`Surf window opens now. ${title.replace(/^▲ /, "")}`)), `TRIGGER:-PT${ALERT_HOURS}H`, "END:VALARM", "END:VEVENT");
  });
  L.push("END:VCALENDAR");
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("docs/tides.ics", L.join("\r\n") + "\r\n");
  console.log(`DONE: wrote docs/tides.ics with ${L.filter(x => x === "BEGIN:VEVENT").length} events (weather ${wx ? "ok" : "missing"}, marine ${mar ? "ok" : "missing"})`);
}
main().catch(e => { console.error(e); process.exit(1); });
