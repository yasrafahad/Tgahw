// Infra CupCall — QR generator
// Reads the real desk list from desks.json and makes:
//   - one PNG per desk in ./qr-codes/
//   - a printable sticker sheet grouped by floor: ./qr-codes/print-sheet.html
//
// BEFORE RUNNING: set BASE_URL to the address your server runs on, reachable
// from phones on the office Wi-Fi (the machine's LAN IP, not localhost).
//
//   BASE_URL=http://192.168.1.50:3000 node generate-qr.js

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://192.168.1.50:3000';

const desksData = JSON.parse(fs.readFileSync(path.join(__dirname, 'desks.json'), 'utf8'));
// Only generate for active seats
const desks = desksData.desks.filter(d => d.active !== false);

const OUT = path.join(__dirname, 'qr-codes');
fs.mkdirSync(OUT, { recursive: true });

function floorOf(id) { const m = String(id).match(/^(\d+F)/); return m ? m[1] : 'Other'; }

(async () => {
  const byFloor = {};
  for (const d of desks) {
    const url = `${BASE_URL}/order?t=${encodeURIComponent(d.token)}`;
    await QRCode.toFile(path.join(OUT, `${d.id}.png`), url, {
      width: 480, margin: 2, color: { dark: '#003C32', light: '#FFFFFF' }
    });
    const dataUrl = await QRCode.toDataURL(url, {
      width: 300, margin: 2, color: { dark: '#003C32', light: '#FFFFFF' }
    });
    const floor = floorOf(d.id);
    (byFloor[floor] = byFloor[floor] || []).push({ ...d, dataUrl });
  }

  let body = '';
  for (const floor of Object.keys(byFloor).sort()) {
    body += `<h2 class="floor">Floor ${floor}</h2><div class="sheet">`;
    for (const d of byFloor[floor]) {
      const isRoom = d.type === 'room';
      body += `
        <div class="sticker ${isRoom ? 'room' : ''}">
          <img src="${d.dataUrl}" alt="QR ${d.id}">
          <div class="label">
            <small>${isRoom ? 'MEETING ROOM' : 'SCAN TO ORDER'}</small>
            <strong>${d.id}</strong>
          </div>
        </div>`;
    }
    body += `</div>`;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Infra CupCall — Desk QR Stickers</title>
<style>
  body{font-family:'Segoe UI',sans-serif;margin:0;padding:20px;background:#fff;color:#003C32}
  h1{font-size:20px}
  .floor{font-size:15px;border-bottom:2px solid #D1C1B0;padding-bottom:4px;margin:26px 0 12px;page-break-before:always}
  .floor:first-of-type{page-break-before:auto}
  .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .sticker{border:2px solid #003C32;border-radius:14px;overflow:hidden;text-align:center;page-break-inside:avoid}
  .sticker.room{border-color:#D1C1B0}
  .sticker img{width:100%;display:block}
  .label{background:#003C32;color:#F8F4F1;padding:8px 4px 10px}
  .sticker.room .label{background:#014A44}
  .label small{display:block;font-size:.6rem;letter-spacing:2px;color:#D1C1B0;font-weight:700}
  .label strong{font-size:1.1rem;word-break:break-all}
  @media print{body{padding:0}}
</style></head>
<body><h1>Infra CupCall — Desk & Meeting-Room Stickers</h1>${body}</body></html>`;

  fs.writeFileSync(path.join(OUT, 'print-sheet.html'), html);
  console.log(`Generated ${desks.length} QR codes across floors: ${Object.keys(byFloor).sort().join(', ')}`);
  console.log('Open qr-codes/print-sheet.html in a browser and print (one floor per page).');
})();
