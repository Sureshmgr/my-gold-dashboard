const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ============ DATA STRUCTURES ============
let trades = [];
let allWhales = [];  // ALL whales - RESETS DAILY at midnight
let whaleCount = 0;
const WHALE_THRESHOLD = 100000; // $100K

let stats = {
    total: 0, buy: 0, sell: 0, buyVol: 0, sellVol: 0,
    buyQty: 0, sellQty: 0, buyPxQty: 0, sellPxQty: 0,
    lastPrice: null, sessionStart: Date.now()
};

// Timeframes
const TIMEFRAMES = [
    { label: '1m', ms: 60000 }, { label: '5m', ms: 300000 },
    { label: '15m', ms: 900000 }, { label: '30m', ms: 1800000 },
    { label: '1h', ms: 3600000 }, { label: '2h', ms: 7200000 },
    { label: '3h', ms: 10800000 }, { label: '4h', ms: 14400000 }
];

let candles = {};
TIMEFRAMES.forEach(tf => {
    candles[tf.label] = {
        buy: 0, sell: 0, buyQty: 0, sellQty: 0,
        buyPxQty: 0, sellPxQty: 0, open: null, close: null,
        start: null, upTicks: 0, downTicks: 0
    };
});

// Price-based State Tracking (based on live LTP direction)
let priceState = null;        // 'green' (price up) or 'red' (price down)
let priceStateStartPrice = null;
let priceStateStartTime = null;
let lastPrice = null;
let lastPriceTimestamp = null;

// Time tracking for price states
let priceGreenTime = 0;
let priceRedTime = 0;
let priceSwitchCount = 0;

// State Battle Tracking (based on price direction)
let stateSwitchLog = [];  // Store last 10 battles
let greenTotalWin = 0;    // Total net win for green (price went up during green)
let redTotalWin = 0;      // Total net win for red (price went down during red)

// Large Moves Tracking (≥ $1.00) - ONLY when state WINS
let largeGreenMoves = [];  // Array of { time, priceChange, fromPrice, toPrice }
let largeRedMoves = [];    // Array of { time, priceChange, fromPrice, toPrice }
let largeGreenCount = 0;
let largeRedCount = 0;
let largeGreenTotal = 0;
let largeRedTotal = 0;

// Medium Moves Tracking ($0.50 - $0.99) - ONLY when state WINS
let mediumGreenMoves = [];  // Array of { time, priceChange, fromPrice, toPrice }
let mediumRedMoves = [];    // Array of { time, priceChange, fromPrice, toPrice }
let mediumGreenCount = 0;
let mediumRedCount = 0;
let mediumGreenTotal = 0;
let mediumRedTotal = 0;

// Period stats (based on delta for trade analysis)
let periodStats = {
    green: { startTime: null, totalTrades: 0, buyTrades: 0, sellTrades: 0, totalBuyValue: 0, totalSellValue: 0 },
    red: { startTime: null, totalTrades: 0, buyTrades: 0, sellTrades: 0, totalBuyValue: 0, totalSellValue: 0 }
};
let currentPeriod = null;

// Local order book
let fullBids = [], fullAsks = [], currentLtp = null;
const RANGE_POINTS = 50;

// ============ DAILY RESET FUNCTION (EVERY DAY AT MIDNIGHT) ============
function dailyReset() {
    const now = new Date();
    console.log(`\n[DAILY RESET] Midnight Reset triggered at ${now.toLocaleString()}`);
    console.log(`[DAILY RESET] Previous day stats - Trades: ${stats.total} | Buy Vol: ${stats.buyVol} | Sell Vol: ${stats.sellVol}`);
    console.log(`[DAILY RESET] Previous day whales: ${allWhales.length} whales cleared`);
    
    stats = {
        total: 0, buy: 0, sell: 0, buyVol: 0, sellVol: 0,
        buyQty: 0, sellQty: 0, buyPxQty: 0, sellPxQty: 0,
        lastPrice: stats.lastPrice,
        sessionStart: Date.now()
    };
    
    allWhales = [];
    whaleCount = 0;
    trades = [];
    
    console.log(`[DAILY RESET] Stats reset to zero. Next reset in 24 hours.\n`);
}

