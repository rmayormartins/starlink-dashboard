// app.js - Starlink Dashboard Terminal Edition
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
  maxFootprints: 5,
  terminalMode: true
};

// Estado para Handover
let handoverSimulation = false;
let currentServingSat = null;
let handoverCandidates = [];

// Cache de clima
let weatherData = null;
let weatherLastFetch = 0;

// ============ INICIALIZAÇÃO ============

async function init() {
  console.log("%c[SYSTEM] INITIALIZING STARLINK TRACKING SYSTEM...", "color: #00ff00");
  
  // ASCII Art no console
  console.log(`%c
╔═══════════════════════════════════════════╗
║     STARLINK ORBITAL TRACKING SYSTEM     ║
║         IFSC - SÃO JOSÉ CAMPUS           ║
╚═══════════════════════════════════════════╝
  `, "color: #00ff00; font-family: monospace");
  
  // Mostrar loading
  updateTerminalLog("SYSTEM", "Loading satellite data...");
  document.getElementById("meta").innerHTML = '<span class="blink">LOADING...</span>';
  
  try {
    // Carregar metadados
    updateTerminalLog("DATA", "Fetching metadata...");
    const metaResponse = await fetch(META_URL);
    if (!metaResponse.ok) {
      throw new Error(`HTTP ${metaResponse.status}`);
    }
    const meta = await metaResponse.json();
    
    document.getElementById("meta").innerHTML = 
      `[SATS: ${meta.count}] [SRC: ${meta.source}] [UPD: ${new Date(meta.updatedAt).toLocaleString('pt-BR')}]`;
    updateTerminalLog("DATA", `Metadata loaded: ${meta.count} satellites`);
    
  } catch (e) {
    updateTerminalLog("ERROR", `Failed to load metadata: ${e.message}`);
    document.getElementById("meta").textContent = "[ERROR: METADATA FAILURE]";
  }
  
  try {
    // Carregar TLEs
    updateTerminalLog("DATA", "Fetching TLE data...");
    const dataResponse = await fetch(DATA_URL);
    if (!dataResponse.ok) {
      throw new Error(`HTTP ${dataResponse.status}`);
    }
    tleList = await dataResponse.json();
    
    updateTerminalLog("DATA", `${tleList.length} TLEs loaded successfully`);
    
    // Criar registros SGP4
    updateTerminalLog("CALC", "Processing orbital elements...");
    satRecs = tleList.map((t, idx) => {
      try {
        if (!t.line1 || !t.line2) return null;
        return satellite.twoline2satrec(t.line1, t.line2);
      } catch (err) {
        return null;
      }
    });
    
    const validRecs = satRecs.filter(r => r !== null).length;
    updateTerminalLog("CALC", `${validRecs} valid SGP4 records created`);
    
  } catch (e) {
    updateTerminalLog("ERROR", `Critical failure: ${e.message}`);
    document.getElementById("meta").textContent = "[ERROR: DATA LOAD FAILURE]";
    alert("SYSTEM ERROR: Failed to load satellite data");
    return;
  }
  
  // Configurar mapa
  updateTerminalLog("MAP", "Initializing map system...");
  initMap();
  
  // Configurar controles
  setupControls();
  
  // Buscar dados de clima
  fetchWeatherData();
  
  // Desenhar primeira vez
  updateTerminalLog("RENDER", "Rendering satellites...");
  drawFrame();
  
  // Loop de atualização
  setInterval(() => {
    if (!isDrawing) {
      drawFrame();
      if (handoverSimulation) simulateHandover();
    }
  }, REFRESH_MS);
  
  updateTerminalLog("SYSTEM", "INITIALIZATION COMPLETE");
}

// ============ TERMINAL LOG ============

function updateTerminalLog(type, message) {
  const time = new Date().toLocaleTimeString('pt-BR');
  console.log(`%c[${time}] [${type}] ${message}`, "color: #00ff00; font-family: monospace");
  
  // Adicionar ao terminal visual se existir
  const terminal = document.getElementById("terminalOutput");
  if (terminal) {
    const line = document.createElement("div");
    line.className = "terminal-line";
    line.innerHTML = `<span class="time">[${time}]</span> <span class="type">[${type}]</span> ${message}`;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
    
    // Limitar a 50 linhas
    while (terminal.children.length > 50) {
      terminal.removeChild(terminal.firstChild);
    }
  }
}

// ============ MAPA ============

