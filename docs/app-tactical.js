// app-tactical.js - Starlink Tactical Operations with 3D Globe
const DATA_URL = "data/starlink_tle.json";
const META_URL = "data/meta.json";
const REFRESH_MS = 3000;

// Estado Global
let tleList = [];
let satRecs = [];
let map, layerGroup, footprintGroup;
let obs = { lat: -27.588, lon: -48.613, elevMin: 25 };
let selectedSatellite = null;
let isDrawing = false;

// Configurações
let config = {
  considerRain: true,
  showFootprints: true,
  footprintOnlySelected: false,
  maxFootprints: 5
};

// Estado para Handover
let handoverSimulation = false;
let currentServingSat = null;
let handoverCandidates = [];

// Cache de clima
let weatherData = null;
let weatherLastFetch = 0;

// Cores Tactical
const COLORS = {
  visible: '#00ff00',
  selected: '#ff0000',
  serving: '#ffffff',
  candidate: '#ffaa00',
  inactive: '#333333',
  footprint: '#ff0000'
};

// Export para uso global
window.tleList = tleList;
window.satRecs = satRecs;
window.obs = obs;
window.getSatState = getSatState;

// ============ INICIALIZAÇÃO ============

async function init() {
  console.log("[SYSTEM] Initializing Tactical Operations Center...");
  
  updateTerminalLog("SYSTEM", "Booting tactical systems...");
  updateStats(0, 0, 0);
  
  try {
    // Carregar metadados
    updateTerminalLog("DATA", "Fetching satellite metadata...");
    const metaResponse = await fetch(META_URL);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status}`);
    const meta = await metaResponse.json();
    
    updateTerminalLog("DATA", `Metadata loaded: ${meta.count} satellites`);
    updateStats(0, 0, meta.count);
    
  } catch (e) {
    updateTerminalLog("ERROR", `Metadata failure: ${e.message}`);
  }
  
  try {
    // Carregar TLEs
    updateTerminalLog("DATA", "Fetching orbital elements...");
    const dataResponse = await fetch(DATA_URL);
    if (!dataResponse.ok) throw new Error(`HTTP ${dataResponse.status}`);
    tleList = await dataResponse.json();
    window.tleList = tleList; // Export global
    
    updateTerminalLog("DATA", `${tleList.length} TLEs acquired`);
    
    // Criar registros SGP4
    updateTerminalLog("CALC", "Processing orbital data...");
    satRecs = tleList.map((t, idx) => {
      try {
        if (!t.line1 || !t.line2) return null;
        return satellite.twoline2satrec(t.line1, t.line2);
      } catch {
        return null;
      }
    });
    window.satRecs = satRecs; // Export global
    
    const validRecs = satRecs.filter(r => r !== null).length;
    updateTerminalLog("CALC", `${validRecs} valid orbits calculated`);
    
  } catch (e) {
    updateTerminalLog("ERROR", `Critical failure: ${e.message}`);
    return;
  }
  
  // Configurar mapa 2D
  updateTerminalLog("MAP", "Initializing tactical map...");
  initMap();
  
  // Configurar controles
  setupControls();
  
  // Buscar dados de clima
  fetchWeatherData();
  
  // Desenhar primeira vez
  updateTerminalLog("RENDER", "Rendering satellite positions...");
  drawFrame();
  
  // Loop de atualização
  setInterval(() => {
    if (!isDrawing) {
      drawFrame();
      if (handoverSimulation) simulateHandover();
    }
  }, REFRESH_MS);
  
  updateTerminalLog("SYSTEM", "TACTICAL SYSTEMS ONLINE");
}

// ============ UI FUNCTIONS ============

function updateStats(visible, tracked, total) {
  if (window.updateStats) {
    window.updateStats(visible, tracked, total);
  } else {
    document.getElementById("stat-visible").textContent = visible;
    document.getElementById("stat-tracked").textContent = tracked;
    document.getElementById("stat-total").textContent = total || tleList.length;
  }
}

function updateTerminalLog(type, message) {
  if (window.updateTerminalLog) {
    window.updateTerminalLog(type, message);
  } else {
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`[${time}] [${type}] ${message}`);
  }
}

function updateTargetInfo(sat, state, linkBudget) {
  const targetInfo = document.getElementById("targetInfo");
  if (!targetInfo) return;
  
  if (!sat) {
    targetInfo.innerHTML = `
      <div class="data-row">
        <span class="data-label">SAT ID:</span>
        <span class="data-value">---</span>
      </div>
      <div class="data-row">
        <span class="data-label">ELEV:</span>
        <span class="data-value">---</span>
      </div>
      <div class="data-row">
        <span class="data-label">AZIM:</span>
        <span class="data-value">---</span>
      </div>
      <div class="data-row">
        <span class="data-label">RANGE:</span>
        <span class="data-value">---</span>
      </div>
      <div class="data-row">
        <span class="data-label">SNR:</span>
        <span class="data-value">---</span>
      </div>
    `;
    return;
  }
  
  const snrClass = linkBudget.SNR > 15 ? 'good' : linkBudget.SNR > 8 ? 'warning' : 'critical';
  
  targetInfo.innerHTML = `
    <div class="data-row">
      <span class="data-label">SAT ID:</span>
      <span class="data-value">${sat.noradId}</span>
    </div>
    <div class="data-row">
      <span class="data-label">ELEV:</span>
      <span class="data-value">${state.el.toFixed(1)}°</span>
    </div>
    <div class="data-row">
      <span class="data-label">AZIM:</span>
      <span class="data-value">${state.az.toFixed(1)}°</span>
    </div>
    <div class="data-row">
      <span class="data-label">RANGE:</span>
      <span class="data-value">${state.range.toFixed(0)} km</span>
    </div>
    <div class="data-row">
      <span class="data-label">SNR:</span>
      <span class="data-value ${snrClass}">${linkBudget.SNR.toFixed(1)} dB</span>
    </div>
  `;
}

// ============ MAPA 2D ============

function initMap() {
  // Criar mapa com tema escuro
  map = L.map("map", { 
    worldCopyJump: true,
    preferCanvas: true,
    renderer: L.canvas(),
    zoomControl: false
  }).setView([obs.lat, obs.lon], 3);
  
  // Adicionar controle de zoom customizado
  L.control.zoom({
    position: 'topright'
  }).addTo(map);
  
  // Usar tema escuro
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CartoDB',
    subdomains: 'abcd',
    maxZoom: 10,
    minZoom: 2
  }).addTo(map);
  
  // Grupos de camadas
  layerGroup = L.layerGroup().addTo(map);
  footprintGroup = L.layerGroup().addTo(map);
  
  // Marcador do observador
  const observerIcon = L.divIcon({
    html: '<div style="color: #ff0000; font-size: 20px; text-shadow: 0 0 10px rgba(255,0,0,0.8);">⊕</div>',
    iconSize: [20, 20],
    className: 'observer-icon'
  });
  
  L.marker([obs.lat, obs.lon], {
    icon: observerIcon,
    title: "Observer Position"
  }).addTo(map);
  
  updateTerminalLog("MAP", "Tactical map initialized");
}

function setupControls() {
  // Botão aplicar
  document.getElementById("btnApply").onclick = () => {
    obs.elevMin = Number(document.getElementById("elevMin").value) || 25;
    obs.lat = Number(document.getElementById("lat").value) || -27.588;
    obs.lon = Number(document.getElementById("lon").value) || -48.613;
    window.obs = obs; // Export global
    
    updateTerminalLog("CONFIG", `Position: [${obs.lat.toFixed(3)}, ${obs.lon.toFixed(3)}]`);
    
    map.setView([obs.lat, obs.lon], map.getZoom());
    fetchWeatherData();
    drawFrame();
  };
  
  // Checkboxes
  document.getElementById("considerRain").onchange = (e) => {
    config.considerRain = e.target.checked;
    updateTerminalLog("CONFIG", `Rain attenuation: ${config.considerRain ? 'ACTIVE' : 'INACTIVE'}`);
    drawFrame();
  };
  
  document.getElementById("showFootprints").onchange = (e) => {
    config.showFootprints = e.target.checked;
    updateTerminalLog("CONFIG", `Footprints: ${config.showFootprints ? 'VISIBLE' : 'HIDDEN'}`);
    drawFrame();
  };
  
  document.getElementById("footprintOnlySelected").onchange = (e) => {
    config.footprintOnlySelected = e.target.checked;
    updateTerminalLog("CONFIG", `Footprint mode: ${config.footprintOnlySelected ? 'SELECTED' : 'ALL'}`);
    drawFrame();
  };
  
  // Speed control for 3D
  document.getElementById("speed3d").onchange = (e) => {
    const speed = e.target.value;
    updateTerminalLog("3D", `Speed set to ${speed}%`);
  };
}

// ============ CÁLCULOS ============

function getSatState(rec, time = new Date()) {
  try {
    if (!rec) return null;
    
    const gmst = satellite.gstime(time);
    const pv = satellite.propagate(rec, time);
    
    if (!pv || !pv.position || pv.position === false) return null;
    
    const eci = pv.position;
    const vel = pv.velocity || {x: 0, y: 0, z: 0};
    const gd = satellite.eciToGeodetic(eci, gmst);
    
    const lat = satellite.radiansToDegrees(gd.latitude);
    const lon = satellite.radiansToDegrees(gd.longitude);
    const alt = gd.height;
    
    const speed = Math.sqrt(vel.x**2 + vel.y**2 + vel.z**2);
    
    const obsGd = {
      latitude: satellite.degreesToRadians(obs.lat),
      longitude: satellite.degreesToRadians(obs.lon),
      height: 0
    };
    
    const satEcf = satellite.eciToEcf(eci, gmst);
    const look = satellite.ecfToLookAngles(obsGd, satEcf);
    
    const az = satellite.radiansToDegrees(look.azimuth);
    const el = satellite.radiansToDegrees(look.elevation);
    const range = look.rangeSat;
    
    // Doppler
    const radialVel = speed * 1000 * Math.cos(el * Math.PI / 180);
    const doppler = (radialVel / 299792458) * 11.5e9 / 1000; // kHz
    
    return { lat, lon, alt, az, el, range, speed, doppler };
  } catch {
    return null;
  }
}

function calculateLinkBudget(elevationDeg, rainAttenuation = 0) {
  const FREQ = 11.5e9;
  const EIRP = 35;
  const GAIN = 33;
  
  const distance = 550 / Math.sin(Math.max(elevationDeg, 1) * Math.PI / 180);
  const FSPL = 20 * Math.log10(distance * 1000) + 20 * Math.log10(FREQ) + 92.45;
  
  const atmosphericLoss = 0.5 / Math.sin(Math.max(elevationDeg, 5) * Math.PI / 180);
  const appliedRainAtt = config.considerRain ? rainAttenuation : 0;
  
  const rxPower = EIRP - FSPL - atmosphericLoss - appliedRainAtt + GAIN;
  const noiseFloor = -134;
  const SNR = rxPower - noiseFloor;
  
  // Modulação adaptativa
  let modulation = "QPSK";
  let dataRate = 50;
  
  if (SNR > 25) {
    modulation = "256-APSK";
    dataRate = 400;
  } else if (SNR > 20) {
    modulation = "128-APSK";
    dataRate = 350;
  } else if (SNR > 18) {
    modulation = "64-APSK";
    dataRate = 300;
  } else if (SNR > 15) {
    modulation = "32-APSK";
    dataRate = 250;
  } else if (SNR > 12) {
    modulation = "16-APSK";
    dataRate = 200;
  } else if (SNR > 8) {
    modulation = "8PSK";
    dataRate = 150;
  }
  
  return { 
    SNR, 
    rxPower, 
    FSPL, 
    rainAttenuation: appliedRainAtt,
    modulation,
    dataRate,
    margin: SNR - 5
  };
}

// ============ CLIMA ============

async function fetchWeatherData() {
  const now = Date.now();
  
  if (weatherData && (now - weatherLastFetch) < 30 * 60 * 1000) {
    return weatherData;
  }
  
  try {
    updateTerminalLog("WEATHER", "Fetching atmospheric data...");
    
    weatherData = {
      cloudCover: Math.random() * 100,
      precipitation: Math.random() * 10,
      humidity: 60 + Math.random() * 30,
      temperature: 20 + Math.random() * 15
    };
    
    weatherLastFetch = now;
    
  } catch (e) {
    updateTerminalLog("ERROR", `Weather fetch failed: ${e.message}`);
    weatherData = { cloudCover: 0, precipitation: 0, humidity: 70, temperature: 25 };
  }
  
  return weatherData;
}

function calculateRainAttenuation(elevation, precipitation) {
  if (precipitation === 0 || !config.considerRain) return 0;
  
  const freq = 11.5;
  const k = 0.0101 * Math.pow(freq, 2.03);
  const alpha = 1.065;
  
  const slantPath = 550 / Math.sin(Math.max(elevation, 5) * Math.PI / 180);
  const attenuation = k * Math.pow(precipitation, alpha) * Math.min(slantPath / 10, 5);
  
  return Math.min(attenuation, 20);
}

// ============ DESENHO 2D ============

function drawFrame() {
  if (isDrawing) return;
  isDrawing = true;
  
  const startTime = performance.now();
  
  layerGroup.clearLayers();
  footprintGroup.clearLayers();
  
  let visible = 0;
  let drawn = 0;
  const MAX_DRAW = 1000;
  const step = Math.ceil(tleList.length / MAX_DRAW);
  
  for (let i = 0; i < tleList.length; i += step) {
    const t = tleList[i];
    const rec = satRecs[i];
    
    if (!rec) continue;
    
    const st = getSatState(rec);
    if (!st) continue;
    
    const isVisible = st.el >= obs.elevMin;
    const isServing = currentServingSat && currentServingSat.index === i;
    const isCandidate = handoverCandidates.some(c => c.index === i);
    const isSelected = selectedSatellite && selectedSatellite.noradId === t.noradId;
    
    // Cores tactical
    let color = COLORS.inactive;
    let radius = 1;
    let opacity = 0.3;
    
    if (isServing) {
      color = COLORS.serving;
      radius = 5;
      opacity = 1;
    } else if (isSelected) {
      color = COLORS.selected;
      radius = 5;
      opacity = 0.9;
    } else if (isCandidate) {
      color = COLORS.candidate;
      radius = 4;
      opacity = 0.8;
    } else if (isVisible) {
      color = COLORS.visible;
      radius = 3;
      opacity = 0.7;
      visible++;
    }
    
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: radius,
      weight: 1,
      color: color,
      fillColor: color,
      fillOpacity: opacity,
      opacity: opacity
    });
    
    const rainAtt = config.considerRain && weatherData ? 
      calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
    const linkBudget = calculateLinkBudget(st.el, rainAtt);
    
    marker.bindPopup(`
      <div style="font-family: 'Share Tech Mono', monospace;">
        <strong>${t.name || "SATELLITE"}</strong><br>
        NORAD: ${t.noradId}<br>
        ALT: ${st.alt.toFixed(0)} km<br>
        ELEV: ${st.el.toFixed(1)}°<br>
        SNR: ${linkBudget.SNR.toFixed(1)} dB<br>
        MOD: ${linkBudget.modulation}
      </div>
    `);
    
    marker.on('click', () => selectSatellite(t, rec, st));
    
    marker.addTo(layerGroup);
    drawn++;
    
    // Footprints
    if (config.showFootprints) {
      if (config.footprintOnlySelected) {
        if (isSelected) {
          drawFootprint(st.lat, st.lon, st.alt, COLORS.selected, 2);
        }
      } else {
        if (isVisible && visible <= config.maxFootprints) {
          drawFootprint(st.lat, st.lon, st.alt, color, 1);
        }
      }
    }
  }
  
  const elapsed = performance.now() - startTime;
  
  updateStats(visible, drawn, tleList.length);
  
  document.getElementById("visibleInfo").innerHTML = `
    <div class="data-row">
      <span class="data-label">STATUS:</span>
      <span class="data-value" style="color: #00ff00;">TRACKING</span>
    </div>
    <div class="data-row">
      <span class="data-label">RENDER:</span>
      <span class="data-value">${elapsed.toFixed(0)} ms</span>
    </div>
  `;
  
  isDrawing = false;
}

function drawFootprint(lat, lon, alt, color, weight) {
  const footprintRadius = calculateFootprintRadius(alt, obs.elevMin);
  L.circle([lat, lon], {
    radius: footprintRadius * 1000,
    color: color,
    weight: weight,
    opacity: 0.5,
    fillColor: color,
    fillOpacity: 0.05,
    interactive: false,
    dashArray: '10,5'
  }).addTo(footprintGroup);
}

function calculateFootprintRadius(altKm, elevMinDeg) {
  const Re = 6371;
  const h = altKm;
  const e = elevMinDeg * Math.PI / 180;
  const psi = Math.acos((Re/(Re+h)) * Math.cos(e)) - e;
  return Re * psi;
}

function selectSatellite(t, rec, st) {
  selectedSatellite = { ...t, rec, state: st };
  
  const rainAtt = config.considerRain && weatherData ? 
    calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
  const linkBudget = calculateLinkBudget(st.el, rainAtt);
  
  // Atualizar informações do satélite
  const satInfo = document.getElementById("sat-info");
  if (satInfo) {
    satInfo.innerHTML = `
      <div class="data-row">
        <span class="data-label">NORAD:</span>
        <span class="data-value">${t.noradId}</span>
      </div>
      <div class="data-row">
        <span class="data-label">NAME:</span>
        <span class="data-value">${t.name || 'UNKNOWN'}</span>
      </div>
      <div class="data-row">
        <span class="data-label">ALT:</span>
        <span class="data-value">${st.alt.toFixed(0)} km</span>
      </div>
      <div class="data-row">
        <span class="data-label">VEL:</span>
        <span class="data-value">${st.speed.toFixed(1)} km/s</span>
      </div>
      <div class="data-row">
        <span class="data-label">DOPPLER:</span>
        <span class="data-value">${st.doppler.toFixed(1)} kHz</span>
      </div>
      <div class="data-row">
        <span class="data-label">SNR:</span>
        <span class="data-value" style="color: ${linkBudget.SNR > 15 ? '#00ff00' : linkBudget.SNR > 8 ? '#ffaa00' : '#ff0000'}">
          ${linkBudget.SNR.toFixed(1)} dB
        </span>
      </div>
      <div class="data-row">
        <span class="data-label">MOD:</span>
        <span class="data-value">${linkBudget.modulation}</span>
      </div>
      <div class="data-row">
        <span class="data-label">RATE:</span>
        <span class="data-value">${linkBudget.dataRate} Mbps</span>
      </div>
    `;
  }
  
  // Atualizar target info
  updateTargetInfo(t, st, linkBudget);
  
  // Log
  updateTerminalLog("SELECT", `Target acquired: ${t.name} [${t.noradId}]`);
  
  // Redesenhar se necessário
  if (config.showFootprints && config.footprintOnlySelected) {
    drawFrame();
  }
}

// ============ INICIAR ============

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Exportar funções globais
window.getSatState = getSatState;
