// app.js - Starlink Dashboard Pro - Versão Corrigida
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

// Estado para Handover
let handoverSimulation = false;
let currentServingSat = null;
let handoverCandidates = [];

// Cache de clima
let weatherData = null;
let weatherLastFetch = 0;

// ============ INICIALIZAÇÃO ============

async function init() {
  console.log("🚀 Iniciando Starlink Dashboard...");
  
  // Mostrar loading
  document.getElementById("meta").textContent = "Carregando dados...";
  
  try {
    // Carregar metadados
    console.log("📊 Buscando metadados...");
    const metaResponse = await fetch(META_URL);
    if (!metaResponse.ok) {
      throw new Error(`HTTP ${metaResponse.status} ao carregar meta.json`);
    }
    const meta = await metaResponse.json();
    
    document.getElementById("meta").innerHTML = 
      `<strong>Satélites:</strong> ${meta.count} • <strong>Fonte:</strong> ${meta.source} • <strong>Atualizado:</strong> ${new Date(meta.updatedAt).toLocaleString('pt-BR')}`;
    console.log("✅ Metadados carregados:", meta);
    
  } catch (e) {
    console.error("❌ Erro ao carregar metadados:", e);
    document.getElementById("meta").textContent = "Erro ao carregar metadados";
  }
  
  try {
    // Carregar TLEs
    console.log("🛰️ Buscando TLEs...");
    const dataResponse = await fetch(DATA_URL);
    if (!dataResponse.ok) {
      throw new Error(`HTTP ${dataResponse.status} ao carregar starlink_tle.json`);
    }
    tleList = await dataResponse.json();
    
    console.log(`✅ ${tleList.length} TLEs carregados`);
    
    // Criar registros SGP4
    console.log("🔧 Processando TLEs...");
    satRecs = tleList.map((t, idx) => {
      try {
        if (!t.line1 || !t.line2) return null;
        return satellite.twoline2satrec(t.line1, t.line2);
      } catch (err) {
        if (idx < 5) console.warn("TLE inválido:", t.noradId, err);
        return null;
      }
    });
    
    const validRecs = satRecs.filter(r => r !== null).length;
    console.log(`✅ ${validRecs} registros SGP4 válidos`);
    
  } catch (e) {
    console.error("❌ Erro ao carregar TLEs:", e);
    document.getElementById("meta").textContent = "Erro ao carregar dados dos satélites";
    alert("Erro ao carregar dados dos satélites. Verifique o console.");
    return;
  }
  
  // Configurar mapa
  console.log("🗺️ Inicializando mapa...");
  initMap();
  
  // Configurar controles
  setupControls();
  
  // Buscar dados de clima
  fetchWeatherData();
  
  // Desenhar primeira vez
  console.log("🎨 Desenhando satélites...");
  drawFrame();
  
  // Loop de atualização
  setInterval(() => {
    if (!isDrawing) {
      drawFrame();
      if (handoverSimulation) simulateHandover();
    }
  }, REFRESH_MS);
  
  console.log("✅ Inicialização completa!");
}

// ============ MAPA ============

function initMap() {
  // Criar mapa
  map = L.map("map", { 
    worldCopyJump: true,
    preferCanvas: true,
    renderer: L.canvas()
  }).setView([obs.lat, obs.lon], 3);
  
  // Adicionar tiles
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 10,
    minZoom: 2
  }).addTo(map);
  
  // Grupos de camadas
  layerGroup = L.layerGroup().addTo(map);
  footprintGroup = L.layerGroup().addTo(map);
  
  // Marcador do observador
  L.marker([obs.lat, obs.lon], {
    title: "Sua localização"
  }).addTo(map).bindPopup("📍 Sua posição");
  
  console.log("✅ Mapa inicializado");
}

function setupControls() {
  // Botão aplicar filtros
  const btnApply = document.getElementById("btnApply");
  if (btnApply) {
    btnApply.onclick = () => {
      obs.elevMin = Number(document.getElementById("elevMin").value) || 25;
      obs.lat = Number(document.getElementById("lat").value) || -27.588;
      obs.lon = Number(document.getElementById("lon").value) || -48.613;
      console.log("📍 Nova posição:", obs);
      
      // Atualizar marcador
      map.setView([obs.lat, obs.lon], map.getZoom());
      
      // Buscar novo clima
      fetchWeatherData();
      
      drawFrame();
    };
  }
  
  // Botão de handover (adicionar ao HTML depois)
  const btnHandover = document.getElementById("btnHandover");
  if (btnHandover) {
    btnHandover.onclick = () => {
      handoverSimulation = !handoverSimulation;
      btnHandover.textContent = handoverSimulation ? "⏸️ Pausar Handover" : "▶️ Simular Handover";
      console.log("🔄 Simulação de handover:", handoverSimulation);
    };
  }
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
    
    // Velocidade
    const speed = Math.sqrt(vel.x**2 + vel.y**2 + vel.z**2);
    
    // Cálculos relativos ao observador
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
    
    return { lat, lon, alt, az, el, range, speed };
  } catch (err) {
    return null;
  }
}

