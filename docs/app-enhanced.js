// app-enhanced.js - Starlink Dashboard Pro
const DATA_URL = "data/starlink_tle.json";
const META_URL = "data/meta.json";
const REFRESH_MS = 3000;

// Estado Global
let tleList = [];
let satRecs = [];
let map, layerGroup, footprintGroup;
let obs = { lat: -27.588, lon: -48.613, elevMin: 25 };
let selectedSatellite = null;
let selectedMarker = null;
let orbitPath = null;
let isDrawing = false;

// Estado 3D
let scene3d, camera3d, renderer3d, earth3d, satellites3d = [];
let isGlobeActive = false;

// Constantes RF
const SPEED_OF_LIGHT = 299792458; // m/s
const FREQ_DOWNLINK = 11.5e9; // Hz (11.5 GHz média Ku-band)
const FREQ_UPLINK = 14.25e9; // Hz
const BANDWIDTH = 250e6; // Hz (250 MHz)
const SATELLITE_EIRP = 35; // dBW
const TERMINAL_GAIN = 33; // dBi (antena phased array)
const NOISE_TEMP = 290; // K
const BOLTZMANN = 1.38e-23; // J/K

// ============ FUNÇÕES UTILITÁRIAS ============

async function safeFetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function makeRec(t) {
  try {
    if (!t.line1 || !t.line2) return null;
    return satellite.twoline2satrec(t.line1, t.line2);
  } catch {
    return null;
  }
}

function getSatState(rec, time = new Date()) {
  try {
    const gmst = satellite.gstime(time);
    const pv = satellite.propagate(rec, time);
    if (!pv || !pv.position || pv.position === false) return null;
    
    const eci = pv.position;
    const vel = pv.velocity;
    const gd = satellite.eciToGeodetic(eci, gmst);
    
    const lat = satellite.radiansToDegrees(gd.latitude);
    const lon = satellite.radiansToDegrees(gd.longitude);
    const alt = gd.height;
    
    // Calcular velocidade
    const speed = Math.sqrt(vel.x**2 + vel.y**2 + vel.z**2);
    
    // Elevação e azimute do observador
    const obsGd = {
      latitude: satellite.degreesToRadians(obs.lat),
      longitude: satellite.degreesToRadians(obs.lon),
      height: 0
    };
    
    const satEcf = satellite.eciToEcf(eci, gmst);
    const look = satellite.ecfToLookAngles(obsGd, satEcf);
    
    const az = satellite.radiansToDegrees(look.azimuth);
    const el = satellite.radiansToDegrees(look.elevation);
    const range = look.rangeSat; // km
    
    return { lat, lon, alt, az, el, range, speed, eci, vel };
  } catch {
    return null;
  }
}

// Calcular footprint real baseado em ângulo de visada
function calculateFootprint(lat, lon, alt, minElev = 25) {
  const Re = 6371; // km
  const h = alt;
  const elevRad = minElev * Math.PI / 180;
  
  // Ângulo de meio cone do footprint
  const alpha = Math.acos(Re / (Re + h) * Math.cos(elevRad)) - elevRad;
  
  // Gerar pontos do footprint (círculo)
  const points = [];
  const numPoints = 64;
  
  for (let i = 0; i < numPoints; i++) {
    const bearing = (i * 360) / numPoints;
    const bearingRad = bearing * Math.PI / 180;
    
    // Calcular ponto no footprint
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    const newLat = Math.asin(
      Math.sin(latRad) * Math.cos(alpha) +
      Math.cos(latRad) * Math.sin(alpha) * Math.cos(bearingRad)
    );
    
    const newLon = lonRad + Math.atan2(
      Math.sin(bearingRad) * Math.sin(alpha) * Math.cos(latRad),
      Math.cos(alpha) - Math.sin(latRad) * Math.sin(newLat)
    );
    
    points.push([
      satellite.radiansToDegrees(newLat),
      satellite.radiansToDegrees(newLon)
    ]);
  }
  
  return points;
}

// ============ CÁLCULOS RF ============

