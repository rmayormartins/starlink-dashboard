// app.js - Dashboard Starlink Corrigido
const DATA_URL = "data/starlink_tle.json";
const META_URL = "data/meta.json";
const REFRESH_MS = 5000; // Aumentado para 5s para performance

let tleList = [];
let satRecs = [];
let map, layerGroup;
let obs = { lat: -27.588, lon: -48.613, elevMin: 25 };
let isDrawing = false; // Previne múltiplos desenhos simultâneos

// Função para fetch seguro
async function safeFetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} ao carregar ${url}`);
    return r.json();
  } catch (e) {
    console.error(`Erro ao buscar ${url}:`, e);
    throw e;
  }
}

// Criar registro SGP4 com tratamento de erro
function makeRec(t) {
  try {
    if (!t.line1 || !t.line2) {
      console.warn("TLE sem linhas:", t);
      return null;
    }
    return satellite.twoline2satrec(t.line1, t.line2);
  } catch (err) {
    console.warn("TLE inválido para NORAD", t.noradId, err);
    return null;
  }
}

// Calcular posição do satélite
function getSatState(rec, time = new Date()) {
  try {
    const gmst = satellite.gstime(time);
    const pv = satellite.propagate(rec, time);
    
    // Verificar se a propagação foi bem sucedida
    if (!pv || !pv.position || pv.position === false) {
      return null;
    }
    
    const eci = pv.position;
    const gd = satellite.eciToGeodetic(eci, gmst);
    
    const lat = satellite.radiansToDegrees(gd.latitude);
    const lon = satellite.radiansToDegrees(gd.longitude);
    const alt = gd.height;
    
    // Validar coordenadas
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) {
      return null;
    }
    
    // Calcular elevação e azimute
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
  } catch (e) {
    return null;
  }
}

// Calcular raio do footprint
function footprintRadiusKm(altKm, elevMinDeg) {
  const Re = 6371;
  const h = altKm;
  const e = elevMinDeg * Math.PI / 180;
  const psi = Math.acos((Re / (Re + h)) * Math.cos(e)) - e;
  return Re * psi;
}

// Inicialização
async function init() {
  console.log("Iniciando aplicação...");
  
  // Carregar metadados
  try {
    const meta = await safeFetchJSON(META_URL);
    document.getElementById("meta").innerHTML = 
      `<strong>Satélites:</strong> ${meta.count} • <strong>Fonte:</strong> ${meta.source} • <strong>Atualizado:</strong> ${new Date(meta.updatedAt).toLocaleString('pt-BR')}`;
    console.log("Metadados carregados:", meta);
  } catch (e) {
    document.getElementById("meta").textContent = "Erro ao carregar metadados";
  }
  
  // Carregar TLEs
  try {
    tleList = await safeFetchJSON(DATA_URL);
    console.log(`✅ ${tleList.length} TLEs carregados com sucesso`);
    
    // Criar registros satellite.js
    satRecs = tleList.map(makeRec);
    const validRecs = satRecs.filter(r => r !== null).length;
    console.log(`✅ ${validRecs} registros SGP4 válidos criados`);
    
  } catch (e) {
    console.error("❌ Erro ao carregar TLEs:", e);
    alert("Erro ao carregar dados dos satélites. Verifique o console.");
    tleList = [];
    satRecs = [];
  }
  
  // Configurar mapa com Canvas renderer (IMPORTANTE para performance)
  map = L.map("map", { 
    worldCopyJump: true,
    preferCanvas: true,  // Usar Canvas em vez de SVG
    renderer: L.canvas() // Força o uso de Canvas
  }).setView([0, 0], 2);
  
  // Adicionar tiles
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 10,
    minZoom: 2
  }).addTo(map);
  
  // Criar grupo de camadas
  layerGroup = L.layerGroup().addTo(map);
  
  // Configurar controles
  document.getElementById("btnApply").onclick = () => {
    obs.elevMin = Number(document.getElementById("elevMin").value) || 25;
    obs.lat = Number(document.getElementById("lat").value) || -27.588;
    obs.lon = Number(document.getElementById("lon").value) || -48.613;
    console.log("Configurações atualizadas:", obs);
    drawFrame();
  };
  
  // Adicionar marcador da posição do observador
  L.marker([obs.lat, obs.lon], {
    title: "Sua posição"
  }).addTo(map);
  
  // Desenhar primeira vez
  drawFrame();
  
  // Atualizar periodicamente
  setInterval(() => {
    if (!isDrawing) {
      drawFrame();
    }
  }, REFRESH_MS);
}

// Função de desenho otimizada
function drawFrame() {
  if (isDrawing) return;
  isDrawing = true;
  
  const startTime = performance.now();
  
  // Limpar camadas anteriores
  layerGroup.clearLayers();
  
  let visible = 0;
  let drawn = 0;
  let errors = 0;
  
  // Limitar quantidade de satélites para performance
  const MAX_SATS = 1000; // Desenhar no máximo 1000 por vez
  const step = Math.ceil(tleList.length / MAX_SATS);
  
  // Processar satélites com step para reduzir quantidade
  for (let i = 0; i < tleList.length; i += step) {
    const t = tleList[i];
    const rec = satRecs[i];
    
    if (!rec) {
      errors++;
      continue;
    }
    
    const st = getSatState(rec);
    if (!st) {
      errors++;
      continue;
    }
    
    // Cor baseada na visibilidade
    const isVisible = st.el >= obs.elevMin;
    const color = isVisible ? "#00ff44" : "#4488ff";
    const radius = isVisible ? 4 : 2;
    
    // Criar marcador
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: radius,
      weight: 1,
      color: color,
      fillColor: color,
      fillOpacity: isVisible ? 0.9 : 0.6
    });
    
    // Adicionar popup
    marker.bindPopup(`
      <strong>${t.name || "STARLINK"}</strong><br>
      NORAD: ${t.noradId}<br>
      Lat: ${st.lat.toFixed(2)}°<br>
      Lon: ${st.lon.toFixed(2)}°<br>
      Alt: ${st.alt.toFixed(0)} km<br>
      El: ${st.el.toFixed(1)}°<br>
      Az: ${st.az.toFixed(1)}°
    `);
    
    marker.on("click", () => selectSatellite(t, rec, st));
    
    marker.addTo(layerGroup);
    drawn++;
    
    if (isVisible) {
      visible++;
      
      // Desenhar footprint apenas para satélites visíveis
      if (visible <= 10) { // Limitar footprints para performance
        const rKm = Math.max(200, footprintRadiusKm(st.alt, obs.elevMin));
        L.circle([st.lat, st.lon], {
          radius: rKm * 1000,
          color: "#00ff44",
          weight: 1,
          opacity: 0.3,
          fillOpacity: 0.05,
          interactive: false
        }).addTo(layerGroup);
      }
    }
  }
  
  const elapsed = performance.now() - startTime;
  
  // Atualizar informações
  document.getElementById("visibleInfo").innerHTML = `
    <strong>Visíveis:</strong> ${visible} de ${drawn} desenhados<br>
    <small>Elevação ≥ ${obs.elevMin}° • Tempo: ${elapsed.toFixed(0)}ms</small>
  `;
  
  console.log(`Frame: ${drawn} desenhados, ${visible} visíveis, ${errors} erros, ${elapsed.toFixed(0)}ms`);
  
  isDrawing = false;
}

// Selecionar satélite
function selectSatellite(t, rec, st0) {
  const st = st0 || getSatState(rec);
  if (!st) return;
  
  const info = document.getElementById("sat-info");
  info.innerHTML = `
    <div class="sat-details">
      <h3>${t.name || "STARLINK"}</h3>
      <p><strong>NORAD ID:</strong> ${t.noradId || "—"}</p>
      <p><strong>Posição:</strong> ${st.lat.toFixed(2)}°, ${st.lon.toFixed(2)}°</p>
      <p><strong>Altitude:</strong> ${st.alt.toFixed(0)} km</p>
      <p><strong>Azimute:</strong> ${st.az.toFixed(1)}°</p>
      <p><strong>Elevação:</strong> ${st.el.toFixed(1)}°</p>
      <details>
        <summary>TLE</summary>
        <code style="font-size: 10px; word-break: break-all;">
          ${t.line1}<br>${t.line2}
        </code>
      </details>
    </div>
  `;
  
  // Gráfico SNR simulado
  const elevs = Array.from({length: 19}, (_, k) => k * 5);
  const snr = elevs.map(e => Math.max(-5, 15 + 0.3 * e - 30 / (e + 10)));
  
  Plotly.newPlot("snrPlot", [{
    x: elevs,
    y: snr,
    mode: "lines+markers",
    name: "SNR (dB)",
    line: { color: "#00ff44" }
  }], {
    title: "SNR vs Elevação (simulado)",
    xaxis: { title: "Elevação (°)" },
    yaxis: { title: "SNR (dB)" },
    margin: { t: 40, l: 50, r: 20, b: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  }, {
    displayModeBar: false,
    responsive: true
  });
  
  // Constelação QPSK simulada
  const currentSnr = Math.max(-5, 15 + 0.3 * st.el - 30 / (st.el + 10));
  const noise = 0.3 / Math.sqrt(Math.pow(10, currentSnr / 10));
  const N = 400;
  const xs = [], ys = [];
  
  for (let i = 0; i < N; i++) {
    const sym = [[1, 1], [1, -1], [-1, 1], [-1, -1]][i % 4];
    xs.push(sym[0] + (Math.random() - 0.5) * noise * 2);
    ys.push(sym[1] + (Math.random() - 0.5) * noise * 2);
  }
  
  Plotly.newPlot("constPlot", [{
    x: xs,
    y: ys,
    mode: "markers",
    type: "scatter",
    marker: { 
      color: "#00ff44",
      size: 3
    }
  }], {
    title: `QPSK @ El=${st.el.toFixed(0)}° SNR=${currentSnr.toFixed(1)}dB`,
    xaxis: { 
      range: [-2, 2],
      scaleanchor: "y"
    },
    yaxis: { range: [-2, 2] },
    margin: { t: 40, l: 40, r: 40, b: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  }, {
    displayModeBar: false,
    responsive: true
  });
}

// Iniciar quando o DOM estiver pronto
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