function calculateLinkBudget(elevationDeg, rainAttenuation = 0) {
  const FREQ = 11.5e9; // Hz
  const EIRP = 35; // dBW
  const GAIN = 33; // dBi
  
  const distance = 550 / Math.sin(Math.max(elevationDeg, 1) * Math.PI / 180);
  const FSPL = 20 * Math.log10(distance * 1000) + 20 * Math.log10(FREQ) + 92.45;
  
  const atmosphericLoss = 0.5 / Math.sin(Math.max(elevationDeg, 5) * Math.PI / 180);
  
  const rxPower = EIRP - FSPL - atmosphericLoss - rainAttenuation + GAIN;
  const noiseFloor = -134; // dBW para 250 MHz de banda
  const SNR = rxPower - noiseFloor;
  
  return { SNR, rxPower, FSPL, rainAttenuation };
}

// ============ CLIMA ============

async function fetchWeatherData() {
  const now = Date.now();
  
  // Cache de 30 minutos
  if (weatherData && (now - weatherLastFetch) < 30 * 60 * 1000) {
    return weatherData;
  }
  
  try {
    // API OpenWeatherMap gratuita (você precisa de uma chave)
    // Por enquanto, vamos simular
    console.log("☁️ Simulando dados de clima...");
    
    weatherData = {
      cloudCover: Math.random() * 100, // %
      precipitation: Math.random() * 10, // mm/h
      humidity: 60 + Math.random() * 30, // %
      temperature: 20 + Math.random() * 15 // °C
    };
    
    weatherLastFetch = now;
    updateWeatherDisplay();
    
  } catch (e) {
    console.error("Erro ao buscar clima:", e);
    weatherData = { cloudCover: 0, precipitation: 0, humidity: 70, temperature: 25 };
  }
  
  return weatherData;
}

function calculateRainAttenuation(elevation, precipitation) {
  // Modelo ITU-R P.838 simplificado
  if (precipitation === 0) return 0;
  
  const freq = 11.5; // GHz
  const k = 0.0101 * Math.pow(freq, 2.03); // Coeficiente para polarização horizontal
  const alpha = 1.065;
  
  const slantPath = 550 / Math.sin(Math.max(elevation, 5) * Math.PI / 180);
  const attenuation = k * Math.pow(precipitation, alpha) * Math.min(slantPath / 10, 5);
  
  return Math.min(attenuation, 20); // Máximo 20 dB
}

function updateWeatherDisplay() {
  if (!weatherData) return;
  
  const weatherInfo = document.getElementById("weatherInfo");
  if (weatherInfo) {
    weatherInfo.innerHTML = `
      <h4>🌤️ Condições Atmosféricas</h4>
      <p>☁️ Nuvens: ${weatherData.cloudCover.toFixed(0)}%</p>
      <p>🌧️ Precipitação: ${weatherData.precipitation.toFixed(1)} mm/h</p>
      <p>💧 Umidade: ${weatherData.humidity.toFixed(0)}%</p>
      <p>🌡️ Temperatura: ${weatherData.temperature.toFixed(1)}°C</p>
      <p>📡 Atenuação por chuva: ${calculateRainAttenuation(45, weatherData.precipitation).toFixed(1)} dB</p>
    `;
  }
}

// ============ HANDOVER ============

function simulateHandover() {
  if (!currentServingSat) {
    // Encontrar satélite servindo
    const visible = [];
    
    for (let i = 0; i < tleList.length; i++) {
      const rec = satRecs[i];
      if (!rec) continue;
      
      const st = getSatState(rec);
      if (!st || st.el < obs.elevMin) continue;
      
      const linkBudget = calculateLinkBudget(st.el, calculateRainAttenuation(st.el, weatherData?.precipitation || 0));
      
      visible.push({
        satellite: tleList[i],
        state: st,
        snr: linkBudget.SNR,
        index: i
      });
    }
    
    if (visible.length > 0) {
      // Escolher o melhor SNR
      visible.sort((a, b) => b.snr - a.snr);
      currentServingSat = visible[0];
      handoverCandidates = visible.slice(1, 4); // Top 3 candidatos
      
      console.log(`📡 Servindo: ${currentServingSat.satellite.name} (SNR: ${currentServingSat.snr.toFixed(1)} dB)`);
    }
  } else {
    // Verificar se precisa handover
    const currentState = getSatState(satRecs[currentServingSat.index]);
    
    if (!currentState || currentState.el < obs.elevMin - 5) {
      // Fazer handover
      console.log(`🔄 Handover necessário! ${currentServingSat.satellite.name} saindo de visibilidade`);
      
      if (handoverCandidates.length > 0) {
        const newServing = handoverCandidates[0];
        console.log(`✅ Handover para: ${newServing.satellite.name}`);
        
        // Notificar handover
        showHandoverNotification(currentServingSat.satellite.name, newServing.satellite.name);
        
        currentServingSat = newServing;
        handoverCandidates = handoverCandidates.slice(1);
      } else {
        currentServingSat = null;
      }
    }
  }
  
  updateHandoverDisplay();
}

