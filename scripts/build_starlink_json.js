// Uso: node build_starlink_json.js in.json out.json meta.json
const fs = require("fs");

function build(inputPath, outPath, metaPath) {
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const list = raw
    .map(obj => {
      const st = obj?.spaceTrack;
      const line1 = st?.TLE_LINE1?.trim();
      const line2 = st?.TLE_LINE2?.trim();
      if (!line1 || !line2) return null;
      const noradId = Number(st?.NORAD_CAT_ID);
      const name = st?.OBJECT_NAME || `STARLINK-${noradId || ""}`.trim();
      return { name, noradId, line1, line2 };
    })
    .filter(Boolean)
    .sort((a, b) => (a.noradId || 0) - (b.noradId || 0));

  const meta = {
    count: list.length,
    source: "SpaceX API v4 (starlink)",
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(outPath, JSON.stringify(list, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

const [,, inPath, outPath, metaPath] = process.argv;
if (!inPath || !outPath || !metaPath) {
  console.error("Uso: node build_starlink_json.js in.json out.json meta.json");
  process.exit(1);
}
build(inPath, outPath, metaPath);
console.log("Gerado:", outPath, "e", metaPath);
