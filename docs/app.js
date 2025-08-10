const DATA_URL = "data/starlink_tle.json";
const META_URL = "data/meta.json";
const REFRESH_MS = 3000;

let tleList = [];
let satRecs = [];
let map, layerGroup;
let obs = { lat: -27.588, lon: -48.613, elevMin: 25 };

function makeRec(t) {
  try { return satellite.twoline2satrec(t.line1, t.line2); } catch { return null; }
}

function getSatState(rec, time = new Date()) {
  const gmst = satellite.gstime(time);
  const pv = satellite.propagate(rec, time);
  if (!pv.position) return null;
  const eci = pv.position;
  const gd = satellite.eciToGeodetic(eci, gmst);
  const lat = satellite.radiansToDegrees(gd.latitude);
  const lon = satellite.radiansToDegrees(gd.longitude);
  const alt = gd.height;

  const obsGd = {
    latitude: satellite.degreesToRadians(obs.lat),
    longitude: satellite.degreesToRadians(obs.lon),
    height: 0
  };
  const satEcf = satellite.eciToEcf(eci, gmst);
  const look = satellite.ecfToLookAngles(obsGd, satEcf);
  const az = satellite.radiansToDegrees(look.azimuth);
  const el = satellite.radiansToDegrees(look.elevation);

  return { lat, lon, alt, az, el };
}

function footprintRadiusKm(altKm, elevMinDeg) {
  const Re = 6371, h = altKm, e = elevMinDeg * Math.PI/180;
  const psi = Math.acos((Re/(Re+h)) * Math.cos(e)) - e;
  return Re * psi;
}

async function init() {
  const meta = await (await fetch(META_URL)).json();
  document.getElementById("meta").textContent =
    `Satélites: ${meta.count} • Fonte: ${meta.source} • Atualizado: ${new Date(meta.updatedAt).toLocaleString()}`;

  tleList = await (await fetch(DATA_URL)).json();
  satRecs = tleList.map(makeRec);

  map = L.map("map", { worldCopyJump: true }).setView([0,0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 7
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);

  document.getElementById("btnApply").onclick = () => {
    obs.elevMin = Number(document.getElementById("elevMin").value);
    obs.lat = Number(document.getElementById("lat").value);
    obs.lon = Number(document.getElementById("lon").value);
    drawFrame();
  };

  drawFrame();
  setInterval(drawFrame, REFRESH_MS);
}

function drawFrame() {
  layerGroup.clearLayers();
  let visible = 0;

  tleList.forEach((t, i) => {
    const rec = satRecs[i]; if (!rec) return;
    const st = getSatState(rec); if (!st) return;

    const m = L.circleMarker([st.lat, st.lon], {
      radius: 3, weight: 1, color: "#6aa0ff", fillOpacity: 0.9
    }).addTo(layerGroup);
    m.on("click", () => selectSatellite(t, rec, st));

    if (st.el >= obs.elevMin) {
      visible++;
      const rKm = Math.max(200, footprintRadiusKm(Math.max(0, st.alt), obs.elevMin));
      L.circle([st.lat, st.lon], {
        radius: rKm * 1000, color: "#00d07d", weight: 1, opacity: 0.5, fillOpacity: 0.05
      }).addTo(layerGroup);
    }
  });

  document.getElementById("visibleInfo").textContent =
    `Visíveis do ponto (${obs.lat.toFixed(3)}, ${obs.lon.toFixed(3)}) com elevação ≥ ${obs.elevMin}°: ${visible}`;
}

function selectSatellite(t, rec, st0) {
  const st = st0 || getSatState(rec, new Date());
  const info = document.getElementById("sat-info");
  info.innerHTML = `
    <div><b>${t.name || "STARLINK"}</b> • NORAD ${t.noradId ?? "—"}</div>
    <div>Lat/Lon: ${st.lat.toFixed(2)}, ${st.lon.toFixed(2)} • Alt: ${st.alt.toFixed(0)} km</div>
    <div>Az/El (do observador): ${st.az.toFixed(0)}° / ${st.el.toFixed(0)}°</div>
    <div><code>TLE</code>:<br/><small>${t.line1}</small><br/><small>${t.line2}</small></div>
  `;

  const elevs = Array.from({length: 19}, (_,k)=>k*5);
  const snr = elevs.map(e => Math.max(-1, 20 + 0.25*e - 40/(e+5)));
  Plotly.newPlot("snrPlot", [{ x:elevs, y:snr, mode:"lines+markers", name:"SNR (dB)" }],
                 { title:"SNR vs Elevação (simulado)", margin:{t:30} }, {displayModeBar:false});

  const s = Math.max(-1, 20 + 0.25*st.el - 40/(st.el+5));
  const noise = 1/Math.max(1, (s-5)/5);
  const N = 600, xs=[], ys=[];
  for (let i=0;i<N;i++){
    const sym = [[1,1],[1,-1],[-1,1],[-1,-1]][i%4];
    xs.push(sym[0] + (Math.random()*2-1)*noise);
    ys.push(sym[1] + (Math.random()*2-1)*noise);
  }
  Plotly.newPlot("constPlot", [{x:xs,y:ys,mode:"markers",type:"scatter"}],
                 { title:`Constelação QPSK (simulada) • El=${st.el.toFixed(0)}°`,
                   xaxis:{scaleanchor:"y"}, margin:{t:30} }, {displayModeBar:false});
}

init();