function scheduleDailyReset() {
    const now = new Date();
    const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0, 0, 0
    );
    const msUntilMidnight = night.getTime() - now.getTime();
    
    setTimeout(() => {
        dailyReset();
        setInterval(dailyReset, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
    
    console.log(`[DAILY RESET] Daily reset scheduled for ${night.toLocaleString()}\n`);
}

// ============ PRICE STATE RESET FUNCTION (EVERY 1 HOUR) ============
function resetPriceStateTracker() {
    const now = Date.now();
    
    console.log(`\n[Price State Reset] Hourly Reset Triggered at ${new Date().toLocaleTimeString()}`);
    console.log(`[Price State Reset] Previous Hour - Green: ${priceGreenTime.toFixed(1)}s | Red: ${priceRedTime.toFixed(1)}s | Switches: ${priceSwitchCount}`);
    console.log(`[State Battle] Final scores - Green: +$${greenTotalWin.toFixed(2)} | Red: +$${redTotalWin.toFixed(2)}`);
    console.log(`[Large Moves] Green: ${largeGreenCount} ($${largeGreenTotal.toFixed(2)}) | Red: ${largeRedCount} ($${largeRedTotal.toFixed(2)})`);
    console.log(`[Medium Moves] Green: ${mediumGreenCount} ($${mediumGreenTotal.toFixed(2)}) | Red: ${mediumRedCount} ($${mediumRedTotal.toFixed(2)})`);
    
    priceGreenTime = 0;
    priceRedTime = 0;
    priceSwitchCount = 0;
    priceState = null;
    priceStateStartPrice = null;
    priceStateStartTime = null;
    lastPrice = null;
    lastPriceTimestamp = null;
    
    stateSwitchLog = [];
    greenTotalWin = 0;
    redTotalWin = 0;
    currentPeriod = null;
    
    largeGreenMoves = [];
    largeRedMoves = [];
    largeGreenCount = 0;
    largeRedCount = 0;
    largeGreenTotal = 0;
    largeRedTotal = 0;
    
    mediumGreenMoves = [];
    mediumRedMoves = [];
    mediumGreenCount = 0;
    mediumRedCount = 0;
    mediumGreenTotal = 0;
    mediumRedTotal = 0;
    
    periodStats = {
        green: { startTime: null, totalTrades: 0, buyTrades: 0, sellTrades: 0, totalBuyValue: 0, totalSellValue: 0 },
        red: { startTime: null, totalTrades: 0, buyTrades: 0, sellTrades: 0, totalBuyValue: 0, totalSellValue: 0 }
    };
    
    console.log(`[Price State Reset] All trackers reset to zero. Next reset in 1 hour.\n`);
}

function scheduleHourlyReset() {
    const now = Date.now();
    const msUntilNextHour = (60 * 60 * 1000) - (now % (60 * 60 * 1000));
    
    setTimeout(() => {
        resetPriceStateTracker();
        setInterval(resetPriceStateTracker, 60 * 60 * 1000);
    }, msUntilNextHour);
    
    console.log(`[Price State Reset] Auto-reset scheduled for ${new Date(now + msUntilNextHour).toLocaleTimeString()}, then every hour\n`);
}

// ============ PRICE STATE TRACKING FUNCTIONS ============
function startPeriod(color) {
    if (currentPeriod === color) return;
    currentPeriod = color;
    periodStats[color].startTime = Date.now();
}

function recordTradeForPeriod(isSell, tradeValue) {
    if (!currentPeriod) return;
    const period = periodStats[currentPeriod];
    period.totalTrades++;
    if (isSell) {
        period.sellTrades++;
        period.totalSellValue += tradeValue;
    } else {
        period.buyTrades++;
        period.totalBuyValue += tradeValue;
    }
}

function recordMove(moveType, isGreen, priceChange, fromPrice, toPrice, timestamp) {
    const moveRecord = {
        time: timestamp,
        priceChange: Math.abs(priceChange),
        fromPrice: fromPrice,
        toPrice: toPrice,
        timeStr: new Date(timestamp).toLocaleTimeString()
    };
    
    if (moveType === 'large') {
        if (isGreen) {
            largeGreenMoves.unshift(moveRecord);
            if (largeGreenMoves.length > 20) largeGreenMoves.pop();
            largeGreenCount++;
            largeGreenTotal += Math.abs(priceChange);
            console.log(`[LARGE MOVE] 🟢 GREEN: +$${Math.abs(priceChange).toFixed(2)} at ${moveRecord.timeStr}`);
        } else {
            largeRedMoves.unshift(moveRecord);
            if (largeRedMoves.length > 20) largeRedMoves.pop();
            largeRedCount++;
            largeRedTotal += Math.abs(priceChange);
            console.log(`[LARGE MOVE] 🔴 RED: -$${Math.abs(priceChange).toFixed(2)} at ${moveRecord.timeStr}`);
        }
    } else if (moveType === 'medium') {
        if (isGreen) {
            mediumGreenMoves.unshift(moveRecord);
            if (mediumGreenMoves.length > 20) mediumGreenMoves.pop();
            mediumGreenCount++;
            mediumGreenTotal += Math.abs(priceChange);
            console.log(`[MEDIUM MOVE] 🟢 GREEN: +$${Math.abs(priceChange).toFixed(2)} at ${moveRecord.timeStr}`);
        } else {
            mediumRedMoves.unshift(moveRecord);
            if (mediumRedMoves.length > 20) mediumRedMoves.pop();
            mediumRedCount++;
            mediumRedTotal += Math.abs(priceChange);
            console.log(`[MEDIUM MOVE] 🔴 RED: -$${Math.abs(priceChange).toFixed(2)} at ${moveRecord.timeStr}`);
        }
    }
}

function updatePriceState(currentPrice, timestamp) {
    if (lastPrice === null) {
        lastPrice = currentPrice;
        lastPriceTimestamp = timestamp;
        return;
    }
    
    const priceChange = currentPrice - lastPrice;
    const timeElapsed = (timestamp - lastPriceTimestamp) / 1000;
    const absChange = Math.abs(priceChange);
    
    let newState = null;
    if (priceChange > 0) newState = 'green';
    else if (priceChange < 0) newState = 'red';
    
    if (priceState !== null && priceStateStartTime !== null && timeElapsed > 0 && timeElapsed < 10) {
        if (priceState === 'green') priceGreenTime += timeElapsed;
        else if (priceState === 'red') priceRedTime += timeElapsed;
    }
    
    // Check for state switch
    if (newState !== null && newState !== priceState) {
        if (priceState !== null && priceStateStartPrice !== null) {
            const statePriceChange = currentPrice - priceStateStartPrice;
            const absStateChange = Math.abs(statePriceChange);
            let winner = '';
            let winAmount = 0;
            let isGreenWin = false;
            
            // CORRECTED LOGIC
            if (priceState === 'green') {
                // GREEN state: wants price to go UP
                if (statePriceChange > 0) {
                    // Price went UP - GREEN wins
                    winner = '🟢';
                    isGreenWin = true;
                    greenTotalWin += statePriceChange;
                    winAmount = statePriceChange;
                    // Record move ONLY when GREEN wins (price moved as expected)
                    if (absStateChange >= 1.00) {
                        recordMove('large', true, statePriceChange, priceStateStartPrice, currentPrice, timestamp);
                    } else if (absStateChange >= 0.50 && absStateChange < 1.00) {
                        recordMove('medium', true, statePriceChange, priceStateStartPrice, currentPrice, timestamp);
                    }
                } else if (statePriceChange < 0) {
                    // Price went DOWN - RED wins
                    winner = '🔴';
                    isGreenWin = false;
                    redTotalWin += absStateChange;
                    winAmount = absStateChange;
                    // DO NOT record move when state loses
                }
            } else if (priceState === 'red') {
                // RED state: wants price to go DOWN
                if (statePriceChange < 0) {
                    // Price went DOWN - RED wins
                    winner = '🔴';
                    isGreenWin = false;
                    redTotalWin += absStateChange;
                    winAmount = absStateChange;
                    // Record move ONLY when RED wins (price moved as expected)
                    if (absStateChange >= 1.00) {
                        recordMove('large', false, statePriceChange, priceStateStartPrice, currentPrice, timestamp);
                    } else if (absStateChange >= 0.50 && absStateChange < 1.00) {
                        recordMove('medium', false, statePriceChange, priceStateStartPrice, currentPrice, timestamp);
                    }
                } else if (statePriceChange > 0) {
                    // Price went UP - GREEN wins
                    winner = '🟢';
                    isGreenWin = true;
                    greenTotalWin += statePriceChange;
                    winAmount = statePriceChange;
                    // DO NOT record move when state loses
                }
            }
            
            const battleLog = {
                switchNumber: priceSwitchCount + 1,
                fromState: priceState,
                toState: newState,
                priceChange: statePriceChange,
                winner: winner,
                winAmount: Math.abs(winAmount),
                fromStatePrice: priceStateStartPrice,
                toStatePrice: currentPrice,
                timestamp: timestamp
            };
            
            stateSwitchLog.unshift(battleLog);
            if (stateSwitchLog.length > 10) stateSwitchLog.pop();
        }
        
        priceSwitchCount++;
        
        if (newState === 'green') startPeriod('green');
        else if (newState === 'red') startPeriod('red');
        
        priceState = newState;
        priceStateStartPrice = currentPrice;
        priceStateStartTime = timestamp;
    } else if (priceState === null && newState !== null) {
        priceState = newState;
        priceStateStartPrice = currentPrice;
        priceStateStartTime = timestamp;
        if (priceState === 'green') startPeriod('green');
        else if (priceState === 'red') startPeriod('red');
    }
    
    lastPrice = currentPrice;
    lastPriceTimestamp = timestamp;
}

function processTrade(price, qty, isSell, timestamp) {
    const value = price * qty;
    const isUpTick = !isSell;
    
    stats.total++;
    stats.lastPrice = price;
    if (isSell) {
        stats.sell++; stats.sellVol += value; stats.sellQty += qty; stats.sellPxQty += price * qty;
    } else {
        stats.buy++; stats.buyVol += value; stats.buyQty += qty; stats.buyPxQty += price * qty;
    }
    
    recordTradeForPeriod(isSell, value);
    
    TIMEFRAMES.forEach(tf => {
        const start = cStart(timestamp, tf.ms);
        const c = candles[tf.label];
        if (c.start !== start) {
            c.buy = 0; c.sell = 0; c.buyQty = 0; c.sellQty = 0;
            c.buyPxQty = 0; c.sellPxQty = 0; c.open = price; c.close = price;
            c.start = start; c.upTicks = 0; c.downTicks = 0;
        }
        c.close = price;
        if (c.open === null) c.open = price;
        if (isSell) {
            c.sell += value; c.sellQty += qty; c.sellPxQty += price * qty;
        } else {
            c.buy += value; c.buyQty += qty; c.buyPxQty += price * qty;
        }
        if (isUpTick) c.upTicks++; else c.downTicks++;
    });
    
    updatePriceState(price, timestamp);
    
    if (value >= WHALE_THRESHOLD) {
        allWhales.unshift({ price, qty, value, isSell, timestamp });
        whaleCount++;
        console.log(`🐋 WHALE: ${isSell ? 'SELL' : 'BUY'} $${value.toLocaleString()} - Daily whales: ${allWhales.length}`);
    }
    
    trades.unshift({ price, qty, value, isSell, timestamp, isWhale: value >= WHALE_THRESHOLD });
    if (trades.length > 200) trades.pop();
}

function cStart(now, ms) { return Math.floor(now / ms) * ms; }

// ============ LOCAL ORDER BOOK ============
async function fetchInitialSnapshot() {
    try {
        const url = 'https://fapi.binance.com/fapi/v1/depth?symbol=XAUUSDT&limit=500';
        const response = await fetch(url);
        const data = await response.json();
        if (data.bids && data.asks) {
            fullBids = data.bids.map(bid => ({ price: parseFloat(bid[0]), qty: parseFloat(bid[1]) }));
            fullAsks = data.asks.map(ask => ({ price: parseFloat(ask[0]), qty: parseFloat(ask[1]) }));
            return true;
        }
        return false;
    } catch (err) { return false; }
}

async function fetchLTP() {
    try {
        const url = 'https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT';
        const response = await fetch(url);
        const data = await response.json();
        if (data.price) { 
            currentLtp = parseFloat(data.price);
            updatePriceState(currentLtp, Date.now());
            return currentLtp;
        }
    } catch (err) {}
    return null;
}

function updateLocalOrderBook() {
    if (!currentLtp) return null;
    const lowerBound = currentLtp - RANGE_POINTS;
    const upperBound = currentLtp + RANGE_POINTS;
    const localBids = fullBids.filter(b => b.price >= lowerBound && b.price <= currentLtp);
    const localAsks = fullAsks.filter(a => a.price >= currentLtp && a.price <= upperBound);
    const buyCount = localBids.length;
    const sellCount = localAsks.length;
    const buyVolume = localBids.reduce((sum, b) => sum + b.qty, 0);
    const sellVolume = localAsks.reduce((sum, a) => sum + a.qty, 0);
    const localDelta = buyCount - sellCount;
    const topBuy = localBids.length > 0 ? localBids.reduce((max, b) => b.qty > max.qty ? b : max, localBids[0]) : null;
    const topSell = localAsks.length > 0 ? localAsks.reduce((max, a) => a.qty > max.qty ? a : max, localAsks[0]) : null;
    return {
        ltp: currentLtp, lowerBound, upperBound, buyCount, sellCount,
        buyVolume, sellVolume, localDelta, topBuy, topSell,
        globalBuyCount: fullBids.length, globalSellCount: fullAsks.length,
        globalDelta: fullBids.length - fullAsks.length
    };
}

// ============ BINANCE WEBSOCKET ============
let binanceWs = null, depthWs = null;

function connectBinance() {
    console.log('[WebSocket] Connecting to Binance...');
    binanceWs = new WebSocket('wss://fstream.binance.com/ws/xauusdt@trade');
    binanceWs.on('open', () => console.log('[WebSocket] ✅ Connected (24/7 mode)'));
    binanceWs.on('message', (data) => {
        try {
            const trade = JSON.parse(data);
            if (trade.e === 'trade') {
                const price = parseFloat(trade.p), qty = parseFloat(trade.q);
                const isSell = trade.m, timestamp = trade.T || Date.now();
                if (!isNaN(price) && !isNaN(qty) && price > 0 && qty > 0) {
                    processTrade(price, qty, isSell, timestamp);
                }
            }
        } catch (err) {}
    });
    binanceWs.on('error', (err) => console.error('[WebSocket] Error:', err.message));
    binanceWs.on('close', () => { setTimeout(connectBinance, 5000); });
}

function connectDepthBook() {
    depthWs = new WebSocket('wss://fstream.binance.com/stream?streams=xauusdt@depth@100ms');
    depthWs.on('open', () => { 
        fetchInitialSnapshot(); 
        fetchLTP(); 
        setInterval(fetchLTP, 5000);
    });
    depthWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg && msg.data) {
                const d = msg.data;
                if (d.b) {
                    d.b.forEach(bid => {
                        const price = parseFloat(bid[0]), qty = parseFloat(bid[1]);
                        const idx = fullBids.findIndex(b => Math.abs(b.price - price) < 0.01);
                        if (qty === 0 || isNaN(qty)) { if (idx !== -1) fullBids.splice(idx, 1); }
                        else { if (idx !== -1) fullBids[idx].qty = qty; else fullBids.push({ price, qty }); }
                    });
                }
                if (d.a) {
                    d.a.forEach(ask => {
                        const price = parseFloat(ask[0]), qty = parseFloat(ask[1]);
                        const idx = fullAsks.findIndex(a => Math.abs(a.price - price) < 0.01);
                        if (qty === 0 || isNaN(qty)) { if (idx !== -1) fullAsks.splice(idx, 1); }
                        else { if (idx !== -1) fullAsks[idx].qty = qty; else fullAsks.push({ price, qty }); }
                    });
                }
            }
        } catch (err) {}
    });
    depthWs.on('close', () => { setTimeout(connectDepthBook, 10000); });
}