function showHandoverNotification(from, to) {
  const notification = document.createElement("div");
  notification.className = "handover-notification";
  notification.innerHTML = `
    <strong>🔄 HANDOVER</strong><br>
    De: ${from}<br>
    Para: ${to}
  `;
  notification.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    background: linear-gradient(135deg, #ff6b00, #ff8c00);
    color: white;
    padding: 15px;
    border-radius: 10px;
    z-index: 10000;
    animation: slideIn 0.5s;
    box-shadow: 0 4px 20px rgba(255, 107, 0, 0.5);
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = "slideOut 0.5s";
    setTimeout(() => notification.remove(), 500);
  }, 3000);
}

function updateHandoverDisplay() {
  const handoverInfo = document.getElementById("handoverInfo");
  if (!handoverInfo) return;
  
  let html = "<h4>🔄 Simulação de Handover</h4>";
  
  if (currentServingSat) {
    const state = getSatState(satRecs[currentServingSat.index]);
    if (state) {
      html += `
        <p><strong>Servindo:</strong> ${currentServingSat.satellite.name}</p>
        <p>SNR: ${currentServingSat.snr.toFixed(1)} dB | El: ${state.el.toFixed(1)}°</p>
      `;
    }
  }
  
  if (handoverCandidates.length > 0) {
    html += "<p><strong>Candidatos:</strong></p><ul>";
    handoverCandidates.forEach(c => {
      html += `<li>${c.satellite.name} (${c.snr.toFixed(1)} dB)</li>`;
    });
    html += "</ul>";
  }
  
  handoverInfo.innerHTML = html;
}

// ============ DESENHO ============

function drawFrame() {
  if (isDrawing) return;
  isDrawing = true;
  
  const startTime = performance.now();
  
  // Limpar camadas
  layerGroup.clearLayers();
  footprintGroup.clearLayers();
  
  let visible = 0;
  let drawn = 0;
  const MAX_DRAW = 1000;
  const step = Math.ceil(tleList.length / MAX_DRAW);
  
  // Processar satélites
  for (let i = 0; i < tleList.length; i += step) {
    const t = tleList[i];
    const rec = satRecs[i];
    
    if (!rec) continue;
    
    const st = getSatState(rec);
    if (!st) continue;
    
    const isVisible = st.el >= obs.elevMin;
    const isServing = currentServingSat && currentServingSat.index === i;
    const isCandidate = handoverCandidates.some(c => c.index === i);
    
    // Determinar cor
    let color = '#4488ff'; // Azul: não visível
    let radius = 2;
    
    if (isServing) {
      color = '#ff00ff'; // Magenta: servindo
      radius = 8;
    } else if (isCandidate) {
      color = '#ffaa00'; // Laranja: candidato handover
      radius = 6;
    } else if (isVisible) {
      color = '#00ff44'; // Verde: visível
      radius = 4;
      visible++;
    }
    
    // Criar marcador
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: radius,
      weight: 1,
      color: color,
      fillColor: color,
      fillOpacity: 0.8
    });
    
    // Calcular atenuação por chuva
    const rainAtt = weatherData ? calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
    const linkBudget = calculateLinkBudget(st.el, rainAtt);
    
    marker.bindPopup(`
      <strong>${t.name || "STARLINK"}</strong><br>
      NORAD: ${t.noradId}<br>
      Alt: ${st.alt.toFixed(0)} km<br>
      El: ${st.el.toFixed(1)}°<br>
      Az: ${st.az.toFixed(1)}°<br>
      SNR: ${linkBudget.SNR.toFixed(1)} dB<br>
      Atenuação chuva: ${rainAtt.toFixed(1)} dB
    `);
    
    marker.on('click', () => selectSatellite(t, rec, st));
    
    marker.addTo(layerGroup);
    drawn++;
    
    // Desenhar footprint para satélites visíveis
    if (isVisible && visible <= 3) {
      const footprintRadius = calculateFootprintRadius(st.alt, obs.elevMin);
      L.circle([st.lat, st.lon], {
        radius: footprintRadius * 1000,
        color: color,
        weight: 1,
        opacity: 0.3,
        fillOpacity: 0.05,
        interactive: false
      }).addTo(footprintGroup);
    }
  }
  
  const elapsed = performance.now() - startTime;
  
  // Atualizar display
  document.getElementById("visibleInfo").innerHTML = 
    `<strong>Visíveis:</strong> ${visible}<br>
     <small>Desenhados: ${drawn} | Tempo: ${elapsed.toFixed(0)}ms</small>`;
  
  isDrawing = false;
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
  
  const rainAtt = weatherData ? calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
  const linkBudget = calculateLinkBudget(st.el, rainAtt);
  
  const info = document.getElementById("sat-info");
  if (info) {
    info.innerHTML = `
      <h3>${t.name || "STARLINK"}</h3>
      <p><strong>NORAD:</strong> ${t.noradId}</p>
      <p><strong>Posição:</strong> ${st.lat.toFixed(2)}°, ${st.lon.toFixed(2)}°</p>
      <p><strong>Altitude:</strong> ${st.alt.toFixed(0)} km</p>
      <p><strong>Velocidade:</strong> ${st.speed.toFixed(1)} km/s</p>
      <p><strong>Elevação:</strong> ${st.el.toFixed(1)}°</p>
      <p><strong>Azimute:</strong> ${st.az.toFixed(1)}°</p>
      <p><strong>Distância:</strong> ${st.range.toFixed(0)} km</p>
      <hr>
      <p><strong>📡 Link Budget:</strong></p>
      <p>SNR: ${linkBudget.SNR.toFixed(1)} dB</p>
      <p>Potência Rx: ${linkBudget.rxPower.toFixed(1)} dBW</p>
      <p>FSPL: ${linkBudget.FSPL.toFixed(1)} dB</p>
      <p>Atenuação chuva: ${rainAtt.toFixed(1)} dB</p>
    `;
  }
  
  updateRFPlots(st, linkBudget);
}

