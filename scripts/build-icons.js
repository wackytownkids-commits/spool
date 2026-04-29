// One-shot icon builder: SVG → multi-size PNG → ICO
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const svgPath = path.join(__dirname, '..', 'build', 'icon.svg');
const buildDir = path.join(__dirname, '..', 'build');

(async () => {
  const svg = fs.readFileSync(svgPath);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngPaths = [];
  for (const s of sizes) {
    const out = path.join(buildDir, `icon-${s}.png`);
    await sharp(svg, { density: 384 }).resize(s, s).png().toFile(out);
    pngPaths.push(out);
    console.log(`wrote icon-${s}.png`);
  }
  // Master 512px PNG (electron-builder accepts a single PNG fallback)
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(path.join(buildDir, 'icon.png'));
  console.log('wrote icon.png (512)');

  const ico = await pngToIco(pngPaths);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('wrote icon.ico');

  // Cleanup intermediate sizes (keep 64 + 256 for nice display in places)
  for (const s of sizes) {
    if (s === 64 || s === 256) continue;
    try { fs.unlinkSync(path.join(buildDir, `icon-${s}.png`)); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