function calculateLinkBudget(elevationDeg, frequency = FREQ_DOWNLINK) {
  const distance = 550 / Math.sin(elevationDeg * Math.PI / 180); // km
  const FSPL = 20 * Math.log10(distance * 1000) + 20 * Math.log10(frequency) + 20 * Math.log10(4 * Math.PI / SPEED_OF_LIGHT);
  
  const atmosphericLoss = 0.5 / Math.sin(Math.max(elevationDeg, 5) * Math.PI / 180);
  const rainLoss = elevationDeg < 10 ? 3 : elevationDeg < 20 ? 1.5 : 0.5;
  
  const rxPower = SATELLITE_EIRP - FSPL - atmosphericLoss - rainLoss + TERMINAL_GAIN;
  const noiseFloor = 10 * Math.log10(BOLTZMANN * NOISE_TEMP * BANDWIDTH);
  const SNR = rxPower - noiseFloor - 30; // -30 para converter W para dBW
  
  return {
    distance,
    FSPL,
    atmosphericLoss,
    rainLoss,
    rxPower,
    noiseFloor,
    SNR,
    marginDb: SNR - 10 // 10 dB margem desejada
  };
}

function calculateDopplerShift(velocity, elevationDeg, frequency = FREQ_DOWNLINK) {
  // Componente radial da velocidade
  const radialVelocity = velocity * 1000 * Math.cos(elevationDeg * Math.PI / 180); // m/s
  const dopplerShift = (radialVelocity / SPEED_OF_LIGHT) * frequency;
  return dopplerShift / 1000; // kHz
}

function calculateBER(snrDb, modulation = 'QPSK') {
  const snr = Math.pow(10, snrDb / 10);
  let ber;
  
  switch(modulation) {
    case 'QPSK':
      ber = 0.5 * erfc(Math.sqrt(snr));
      break;
    case '16QAM':
      ber = 0.375 * erfc(Math.sqrt(snr / 2.5));
      break;
    case '64QAM':
      ber = 0.3125 * erfc(Math.sqrt(snr / 7));
      break;
    default:
      ber = 0.5 * erfc(Math.sqrt(snr));
  }
  
  return Math.max(ber, 1e-10);
}

function erfc(x) {
  // Aproximação da função erro complementar
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return 1 - sign * y;
}

function calculateShannonCapacity(snrDb, bandwidth = BANDWIDTH) {
  const snr = Math.pow(10, snrDb / 10);
  const capacity = bandwidth * Math.log2(1 + snr);
  return capacity / 1e6; // Mbps
}

// ============ INTERFACE & TABS ============

function switchTab(tabName) {
  // Ocultar todas as tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Mostrar tab selecionada
  document.getElementById(`${tabName}-tab`).classList.add('active');
  event.target.classList.add('active');
  
  // Ativar/desativar globo 3D
  if (tabName === 'globe') {
    isGlobeActive = true;
    if (!scene3d) initGlobe3D();
    animate3D();
  } else {
    isGlobeActive = false;
  }
  
  // Atualizar gráficos RF se necessário
  if (tabName === 'rf' && selectedSatellite) {
    updateRFAnalysis();
  }
}

// ============ MAPA 2D ============

async function init() {
  console.log("🚀 Iniciando Starlink Dashboard Pro...");
  
  // Carregar dados
  try {
    const meta = await safeFetchJSON(META_URL);
    document.getElementById("meta").innerHTML = 
      `<strong>Satélites:</strong> ${meta.count} • <strong>Fonte:</strong> ${meta.source} • <strong>Atualizado:</strong> ${new Date(meta.updatedAt).toLocaleString('pt-BR')}`;
  } catch (e) {
    console.error("Erro meta:", e);
  }
  
  try {
    tleList = await safeFetchJSON(DATA_URL);
    satRecs = tleList.map(makeRec);
    console.log(`✅ ${tleList.length} satélites carregados`);
  } catch (e) {
    console.error("❌ Erro TLE:", e);
    return;
  }
  
  // Configurar mapa 2D
  map = L.map("map", { 
    worldCopyJump: true,
    preferCanvas: true
  }).setView([obs.lat, obs.lon], 3);
  
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 10
  }).addTo(map);
  
  layerGroup = L.layerGroup().addTo(map);
  footprintGroup = L.layerGroup().addTo(map);
  
  // Marcador da posição do observador
  L.marker([obs.lat, obs.lon], {
    title: "IFSC São José",
    icon: L.divIcon({
      html: '📍',
      iconSize: [20, 20],
      className: 'location-icon'
    })
  }).addTo(map);
  
  // Controles
  document.getElementById("btnApply").onclick = () => {
    obs.elevMin = Number(document.getElementById("elevMin").value);
    obs.lat = Number(document.getElementById("lat").value);
    obs.lon = Number(document.getElementById("lon").value);
    drawFrame();
  };
  
  // Iniciar loop
  drawFrame();
  setInterval(() => {
    if (!isDrawing && !isGlobeActive) drawFrame();
  }, REFRESH_MS);
}