function initMap() {
  // Criar mapa com tema escuro
  map = L.map("map", { 
    worldCopyJump: true,
    preferCanvas: true,
    renderer: L.canvas()
  }).setView([obs.lat, obs.lon], 3);
  
  // Usar tema escuro do CartoDB
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CartoDB',
    subdomains: 'abcd',
    maxZoom: 10,
    minZoom: 2
  }).addTo(map);
  
  // Grupos de camadas
  layerGroup = L.layerGroup().addTo(map);
  footprintGroup = L.layerGroup().addTo(map);
  
  // Marcador do observador com estilo terminal
  const observerIcon = L.divIcon({
    html: '<div class="observer-marker">[OBS]</div>',
    iconSize: [40, 20],
    className: 'terminal-marker'
  });
  
  L.marker([obs.lat, obs.lon], {
    icon: observerIcon,
    title: "Observer Location"
  }).addTo(map).bindPopup("[OBSERVER_POSITION]<br>LAT: " + obs.lat + "<br>LON: " + obs.lon);
  
  updateTerminalLog("MAP", "Map initialized with dark theme");
}

function setupControls() {
  // Botão aplicar filtros
  const btnApply = document.getElementById("btnApply");
  if (btnApply) {
    btnApply.onclick = () => {
      obs.elevMin = Number(document.getElementById("elevMin").value) || 25;
      obs.lat = Number(document.getElementById("lat").value) || -27.588;
      obs.lon = Number(document.getElementById("lon").value) || -48.613;
      
      updateTerminalLog("CONFIG", `Position updated: [${obs.lat.toFixed(3)}, ${obs.lon.toFixed(3)}]`);
      
      map.setView([obs.lat, obs.lon], map.getZoom());
      fetchWeatherData();
      drawFrame();
    };
  }
  
  // Checkbox atenuação por chuva
  const rainCheck = document.getElementById("considerRain");
  if (rainCheck) {
    rainCheck.checked = config.considerRain;
    rainCheck.onchange = () => {
      config.considerRain = rainCheck.checked;
      updateTerminalLog("CONFIG", `Rain attenuation: ${config.considerRain ? 'ENABLED' : 'DISABLED'}`);
      drawFrame();
    };
  }
  
  // Checkbox footprints
  const footprintCheck = document.getElementById("showFootprints");
  if (footprintCheck) {
    footprintCheck.checked = config.showFootprints;
    footprintCheck.onchange = () => {
      config.showFootprints = footprintCheck.checked;
      updateTerminalLog("CONFIG", `Footprints: ${config.showFootprints ? 'ENABLED' : 'DISABLED'}`);
      drawFrame();
    };
  }
  
  // Botão de handover
  const btnHandover = document.getElementById("btnHandover");
  if (btnHandover) {
    btnHandover.onclick = () => {
      handoverSimulation = !handoverSimulation;
      btnHandover.textContent = handoverSimulation ? "[STOP_HANDOVER]" : "[START_HANDOVER]";
      updateTerminalLog("HANDOVER", handoverSimulation ? "Simulation started" : "Simulation stopped");
    };
  }
  
  // Fazer mapa redimensionável
  makeMapResizable();
}

function makeMapResizable() {
  const mapWrap = document.getElementById("map-wrap");
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "resize-handle";
  resizeHandle.innerHTML = "═══";
  mapWrap.appendChild(resizeHandle);
  
  let isResizing = false;
  let startHeight = 0;
  let startY = 0;
  
  resizeHandle.addEventListener("mousedown", (e) => {
    isResizing = true;
    startHeight = mapWrap.offsetHeight;
    startY = e.clientY;
    document.body.style.cursor = "ns-resize";
    e.preventDefault();
  });
  
  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const deltaY = e.clientY - startY;
    const newHeight = Math.max(200, Math.min(window.innerHeight - 200, startHeight + deltaY));
    mapWrap.style.height = newHeight + "px";
    map.invalidateSize();
  });
  
  document.addEventListener("mouseup", () => {
    isResizing = false;
    document.body.style.cursor = "default";
  });
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
    
    return { lat, lon, alt, az, el, range, speed };
  } catch (err) {
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
  
  // Aplicar atenuação por chuva apenas se configurado
  const appliedRainAtt = config.considerRain ? rainAttenuation : 0;
  
  const rxPower = EIRP - FSPL - atmosphericLoss - appliedRainAtt + GAIN;
  const noiseFloor = -134;
  const SNR = rxPower - noiseFloor;
  
  return { SNR, rxPower, FSPL, rainAttenuation: appliedRainAtt };
}

// ============ CLIMA ============