function updateRFPlots(st, linkBudget) {
  // Plotar SNR vs Elevação
  if (typeof Plotly !== 'undefined') {
    const elevs = Array.from({length: 19}, (_, k) => k * 5);
    const rainAtt = weatherData ? calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
    const snrs = elevs.map(e => calculateLinkBudget(e, calculateRainAttenuation(e, weatherData?.precipitation || 0)).SNR);
    
    Plotly.newPlot("snrPlot", [{
      x: elevs,
      y: snrs,
      mode: "lines+markers",
      name: "SNR com clima",
      line: { color: "#00ff44" }
    }], {
      title: `SNR vs Elevação (Chuva: ${weatherData?.precipitation.toFixed(1) || 0} mm/h)`,
      xaxis: { title: "Elevação (°)" },
      yaxis: { title: "SNR (dB)" },
      margin: { t: 40 },
      paper_bgcolor: "#111a2e",
      plot_bgcolor: "#0b1220",
      font: { color: "#e8f0ff" }
    }, { displayModeBar: false });
    
    // Constelação
    const noise = 0.5 / Math.sqrt(Math.pow(10, linkBudget.SNR / 10));
    const xs = [], ys = [];
    for (let i = 0; i < 500; i++) {
      const sym = [[1,1],[1,-1],[-1,1],[-1,-1]][i % 4];
      xs.push(sym[0] + (Math.random() - 0.5) * noise * 2);
      ys.push(sym[1] + (Math.random() - 0.5) * noise * 2);
    }
    
    Plotly.newPlot("constPlot", [{
      x: xs,
      y: ys,
      mode: "markers",
      type: "scatter",
      marker: { color: "#00ff44", size: 2 }
    }], {
      title: `QPSK @ SNR=${linkBudget.SNR.toFixed(1)}dB`,
      xaxis: { range: [-2, 2], scaleanchor: "y" },
      yaxis: { range: [-2, 2] },
      margin: { t: 40 },
      paper_bgcolor: "#111a2e",
      plot_bgcolor: "#0b1220",
      font: { color: "#e8f0ff" }
    }, { displayModeBar: false });
  }
}

// ============ TABS (SIMPLIFICADO) ============

function switchTab(tabName) {
  console.log("Switching to tab:", tabName);
  
  // Por enquanto, vamos manter só o mapa
  // As outras abas podem ser adicionadas depois
}

// ============ CSS ANIMATIONS ============

const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);

// ============ INICIAR ============

// Esperar DOM carregar
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Exportar funções globais
window.switchTab = switchTab;