function drawFrame() {
  if (isDrawing) return;
  isDrawing = true;
  
  layerGroup.clearLayers();
  footprintGroup.clearLayers();
  
  let visible = 0;
  const MAX_DRAW = 800; // Limitar para performance
  const step = Math.ceil(tleList.length / MAX_DRAW);
  
  for (let i = 0; i < tleList.length; i += step) {
    const t = tleList[i];
    const rec = satRecs[i];
    if (!rec) continue;
    
    const st = getSatState(rec);
    if (!st) continue;
    
    const isVisible = st.el >= obs.elevMin;
    const isSelected = selectedSatellite && selectedSatellite.noradId === t.noradId;
    
    // Cores corrigidas
    let color = '#4488ff'; // Azul: não visível
    let radius = 2;
    
    if (isSelected) {
      color = '#ffaa00'; // Laranja: selecionado
      radius = 6;
    } else if (isVisible) {
      color = '#00ff44'; // Verde: visível da sua localização
      radius = 4;
    }
    
    const marker = L.circleMarker([st.lat, st.lon], {
      radius: radius,
      weight: 1,
      color: color,
      fillColor: color,
      fillOpacity: 0.8
    });
    
    marker.bindPopup(`
      <strong>${t.name}</strong><br>
      NORAD: ${t.noradId}<br>
      Alt: ${st.alt.toFixed(0)} km<br>
      El: ${st.el.toFixed(1)}°<br>
      Vel: ${st.speed.toFixed(1)} km/s
    `);
    
    marker.on('click', () => {
      selectSatellite(t, rec, st);
      drawOrbitPath(rec);
    });
    
    marker.addTo(layerGroup);
    
    // Desenhar footprint para satélites visíveis
    if (isVisible && visible < 5) { // Limitar footprints
      visible++;
      const footprintPoints = calculateFootprint(st.lat, st.lon, st.alt, obs.elevMin);
      L.polygon(footprintPoints, {
        color: '#00ff44',
        weight: 1,
        opacity: 0.3,
        fillOpacity: 0.1,
        interactive: false
      }).addTo(footprintGroup);
    }
  }
  
  document.getElementById("visibleInfo").innerHTML = 
    `<strong>Visíveis:</strong> ${visible}<br>
     <small>Elevação ≥ ${obs.elevMin}°</small>`;
  
  isDrawing = false;
}

function drawOrbitPath(rec) {
  if (orbitPath) map.removeLayer(orbitPath);
  
  const points = [];
  const period = 95 * 60; // ~95 minutos
  const steps = 180;
  
  for (let i = 0; i < steps; i++) {
    const t = new Date(Date.now() + (i * period * 1000) / steps);
    const st = getSatState(rec, t);
    if (st) points.push([st.lat, st.lon]);
  }
  
  orbitPath = L.polyline(points, {
    color: '#ffaa00',
    weight: 2,
    opacity: 0.6,
    dashArray: '5, 10'
  }).addTo(map);
}