async function fetchWeatherData() {
  const now = Date.now();
  
  if (weatherData && (now - weatherLastFetch) < 30 * 60 * 1000) {
    return weatherData;
  }
  
  try {
    updateTerminalLog("WEATHER", "Fetching atmospheric data...");
    
    // Simular dados
    weatherData = {
      cloudCover: Math.random() * 100,
      precipitation: Math.random() * 10,
      humidity: 60 + Math.random() * 30,
      temperature: 20 + Math.random() * 15
    };
    
    weatherLastFetch = now;
    updateWeatherDisplay();
    updateTerminalLog("WEATHER", `Precipitation: ${weatherData.precipitation.toFixed(1)}mm/h`);
    
  } catch (e) {
    updateTerminalLog("ERROR", `Weather data fetch failed: ${e.message}`);
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

function updateWeatherDisplay() {
  if (!weatherData) return;
  
  const weatherInfo = document.getElementById("weatherInfo");
  if (weatherInfo) {
    const rainAtt = config.considerRain ? calculateRainAttenuation(45, weatherData.precipitation) : 0;
    weatherInfo.innerHTML = `
      <div class="terminal-text">
        ┌─ ATMOSPHERIC CONDITIONS ─┐<br>
        │ CLOUDS......: ${weatherData.cloudCover.toFixed(0).padStart(3)}%       │<br>
        │ PRECIP......: ${weatherData.precipitation.toFixed(1).padStart(4)} mm/h  │<br>
        │ HUMIDITY....: ${weatherData.humidity.toFixed(0).padStart(3)}%       │<br>
        │ TEMP........: ${weatherData.temperature.toFixed(1).padStart(4)}°C     │<br>
        │ RAIN ATT....: ${rainAtt.toFixed(1).padStart(4)} dB    │<br>
        └──────────────────────────┘
      </div>
    `;
  }
}

// ============ HANDOVER ============

function simulateHandover() {
  if (!currentServingSat) {
    const visible = [];
    
    for (let i = 0; i < tleList.length; i++) {
      const rec = satRecs[i];
      if (!rec) continue;
      
      const st = getSatState(rec);
      if (!st || st.el < obs.elevMin) continue;
      
      const rainAtt = config.considerRain && weatherData ? 
        calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
      const linkBudget = calculateLinkBudget(st.el, rainAtt);
      
      visible.push({
        satellite: tleList[i],
        state: st,
        snr: linkBudget.SNR,
        index: i
      });
    }
    
    if (visible.length > 0) {
      visible.sort((a, b) => b.snr - a.snr);
      currentServingSat = visible[0];
      handoverCandidates = visible.slice(1, 4);
      
      updateTerminalLog("HANDOVER", `Serving: ${currentServingSat.satellite.name} [SNR: ${currentServingSat.snr.toFixed(1)}dB]`);
    }
  } else {
    const currentState = getSatState(satRecs[currentServingSat.index]);
    
    if (!currentState || currentState.el < obs.elevMin - 5) {
      updateTerminalLog("HANDOVER", `Signal degradation detected on ${currentServingSat.satellite.name}`);
      
      if (handoverCandidates.length > 0) {
        const newServing = handoverCandidates[0];
        updateTerminalLog("HANDOVER", `Executing handover to ${newServing.satellite.name}`);
        
        showHandoverNotification(currentServingSat.satellite.name, newServing.satellite.name);
        
        currentServingSat = newServing;
        handoverCandidates = handoverCandidates.slice(1);
      } else {
        currentServingSat = null;
        updateTerminalLog("HANDOVER", "No candidates available - connection lost");
      }
    }
  }
  
  updateHandoverDisplay();
}

function showHandoverNotification(from, to) {
  const notification = document.createElement("div");
  notification.className = "handover-notification";
  notification.innerHTML = `
    <div class="terminal-box">
      ╔════ HANDOVER EXECUTED ════╗<br>
      ║ FROM: ${from.padEnd(20)} ║<br>
      ║ TO..: ${to.padEnd(20)} ║<br>
      ╚═══════════════════════════╝
    </div>
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = "fadeOut 0.5s";
    setTimeout(() => notification.remove(), 500);
  }, 3000);
}

function updateHandoverDisplay() {
  const handoverInfo = document.getElementById("handoverInfo");
  if (!handoverInfo) return;
  
  let html = '<div class="terminal-text">';
  
  if (currentServingSat) {
    const state = getSatState(satRecs[currentServingSat.index]);
    if (state) {
      html += `
        ┌─ SERVING SATELLITE ─┐<br>
        │ ${currentServingSat.satellite.name || 'UNKNOWN'}<br>
        │ SNR: ${currentServingSat.snr.toFixed(1)} dB<br>
        │ EL.: ${state.el.toFixed(1)}°<br>
        └────────────────────┘<br>
      `;
    }
  }
  
  if (handoverCandidates.length > 0) {
    html += '<br>CANDIDATES:<br>';
    handoverCandidates.forEach((c, i) => {
      html += `${i+1}. ${c.satellite.name} [${c.snr.toFixed(1)}dB]<br>`;
    });
  }
  
  html += '</div>';
  handoverInfo.innerHTML = html;
}

// ============ DESENHO ============

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
    
    // Terminal-style colors
    let color = '#00ff00'; // Verde terminal padrão
    let radius = 2;
    let opacity = 0.3;
    
    if (isServing) {
      color = '#ffffff'; // Branco: servindo
      radius = 6;
      opacity = 1;
    } else if (isCandidate) {
      color = '#ffff00'; // Amarelo: candidato
      radius = 4;
      opacity = 0.8;
    } else if (isVisible) {
      color = '#00ff00'; // Verde brilhante: visível
      radius = 3;
      opacity = 0.7;
      visible++;
    } else {
      color = '#004400'; // Verde escuro: não visível
      radius = 1;
      opacity = 0.2;
    }
    
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: radius,
      weight: 1,
      color: color,
      fillColor: color,
      fillOpacity: opacity,
      opacity: opacity + 0.2
    });
    
    const rainAtt = config.considerRain && weatherData ? 
      calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
    const linkBudget = calculateLinkBudget(st.el, rainAtt);
    
    marker.bindPopup(`
      <div class="terminal-popup">
        <strong>[${t.name || "SAT"}]</strong><br>
        NORAD: ${t.noradId}<br>
        ALT..: ${st.alt.toFixed(0)} km<br>
        ELEV.: ${st.el.toFixed(1)}°<br>
        AZIM.: ${st.az.toFixed(1)}°<br>
        SNR..: ${linkBudget.SNR.toFixed(1)} dB<br>
        ${config.considerRain ? `RAIN.: ${rainAtt.toFixed(1)} dB` : 'RAIN.: DISABLED'}
      </div>
    `);
    
    marker.on('click', () => selectSatellite(t, rec, st));
    
    marker.addTo(layerGroup);
    drawn++;
    
    // Footprints com cores visíveis no mapa escuro
    if (config.showFootprints && isVisible && visible <= config.maxFootprints) {
      const footprintRadius = calculateFootprintRadius(st.alt, obs.elevMin);
      L.circle([st.lat, st.lon], {
        radius: footprintRadius * 1000,
        color: '#00ff00',
        weight: 2,
        opacity: 0.6,
        fillColor: '#00ff00',
        fillOpacity: 0.1,
        interactive: false,
        dashArray: '5,10'
      }).addTo(footprintGroup);
    }
  }
  
  const elapsed = performance.now() - startTime;
  
  document.getElementById("visibleInfo").innerHTML = `
    <div class="terminal-text">
      VISIBLE: ${visible.toString().padStart(3)}<br>
      TRACKED: ${drawn.toString().padStart(3)}<br>
      RENDER.: ${elapsed.toFixed(0).padStart(3)}ms
    </div>
  `;
  
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
  
  const rainAtt = config.considerRain && weatherData ? 
    calculateRainAttenuation(st.el, weatherData.precipitation) : 0;
  const linkBudget = calculateLinkBudget(st.el, rainAtt);
  
  const info = document.getElementById("sat-info");
  if (info) {
    info.innerHTML = `
      <div class="terminal-text">
        ╔═══════════════════════════╗<br>
        ║ ${(t.name || "SATELLITE").padEnd(25)} ║<br>
        ╠═══════════════════════════╣<br>
        ║ NORAD.....: ${(t.noradId || "N/A").toString().padEnd(13)} ║<br>
        ║ POSITION..: ${st.lat.toFixed(2).padStart(7)}°      ║<br>
        ║            ${st.lon.toFixed(2).padStart(8)}°      ║<br>
        ║ ALTITUDE..: ${st.alt.toFixed(0).padStart(6)} km     ║<br>
        ║ VELOCITY..: ${st.speed.toFixed(1).padStart(6)} km/s   ║<br>
        ║ ELEVATION.: ${st.el.toFixed(1).padStart(6)}°       ║<br>
        ║ AZIMUTH...: ${st.az.toFixed(1).padStart(6)}°       ║<br>
        ║ RANGE.....: ${st.range.toFixed(0).padStart(6)} km     ║<br>
        ╠═══════════════════════════╣<br>
        ║ SNR.......: ${linkBudget.SNR.toFixed(1).padStart(6)} dB     ║<br>
        ║ RX POWER..: ${linkBudget.rxPower.toFixed(1).padStart(6)} dBW    ║<br>
        ║ FSPL......: ${linkBudget.FSPL.toFixed(1).padStart(6)} dB     ║<br>
        ║ RAIN ATT..: ${rainAtt.toFixed(1).padStart(6)} dB     ║<br>
        ╚═══════════════════════════╝
      </div>
    `;
  }
  
  updateRFPlots(st, linkBudget);
  updateTerminalLog("SELECT", `Satellite selected: ${t.name} [${t.noradId}]`);
}

function updateRFPlots(st, linkBudget) {
  if (typeof Plotly === 'undefined') return;
  
  // SNR vs Elevação
  const elevs = Array.from({length: 19}, (_, k) => k * 5);
  const snrs = elevs.map(e => {
    const rainAtt = config.considerRain && weatherData ? 
      calculateRainAttenuation(e, weatherData.precipitation) : 0;
    return calculateLinkBudget(e, rainAtt).SNR;
  });
  
  Plotly.newPlot("snrPlot", [{
    x: elevs,
    y: snrs,
    mode: "lines+markers",
    name: "SNR",
    line: { color: "#00ff00", width: 2 },
    marker: { color: "#00ff00", size: 4 }
  }], {
    title: {
      text: `SNR vs ELEVATION ${config.considerRain ? '[RAIN: ON]' : '[RAIN: OFF]'}`,
      font: { color: "#00ff00", family: "monospace" }
    },
    xaxis: { 
      title: "ELEVATION (°)", 
      color: "#00ff00",
      gridcolor: "#003300",
      font: { family: "monospace" }
    },
    yaxis: { 
      title: "SNR (dB)", 
      color: "#00ff00",
      gridcolor: "#003300",
      font: { family: "monospace" }
    },
    margin: { t: 40, l: 50, r: 20, b: 40 },
    paper_bgcolor: "#000000",
    plot_bgcolor: "#000000",
    font: { color: "#00ff00", family: "monospace" }
  }, { displayModeBar: false });
  
  // Constelação QPSK corrigida
  const noise = Math.max(0.01, 0.5 / Math.sqrt(Math.pow(10, linkBudget.SNR / 10)));
  const xs = [], ys = [], colors = [];
  
  // Gerar pontos QPSK com ruído
  for (let i = 0; i < 500; i++) {
    const symbolIndex = i % 4;
    const sym = [[1,1],[1,-1],[-1,1],[-1,-1]][symbolIndex];
    
    // Adicionar ruído gaussiano
    const noiseX = (Math.random() + Math.random() + Math.random() - 1.5) * noise * 0.67;
    const noiseY = (Math.random() + Math.random() + Math.random() - 1.5) * noise * 0.67;
    
    xs.push(sym[0] + noiseX);
    ys.push(sym[1] + noiseY);
    colors.push(['#00ff00', '#00ffff', '#ffff00', '#ff00ff'][symbolIndex]);
  }
  
  Plotly.newPlot("constPlot", [{
    x: xs,
    y: ys,
    mode: "markers",
    type: "scatter",
    marker: { 
      color: colors,
      size: 3,
      opacity: 0.7
    }
  }], {
    title: {
      text: `QPSK CONSTELLATION [SNR: ${linkBudget.SNR.toFixed(1)}dB]`,
      font: { color: "#00ff00", family: "monospace" }
    },
    xaxis: { 
      range: [-2, 2],
      scaleanchor: "y",
      color: "#00ff00",
      gridcolor: "#003300",
      zeroline: true,
      zerolinecolor: "#00ff00",
      font: { family: "monospace" }
    },
    yaxis: { 
      range: [-2, 2],
      color: "#00ff00",
      gridcolor: "#003300",
      zeroline: true,
      zerolinecolor: "#00ff00",
      font: { family: "monospace" }
    },
    margin: { t: 40, l: 40, r: 40, b: 40 },
    paper_bgcolor: "#000000",
    plot_bgcolor: "#000000",
    font: { color: "#00ff00", family: "monospace" },
    showlegend: false
  }, { displayModeBar: false });
}

// ============ INICIAR ============

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Exportar funções globais
window.handoverSimulation = handoverSimulation;
