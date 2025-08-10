const DATA_URL = "data/starlink_tle.json";
const META_URL = "data/meta.json";
const REFRESH_MS = 3000;

let tleList = [];
let satRecs = [];
let map, layerGroup;
let obs = { lat: -27.588, lon: -48.613, elevMin: 25 };

async function safeFetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ao carregar ${url}`);
  return r.json();
}

async function init() {
  try {
    const meta = await safeFetchJSON(META_URL);
    document.getElementById("meta").textContent =
      `Satélites: ${meta.count} • Fonte: ${meta.source} • Atualizado: ${new Date(meta.updatedAt).toLocaleString()}`;
  } catch (e) {
    console.error("Falha ao carregar meta:", e);
    document.getElementById("meta").textContent = "Falha ao carregar meta.json";
  }

  try {
    tleList = await safeFetchJSON(DATA_URL);
    console.log("TLEs carregados:", tleList.length);
  } catch (e) {
    console.error("Falha ao carregar starlink_tle.json:", e);
    alert("Não consegui carregar os satélites (veja o console do navegador).");
    tleList = [];
  }

  // Montar os 'satrec'
  satRecs = tleList.map(t => {
    try { return satellite.twoline2satrec(t.line1, t.line2); }
    catch (err) { console.warn("TLE inválido para", t.noradId, err); return null; }
  });

  // Mapa
  map = L.map("map", { worldCopyJump: true, preferCanvas: true }).setView([0,0], 2);
const renderer = L.canvas({ padding: 0.5 }); // renderizador compartilhado
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

    // MARCADOR: pequeno, preenchido (sem stroke), via Canvas
const m = L.circleMarker([st.lat, st.lon], {
  renderer,
  radius: 2.5,          // 2.5–3 fica bom no zoom 2
  stroke: false,
  fill: true,
  fillOpacity: 1,
  fillColor: "#6aa0ff"
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