function selectSatellite(t, rec, st) {
  selectedSatellite = { ...t, rec, lastState: st };
  
  const info = document.getElementById("sat-info");
  info.innerHTML = `
    <h3>${t.name}</h3>
    <p><strong>NORAD:</strong> ${t.noradId}</p>
    <p><strong>Posição:</strong> ${st.lat.toFixed(2)}°, ${st.lon.toFixed(2)}°</p>
    <p><strong>Altitude:</strong> ${st.alt.toFixed(0)} km</p>
    <p><strong>Velocidade:</strong> ${st.speed.toFixed(1)} km/s</p>
    <p><strong>Azimute:</strong> ${st.az.toFixed(1)}°</p>
    <p><strong>Elevação:</strong> ${st.el.toFixed(1)}°</p>
    <p><strong>Distância:</strong> ${st.range.toFixed(0)} km</p>
  `;
  
  // Atualizar gráficos RF básicos
  updateBasicRFPlots(st);
  
  // Se a aba RF estiver ativa, atualizar análise completa
  if (document.getElementById('rf-tab').classList.contains('active')) {
    updateRFAnalysis();
  }
}

function updateBasicRFPlots(st) {
  // SNR vs Elevação
  const elevs = Array.from({length: 19}, (_, k) => k * 5);
  const snrs = elevs.map(e => calculateLinkBudget(e).SNR);
  
  Plotly.newPlot("snrPlot", [{
    x: elevs,
    y: snrs,
    mode: "lines+markers",
    name: "SNR (dB)",
    line: { color: "#00ff44" },
    marker: {
      color: elevs.map(e => e === Math.round(st.el) ? '#ffaa00' : '#00ff44'),
      size: elevs.map(e => e === Math.round(st.el) ? 10 : 6)
    }
  }], {
    title: `SNR vs Elevação (atual: ${st.el.toFixed(1)}°)`,
    xaxis: { title: "Elevação (°)" },
    yaxis: { title: "SNR (dB)" },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  }, { displayModeBar: false });
  
  // Constelação
  const linkBudget = calculateLinkBudget(st.el);
  const noise = 0.5 / Math.sqrt(Math.pow(10, linkBudget.SNR / 10));
  const N = 500;
  const xs = [], ys = [];
  
  // Simular QPSK com ruído baseado em SNR real
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

// ============ ANÁLISE RF AVANÇADA ============

function updateRFAnalysis() {
  if (!selectedSatellite) return;
  
  const st = getSatState(selectedSatellite.rec);
  if (!st) return;
  
  // 1. Link Budget Detalhado
  const elevations = Array.from({length: 37}, (_, i) => i * 2.5);
  const linkBudgets = elevations.map(e => calculateLinkBudget(e));
  
  Plotly.newPlot("linkBudgetPlot", [
    {
      x: elevations,
      y: linkBudgets.map(lb => lb.rxPower),
      name: "Potência Rx (dBW)",
      line: { color: "#00ff44" }
    },
    {
      x: elevations,
      y: linkBudgets.map(lb => lb.FSPL),
      name: "FSPL (dB)",
      line: { color: "#ff4444" }
    },
    {
      x: elevations,
      y: linkBudgets.map(lb => lb.SNR),
      name: "SNR (dB)",
      line: { color: "#4488ff" }
    }
  ], {
    title: "Link Budget vs Elevação",
    xaxis: { title: "Elevação (°)" },
    yaxis: { title: "dB" },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  });
  
  // 2. BER vs SNR
  const snrRange = Array.from({length: 30}, (_, i) => i - 5);
  const berQPSK = snrRange.map(snr => calculateBER(snr, 'QPSK'));
  const ber16QAM = snrRange.map(snr => calculateBER(snr, '16QAM'));
  const ber64QAM = snrRange.map(snr => calculateBER(snr, '64QAM'));
  
  Plotly.newPlot("berPlot", [
    {
      x: snrRange,
      y: berQPSK,
      name: "QPSK",
      line: { color: "#00ff44" },
      type: "scatter"
    },
    {
      x: snrRange,
      y: ber16QAM,
      name: "16-QAM",
      line: { color: "#ffaa00" }
    },
    {
      x: snrRange,
      y: ber64QAM,
      name: "64-QAM",
      line: { color: "#ff4444" }
    }
  ], {
    title: "BER vs SNR",
    xaxis: { title: "SNR (dB)" },
    yaxis: { 
      title: "BER",
      type: "log",
      range: [-10, 0]
    },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  });
  
  // 3. Capacidade de Shannon
  const capacities = snrRange.map(snr => calculateShannonCapacity(snr));
  
  Plotly.newPlot("shannonPlot", [{
    x: snrRange,
    y: capacities,
    fill: 'tozeroy',
    fillcolor: 'rgba(0,255,68,0.2)',
    line: { color: "#00ff44" }
  }], {
    title: "Capacidade do Canal (Shannon)",
    xaxis: { title: "SNR (dB)" },
    yaxis: { title: "Capacidade (Mbps)" },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  });
  
  // 4. Doppler Shift
  const times = Array.from({length: 60}, (_, i) => i);
  const dopplers = times.map(t => {
    const futureTime = new Date(Date.now() + t * 60 * 1000);
    const futureState = getSatState(selectedSatellite.rec, futureTime);
    if (!futureState) return 0;
    return calculateDopplerShift(futureState.speed, futureState.el);
  });
  
  Plotly.newPlot("dopplerPlot", [{
    x: times,
    y: dopplers,
    mode: "lines",
    line: { color: "#4488ff" }
  }], {
    title: "Doppler Shift ao longo do tempo",
    xaxis: { title: "Tempo (minutos)" },
    yaxis: { title: "Doppler Shift (kHz)" },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  });
  
  // 5. Padrão de Antena (polar)
  const angles = Array.from({length: 72}, (_, i) => i * 5);
  const gains = angles.map(a => {
    const theta = a * Math.PI / 180;
    return 33 * Math.cos(theta * 2); // Padrão simplificado
  });
  
  Plotly.newPlot("antennaPlot", [{
    type: 'scatterpolar',
    r: gains.map(g => Math.max(0, g)),
    theta: angles,
    fill: 'toself',
    fillcolor: 'rgba(0,255,68,0.2)',
    line: { color: "#00ff44" }
  }], {
    title: "Padrão de Antena (simulado)",
    polar: {
      radialaxis: {
        visible: true,
        range: [0, 35]
      }
    },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    font: { color: "#e8f0ff" }
  });
  
  // 6. Throughput vs Modulação
  const modulations = ['BPSK', 'QPSK', '8PSK', '16QAM', '32QAM', '64QAM', '128QAM', '256QAM'];
  const bitsPerSymbol = [1, 2, 3, 4, 5, 6, 7, 8];
  const currentSNR = calculateLinkBudget(st.el).SNR;
  
  const throughputs = bitsPerSymbol.map((bits, i) => {
    const requiredSNR = bits * 3; // Aproximação simplificada
    if (currentSNR < requiredSNR) return 0;
    const symbolRate = BANDWIDTH / 1.2; // Factor de roll-off
    return (bits * symbolRate) / 1e6; // Mbps
  });
  
  Plotly.newPlot("throughputPlot", [{
    x: modulations,
    y: throughputs,
    type: 'bar',
    marker: {
      color: throughputs.map(t => t > 0 ? '#00ff44' : '#ff4444')
    }
  }], {
    title: `Throughput Estimado @ SNR=${currentSNR.toFixed(1)}dB`,
    xaxis: { title: "Modulação" },
    yaxis: { title: "Throughput (Mbps)" },
    margin: { t: 40 },
    paper_bgcolor: "#111a2e",
    plot_bgcolor: "#0b1220",
    font: { color: "#e8f0ff" }
  });
}

// ============ GLOBO 3D ============

function initGlobe3D() {
  const container = document.getElementById('globe-container');
  
  // Scene
  scene3d = new THREE.Scene();
  
  // Camera
  camera3d = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    100000
  );
  camera3d.position.set(0, 0, 15000);
  
  // Renderer
  renderer3d = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer3d.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer3d.domElement);
  
  // Luz
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene3d.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(5, 3, 5);
  scene3d.add(directionalLight);
  
  // Terra
  const earthGeometry = new THREE.SphereGeometry(6371, 64, 64);
  const earthMaterial = new THREE.MeshPhongMaterial({
    color: 0x2233ff,
    emissive: 0x112244,
    shininess: 10
  });
  earth3d = new THREE.Mesh(earthGeometry, earthMaterial);
  scene3d.add(earth3d);
  
  // Grid na Terra
  const gridHelper = new THREE.GridHelper(20000, 20);
  gridHelper.rotation.x = Math.PI / 2;
  scene3d.add(gridHelper);
  
  // Adicionar satélites
  createSatellites3D();
  
  // Controles de mouse
  container.addEventListener('mousedown', onMouseDown3D);
  container.addEventListener('mousemove', onMouseMove3D);
  container.addEventListener('mouseup', onMouseUp3D);
  container.addEventListener('wheel', onMouseWheel3D);
}

