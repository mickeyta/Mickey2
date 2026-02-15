const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const STATIC_DIR = __dirname;
const NAME_CACHE_FILE = path.join(__dirname, 'fund-names-cache.json');

/** Persistent fund name cache: { "507012": "Some Fund Name", ... } */
var _fundNameCache = {};
try {
    if (fs.existsSync(NAME_CACHE_FILE)) {
        _fundNameCache = JSON.parse(fs.readFileSync(NAME_CACHE_FILE, 'utf8'));
        console.log('[CACHE] Loaded ' + Object.keys(_fundNameCache).length + ' fund names from cache');
    }
} catch (e) {
    console.log('[CACHE] Could not load name cache: ' + e.message);
}

function saveFundNameCache() {
    try {
        fs.writeFileSync(NAME_CACHE_FILE, JSON.stringify(_fundNameCache, null, 2), 'utf8');
    } catch (e) {
        console.log('[CACHE] Could not save name cache: ' + e.message);
    }
}

function cacheFundName(id, name) {
    if (name && name !== id && name !== '') {
        _fundNameCache[id] = name;
    }
}

function getCachedFundName(id) {
    return _fundNameCache[id] || null;
}

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

const YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
};

const TASE_STOCK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.tase.co.il/',
    'Origin': 'https://www.tase.co.il',
};

const TASE_FUND_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    'Referer': 'https://maya.tase.co.il/',
    'Origin': 'https://maya.tase.co.il',
    'X-Maya-With': 'allow',
};

