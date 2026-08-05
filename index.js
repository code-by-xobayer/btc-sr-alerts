const axios = require('axios');
const admin = require('firebase-admin');

// ---------- CONFIG ----------
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';
const LIMIT = 500;
const PIVOT_LEN = 4;

// ---------- Firebase init ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const FCM_TOPIC = 'sr_alert';

// ---------- Fetch klines ----------
async function getKlines() {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`;
    const res = await axios.get(url);
    return res.data.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4])
    }));
}

// ---------- Pivot / SR ----------
function pivotHigh(highs, len) {
    const pivots = [];
    for (let i = len; i < highs.length - len; i++) {
        let isHigh = true;
        for (let j = 1; j <= len; j++) {
            if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { isHigh = false; break; }
        }
        if (isHigh) pivots.push({ index: i, value: highs[i] });
    }
    return pivots;
}

function pivotLow(lows, len) {
    const pivots = [];
    for (let i = len; i < lows.length - len; i++) {
        let isLow = true;
        for (let j = 1; j <= len; j++) {
            if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { isLow = false; break; }
        }
        if (isLow) pivots.push({ index: i, value: lows[i] });
    }
    return pivots;
}

function computeSR(klines) {
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const ph = pivotHigh(highs, PIVOT_LEN);
    const pl = pivotLow(lows, PIVOT_LEN);
    let prevHigh = null, prevLow = null;
    let lastLH = null, lastHL = null;
    for (const p of ph) {
        if (prevHigh !== null && p.value < prevHigh) lastLH = p.value;
        prevHigh = p.value;
    }
    for (const p of pl) {
        if (prevLow !== null && p.value > prevLow) lastHL = p.value;
        prevLow = p.value;
    }
    const support = lastHL ?? (pl.length > 0 ? pl[pl.length - 1].value : null);
    const resistance = lastLH ?? (ph.length > 0 ? ph[ph.length - 1].value : null);
    return { support, resistance };
}

// ---------- Send push ----------
async function sendNotification(title, body) {
    const message = {
        notification: { title, body },
        topic: FCM_TOPIC
    };
    await admin.messaging().send(message);
    console.log(`Sent: ${title} – ${body}`);
}

// ---------- State (persist last values between runs) ----------
const fs = require('fs');
const STATE_FILE = '/tmp/sr_state.json';
let state = { lastSupport: null, lastResistance: null };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) {}

// ---------- Main ----------
(async () => {
    try {
        const klines = await getKlines();
        const { support, resistance } = computeSR(klines);
        const promises = [];
        if (support !== null && support !== state.lastSupport) {
            promises.push(sendNotification('New Support', `BTC support: ${support.toFixed(2)}`));
            state.lastSupport = support;
        }
        if (resistance !== null && resistance !== state.lastResistance) {
            promises.push(sendNotification('New Resistance', `BTC resistance: ${resistance.toFixed(2)}`));
            state.lastResistance = resistance;
        }
        if (promises.length > 0) await Promise.all(promises);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