function createSatellites3D() {
  const satGeometry = new THREE.SphereGeometry(30, 8, 8);
  
  const step = Math.ceil(tleList.length / 500); // Limitar a 500 satélites no 3D
  
  for (let i = 0; i < tleList.length; i += step) {
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff44
    });
    const satellite = new THREE.Mesh(satGeometry, material);
    satellite.userData = { index: i };
    scene3d.add(satellite);
    satellites3d.push(satellite);
  }
}

let mouseDown3D = false;
let mouseX3D = 0;
let mouseY3D = 0;

function onMouseDown3D(event) {
  mouseDown3D = true;
  mouseX3D = event.clientX;
  mouseY3D = event.clientY;
}

function onMouseMove3D(event) {
  if (!mouseDown3D) return;
  
  const deltaX = event.clientX - mouseX3D;
  const deltaY = event.clientY - mouseY3D;
  
  camera3d.position.x = camera3d.position.x * Math.cos(deltaX * 0.01) - camera3d.position.z * Math.sin(deltaX * 0.01);
  camera3d.position.z = camera3d.position.x * Math.sin(deltaX * 0.01) + camera3d.position.z * Math.cos(deltaX * 0.01);
  camera3d.position.y += deltaY * 10;
  
  camera3d.lookAt(0, 0, 0);
  
  mouseX3D = event.clientX;
  mouseY3D = event.clientY;
}