function httpsGet(targetUrl, headers, timeout) {
    if (!timeout) timeout = 10000;
    return new Promise(function (resolve, reject) {
        var parsedUrl = new URL(targetUrl);
        var options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: headers || {},
        };
        var req = https.request(options, function (upstream) {
            var chunks = [];
            upstream.on('data', function (c) { chunks.push(c); });
            upstream.on('end', function () {
                resolve({ status: upstream.statusCode, body: Buffer.concat(chunks), headers: upstream.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout, function () {
            req.destroy(new Error('Timeout ' + timeout + 'ms'));
        });
        req.end();
    });
}

/** Try to parse a TASE response. Returns parsed JSON if valid, null otherwise. */
function parseTaseResponse(resp) {
    if (!resp || resp.status !== 200) return null;
    var body = resp.body.toString();
    if (!body || body[0] !== '{') return null; // HTML = Incapsula block
    try { return JSON.parse(body); } catch (e) { return null; }
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

http.createServer(async function (req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        return res.end();
    }

    // Yahoo batch: fetch multiple symbols, 3 at a time to avoid rate limits
    if (url.pathname === '/api/yahoo/batch') {
        var syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        if (syms.length === 0) { sendJson(res, 400, { error: 'No symbols' }); return; }
        console.log('[YAHOO BATCH] symbols=' + syms.join(','));
        var t0y = Date.now();
        var batchResult = {};
        var CONCURRENCY = 3;

        for (var ci = 0; ci < syms.length; ci += CONCURRENCY) {
            var chunk = syms.slice(ci, ci + CONCURRENCY);
            var chunkResults = await Promise.allSettled(chunk.map(function (s) {
                var tgt = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(s) + '?range=1d&interval=1d';
                return httpsGet(tgt, YAHOO_HEADERS, 8000).then(function (r) {
                    return { symbol: s, status: r.status, body: r.body.toString() };
                });
            }));
            for (var cr = 0; cr < chunkResults.length; cr++) {
                var sym = chunk[cr];
                if (chunkResults[cr].status === 'fulfilled') {
                    var val = chunkResults[cr].value;
                    if (val.status === 200) {
                        try { batchResult[sym] = JSON.parse(val.body); } catch (e) {
                            console.log('  ' + sym + ': JSON parse error: ' + e.message);
                            batchResult[sym] = null;
                        }
                    } else {
                        console.log('  ' + sym + ': HTTP ' + val.status);
                        batchResult[sym] = null;
                    }
                } else {
                    console.log('  ' + sym + ': ' + chunkResults[cr].reason.message);
                    batchResult[sym] = null;
                }
            }
        }

        console.log('[YAHOO BATCH] done in ' + (Date.now() - t0y) + 'ms');
        sendJson(res, 200, batchResult);
        return;
    }

    // Yahoo yields: fetch YTD and 1Y returns for multiple symbols
    if (url.pathname === '/api/yahoo/yields') {
        var syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        if (syms.length === 0) { sendJson(res, 400, { error: 'No symbols' }); return; }
        console.log('[YAHOO YIELDS] symbols=' + syms.join(','));
        var t0y2 = Date.now();
        var yieldsResult = {};
        var CONC = 3;

        for (var ci2 = 0; ci2 < syms.length; ci2 += CONC) {
            var chunk2 = syms.slice(ci2, ci2 + CONC);
            var chunkResults2 = await Promise.allSettled(chunk2.map(function (s) {
                var ytdUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(s) + '?range=ytd&interval=1mo';
                var oneYUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(s) + '?range=1y&interval=1mo';
                return Promise.allSettled([
                    httpsGet(ytdUrl, YAHOO_HEADERS, 8000),
                    httpsGet(oneYUrl, YAHOO_HEADERS, 8000),
                ]).then(function (results) {
                    var ytdData = null, oneYData = null;
                    if (results[0].status === 'fulfilled' && results[0].value.status === 200) {
                        try { ytdData = JSON.parse(results[0].value.body.toString()); } catch (e) {}
                    }
                    if (results[1].status === 'fulfilled' && results[1].value.status === 200) {
                        try { oneYData = JSON.parse(results[1].value.body.toString()); } catch (e) {}
                    }
                    return { symbol: s, ytd: ytdData, oneY: oneYData };
                });
            }));
            for (var cr2 = 0; cr2 < chunkResults2.length; cr2++) {
                var sym2 = chunk2[cr2];
                if (chunkResults2[cr2].status === 'fulfilled') {
                    var v = chunkResults2[cr2].value;
                    var entry = {};
                    // YTD: compare first open of year to current price
                    if (v.ytd && v.ytd.chart && v.ytd.chart.result && v.ytd.chart.result[0]) {
                        var meta = v.ytd.chart.result[0].meta;
                        var opens = v.ytd.chart.result[0].indicators &&
                            v.ytd.chart.result[0].indicators.quote &&
                            v.ytd.chart.result[0].indicators.quote[0] &&
                            v.ytd.chart.result[0].indicators.quote[0].open;
                        var startPrice = opens && opens.length > 0 ? opens[0] : meta.chartPreviousClose;
                        var curPrice = meta.regularMarketPrice;
                        if (startPrice && curPrice && startPrice > 0) {
                            entry.ytd = ((curPrice - startPrice) / startPrice) * 100;
                        }
                    }
                    // 1Y: compare first open of 1y ago to current
                    if (v.oneY && v.oneY.chart && v.oneY.chart.result && v.oneY.chart.result[0]) {
                        var meta1 = v.oneY.chart.result[0].meta;
                        var opens1 = v.oneY.chart.result[0].indicators &&
                            v.oneY.chart.result[0].indicators.quote &&
                            v.oneY.chart.result[0].indicators.quote[0] &&
                            v.oneY.chart.result[0].indicators.quote[0].open;
                        var startPrice1 = opens1 && opens1.length > 0 ? opens1[0] : meta1.chartPreviousClose;
                        var curPrice1 = meta1.regularMarketPrice;
                        if (startPrice1 && curPrice1 && startPrice1 > 0) {
                            entry.oneYear = ((curPrice1 - startPrice1) / startPrice1) * 100;
                        }
                    }
                    yieldsResult[sym2] = entry;
                } else {
                    yieldsResult[sym2] = null;
                }
            }
        }

        console.log('[YAHOO YIELDS] done in ' + (Date.now() - t0y2) + 'ms');
        sendJson(res, 200, yieldsResult);
        return;
    }

    // Proxy: Yahoo Finance v8 chart API (single symbol)
    if (url.pathname.startsWith('/api/yahoo/')) {
        var symbol = url.pathname.replace('/api/yahoo/', '');
        var target = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(symbol) + '?range=1d&interval=1d';
        try {
            var r = await httpsGet(target, YAHOO_HEADERS);
            res.writeHead(r.status, {
                'Content-Type': r.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(r.body);
        } catch (err) {
            console.log('[YAHOO] ' + symbol + ': fetch error: ' + err.message);
            sendJson(res, 502, { error: err.message });
        }
        return;
    }

    // Proxy: TASE quote - tries BOTH stock and fund endpoints in parallel
    if (url.pathname === '/api/tase/quote') {
        var id = url.searchParams.get('id') || '';
        var t0 = Date.now();
        console.log('[TASE] id=' + id);

        var secUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
            encodeURIComponent(id) + '&lang=1';
        var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' +
            encodeURIComponent(id);

        var results = await Promise.allSettled([
            httpsGet(secUrl, TASE_STOCK_HEADERS, 5000),
            httpsGet(fundUrl, TASE_FUND_HEADERS, 5000),
        ]);

        var secData = parseTaseResponse(results[0].status === 'fulfilled' ? results[0].value : null);
        var fundData = parseTaseResponse(results[1].status === 'fulfilled' ? results[1].value : null);

        var elapsed = Date.now() - t0;

        if (results[0].status === 'rejected') console.log('  stock: ' + results[0].reason.message);
        else console.log('  stock: HTTP ' + results[0].value.status + ' json=' + !!secData);
        if (results[1].status === 'rejected') console.log('  fund:  ' + results[1].reason.message);
        else console.log('  fund:  HTTP ' + results[1].value.status + ' json=' + !!fundData);

        if (secData && secData.LastRate != null) {
            var secName = secData.LongName || secData.Name || getCachedFundName(id) || id;
            cacheFundName(id, secName);
            saveFundNameCache();
            console.log('  => stock: ' + secName + ' price=' + secData.LastRate + ' (' + elapsed + 'ms)');
            sendJson(res, 200, {
                source: 'tase-security',
                price: secData.LastRate,
                name: secName,
                change: secData.Change,
            });
            return;
        }

        if (fundData && fundData.UnitValuePrice != null) {
            var fundName = fundData.FundLongName || fundData.FundShortName || getCachedFundName(id) || id;
            cacheFundName(id, fundName);
            saveFundNameCache();
            console.log('  => fund: ' + fundName + ' price=' + fundData.UnitValuePrice + ' (' + elapsed + 'ms)');
            sendJson(res, 200, {
                source: 'tase-fund',
                price: fundData.UnitValuePrice,
                name: fundName,
                dayYield: fundData.DayYield,
                monthYield: fundData.MonthYield,
                yearYield: fundData.YearYield,
            });
            return;
        }

        // API failed but we may have a cached name
        var cachedName = getCachedFundName(id);
        if (cachedName) {
            console.log('  => API failed, using cached name: ' + cachedName + ' (' + elapsed + 'ms)');
            sendJson(res, 200, {
                source: 'cache',
                price: null,
                name: cachedName,
            });
            return;
        }

        console.log('  => NOT FOUND (' + elapsed + 'ms)');
        sendJson(res, 404, { error: 'Not found: ' + id });
        return;
    }

    // Batch endpoint: fetch multiple TASE IDs in one request
    if (url.pathname === '/api/tase/batch') {
        var ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
        if (ids.length === 0) { sendJson(res, 400, { error: 'No ids' }); return; }
        console.log('[TASE BATCH] ids=' + ids.join(','));
        var t0b = Date.now();

        var allPromises = ids.map(function (id) {
            var secUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                encodeURIComponent(id) + '&lang=1';
            var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' +
                encodeURIComponent(id);
            return Promise.allSettled([
                httpsGet(secUrl, TASE_STOCK_HEADERS, 5000),
                httpsGet(fundUrl, TASE_FUND_HEADERS, 5000),
            ]);
        });

        var allResults = await Promise.all(allPromises);
        var batchResult = {};

        for (var i = 0; i < ids.length; i++) {
            var bid = ids[i];
            var sr = allResults[i][0];
            var fr = allResults[i][1];
            var sd = parseTaseResponse(sr.status === 'fulfilled' ? sr.value : null);
            var fd = parseTaseResponse(fr.status === 'fulfilled' ? fr.value : null);

            if (sd && sd.LastRate != null) {
                var sName = sd.LongName || sd.Name || getCachedFundName(bid) || bid;
                cacheFundName(bid, sName);
                batchResult[bid] = {
                    source: 'tase-security',
                    price: sd.LastRate,
                    name: sName,
                    change: sd.Change,
                };
                console.log('  ' + bid + ': stock ' + sName + ' price=' + sd.LastRate);
            } else if (fd && fd.UnitValuePrice != null) {
                var fName = fd.FundLongName || fd.FundShortName || getCachedFundName(bid) || bid;
                cacheFundName(bid, fName);
                batchResult[bid] = {
                    source: 'tase-fund',
                    price: fd.UnitValuePrice,
                    name: fName,
                    dayYield: fd.DayYield,
                    monthYield: fd.MonthYield,
                    yearYield: fd.YearYield,
                };
                console.log('  ' + bid + ': fund ' + fName + ' price=' + fd.UnitValuePrice);
            } else {
                // API failed - try cached name
                var cName = getCachedFundName(bid);
                if (cName) {
                    batchResult[bid] = {
                        source: 'cache',
                        price: null,
                        name: cName,
                    };
                    console.log('  ' + bid + ': API failed, cached name: ' + cName);
                } else {
                    batchResult[bid] = null;
                    var reason = '';
                    if (sr.status === 'rejected') reason += 'stock-err:' + sr.reason.message;
                    else if (sr.value.status !== 200) reason += 'stock-http:' + sr.value.status;
                    else if (!sd) reason += 'stock:blocked/invalid-json';
                    else reason += 'stock:no-LastRate';
                    reason += ' | ';
                    if (fr.status === 'rejected') reason += 'fund-err:' + fr.reason.message;
                    else if (fr.value.status !== 200) reason += 'fund-http:' + fr.value.status;
                    else if (!fd) reason += 'fund:blocked/invalid-json';
                    else reason += 'fund:no-UnitValuePrice';
                    console.log('  ' + bid + ': NOT FOUND (' + reason + ')');
                }
            }
        }

        saveFundNameCache();
        console.log('[TASE BATCH] done in ' + (Date.now() - t0b) + 'ms');
        sendJson(res, 200, batchResult);
        return;
    }

    // Set fund names (POST or GET with query params)
    if (url.pathname === '/api/tase/names') {
        if (req.method === 'GET') {
            sendJson(res, 200, _fundNameCache);
            return;
        }
        if (req.method === 'POST') {
            var body = '';
            req.on('data', function (chunk) { body += chunk; });
            req.on('end', function () {
                try {
                    var names = JSON.parse(body);
                    var count = 0;
                    for (var nid in names) {
                        if (names.hasOwnProperty(nid) && names[nid]) {
                            _fundNameCache[nid] = names[nid];
                            count++;
                        }
                    }
                    saveFundNameCache();
                    console.log('[CACHE] Updated ' + count + ' fund names via API');
                    sendJson(res, 200, { ok: true, count: count });
                } catch (e) {
                    sendJson(res, 400, { error: 'Invalid JSON: ' + e.message });
                }
            });
            return;
        }
    }

    // Ping
    if (url.pathname === '/api/ping') {
        sendJson(res, 200, { ok: true, time: new Date().toISOString() });
        return;
    }

    // Diagnostic
    if (url.pathname === '/api/tase/test') {
        var testId = url.searchParams.get('id') || '507012';
        var results = { testId: testId, stock: {}, fund: {}, cachedName: getCachedFundName(testId) || null, timestamp: new Date().toISOString() };

        var stockP = httpsGet(
            'https://api.tase.co.il/api/company/securitydata?securityId=' + encodeURIComponent(testId) + '&lang=1',
            TASE_STOCK_HEADERS, 5000
        ).then(function (r) {
            var b = r.body.toString();
            results.stock = { status: r.status, isJson: b.length > 0 && b[0] === '{', bodyLength: b.length, bodyPreview: b.substring(0, 300) };
            if (results.stock.isJson) { try { var p = JSON.parse(b); results.stock.name = p.Name; results.stock.lastRate = p.LastRate; } catch (e) {} }
        }).catch(function (e) { results.stock = { error: e.message }; });

        var fundP = httpsGet(
            'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(testId),
            TASE_FUND_HEADERS, 5000
        ).then(function (r) {
            var b = r.body.toString();
            results.fund = { status: r.status, isJson: b.length > 0 && b[0] === '{', bodyLength: b.length, bodyPreview: b.substring(0, 300) };
            if (results.fund.isJson) { try { var p = JSON.parse(b); results.fund.name = p.FundShortName; results.fund.unitPrice = p.UnitValuePrice; } catch (e) {} }
        }).catch(function (e) { results.fund = { error: e.message }; });

        await Promise.allSettled([stockP, fundP]);
        sendJson(res, 200, results);
        return;
    }

    // Static files
    var filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    var fullPath = path.join(STATIC_DIR, filePath);
    if (!fullPath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.readFile(fullPath, function (err, data) {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        var ext = path.extname(fullPath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
  } catch (err) {
    console.error('[SERVER] Error: ' + err.message);
    try { sendJson(res, 500, { error: err.message }); } catch (e2) { /* ignore */ }
  }
}).listen(PORT, '0.0.0.0', function () {
    console.log('Server running at http://localhost:' + PORT);
    console.log('  Diagnostic: http://localhost:' + PORT + '/api/tase/test?id=507012');
    console.log('');
});