// ============ API ENDPOINT ============
app.get('/api/data', (req, res) => {
    const localOrderBook = updateLocalOrderBook();
    const totalWhales = allWhales.length;
    
    const timeframeData = {};
    TIMEFRAMES.forEach(tf => {
        const c = candles[tf.label];
        const tot = c.buy + c.sell;
        const buyPercent = tot > 0 ? (c.buy / tot * 100) : 50;
        const delta = c.buy - c.sell;
        const avgBuy = c.buyQty > 0 ? c.buyPxQty / c.buyQty : null;
        const avgSell = c.sellQty > 0 ? c.sellPxQty / c.sellQty : null;
        const totalQty = c.buyQty + c.sellQty;
        const avgCandle = totalQty > 0 ? (c.buyPxQty + c.sellPxQty) / totalQty : null;
        const remaining = c.start ? Math.max(0, c.start + tf.ms - Date.now()) : null;
        timeframeData[tf.label] = {
            close: c.close, open: c.open, buy: c.buy, sell: c.sell,
            buyPercent: buyPercent.toFixed(1), delta: delta,
            deltaSign: delta >= 0 ? '+' : '', upTicks: c.upTicks, downTicks: c.downTicks,
            totalTicks: c.upTicks + c.downTicks, avgBuy, avgSell, avgCandle,
            remaining: remaining, priceChange: c.open && c.close ? c.close - c.open : 0,
            isBull: delta > 0.01, isBear: delta < -0.01
        };
    });
    
    const netAdvantage = greenTotalWin - redTotalWin;
    const winner = netAdvantage > 0 ? 'GREEN' : (netAdvantage < 0 ? 'RED' : 'TIE');
    const winnerIcon = netAdvantage > 0 ? '🟢' : (netAdvantage < 0 ? '🔴' : '⚪');
    
    res.json({
        stats: {
            total: stats.total, buy: stats.buy, sell: stats.sell,
            buyVol: stats.buyVol, sellVol: stats.sellVol,
            cvd: stats.buyVol - stats.sellVol, lastPrice: stats.lastPrice,
            sessionStart: stats.sessionStart, elapsed: Date.now() - stats.sessionStart
        },
        trades: trades.slice(0, 50),
        allWhales: allWhales,
        totalWhales: totalWhales,
        whaleCount: whaleCount,
        priceStateTracking: {
            greenTime: priceGreenTime,
            redTime: priceRedTime,
            switchCount: priceSwitchCount,
            currentState: priceState,
            currentPrice: currentLtp || stats.lastPrice
        },
        stateBattle: {
            battleLog: stateSwitchLog,
            greenTotalWin: greenTotalWin,
            redTotalWin: redTotalWin,
            netAdvantage: netAdvantage,
            winner: winner,
            winnerIcon: winnerIcon
        },
        moveTracking: {
            large: {
                green: { moves: largeGreenMoves, count: largeGreenCount, total: largeGreenTotal },
                red: { moves: largeRedMoves, count: largeRedCount, total: largeRedTotal }
            },
            medium: {
                green: { moves: mediumGreenMoves, count: mediumGreenCount, total: mediumGreenTotal },
                red: { moves: mediumRedMoves, count: mediumRedCount, total: mediumRedTotal }
            }
        },
        periodStats: {
            green: {
                totalTrades: periodStats.green.totalTrades, buyTrades: periodStats.green.buyTrades,
                sellTrades: periodStats.green.sellTrades,
                netDelta: periodStats.green.totalBuyValue - periodStats.green.totalSellValue
            },
            red: {
                totalTrades: periodStats.red.totalTrades, buyTrades: periodStats.red.buyTrades,
                sellTrades: periodStats.red.sellTrades,
                netDelta: periodStats.red.totalBuyValue - periodStats.red.totalSellValue
            }
        },
        localOrderBook: localOrderBook,
        timeframes: timeframeData
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║     XAUUSDT 24/7 Trading Dashboard                   ║`);
    console.log(`║     Server running on port ${PORT}                      ║`);
    console.log(`║     Stats Reset: Daily at MIDNIGHT                   ║`);
    console.log(`║     Whale Storage: Daily reset at midnight           ║`);
    console.log(`║     Price State: Based on LIVE LTP direction         ║`);
    console.log(`║     Large Moves: ≥ $1.00 (ONLY when state WINS)      ║`);
    console.log(`║     Medium Moves: $0.50 - $0.99 (ONLY when state WINS)║`);
    console.log(`║     All Trackers: Resets EVERY HOUR                  ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
    connectBinance();
    connectDepthBook();
    scheduleDailyReset();
    scheduleHourlyReset();
});

process.on('SIGINT', () => { if (binanceWs) binanceWs.close(); if (depthWs) depthWs.close(); process.exit(0); });