function onMouseUp3D() {
  mouseDown3D = false;
}

function onMouseWheel3D(event) {
  const scale = event.deltaY > 0 ? 1.1 : 0.9;
  camera3d.position.multiplyScalar(scale);
}

function animate3D() {
  if (!isGlobeActive) return;
  requestAnimationFrame(animate3D);
  
  // Atualizar posições dos satélites
  satellites3d.forEach(sat => {
    const i = sat.userData.index;
    const rec = satRecs[i];
    if (!rec) return;
    
    const st = getSatState(rec);
    if (!st) return;
    
    // Converter coordenadas para 3D
    const phi = (90 - st.lat) * Math.PI / 180;
    const theta = (st.lon + 180) * Math.PI / 180;
    const r = 6371 + st.alt;
    
    sat.position.x = r * Math.sin(phi) * Math.cos(theta);
    sat.position.z = r * Math.sin(phi) * Math.sin(theta);
    sat.position.y = r * Math.cos(phi);
    
    // Cor baseada em visibilidade
    const isVisible = st.el >= obs.elevMin;
    sat.material.color.setHex(isVisible ? 0x00ff44 : 0x4488ff);
  });
  
  // Rotação suave da Terra
  earth3d.rotation.y += 0.001;
  
  renderer3d.render(scene3d, camera3d);
}

// Funções auxiliares para controles 3D
function toggleView(view) {
  console.log("Toggle view:", view);
  // Implementar toggle de visualizações
}

function followSatellite() {
  if (selectedSatellite) {
    console.log("Following satellite:", selectedSatellite.name);
    // Implementar seguimento de satélite
  }
}

// ============ INICIALIZAÇÃO ============

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Prevenir erro se a função for chamada antes de carregar
window.switchTab = switchTab;
window.toggleView = toggleView;
window.followSatellite = followSatellite;
