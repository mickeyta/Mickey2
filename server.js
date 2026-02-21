const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const STATIC_DIR = __dirname;
const NAME_CACHE_FILE = path.join(__dirname, 'fund-names-cache.json');
const HISTORY_CACHE_FILE = path.join(__dirname, 'history-cache.json');

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

/** Persistent history cache: { "SYMBOL": { timestamps: [...], closes: [...], fetchedAt: ms }, ... } */
var _historyCache = {};
try {
    if (fs.existsSync(HISTORY_CACHE_FILE)) {
        _historyCache = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8'));
        console.log('[HISTORY CACHE] Loaded ' + Object.keys(_historyCache).length + ' symbols from cache');
    }
} catch (e) {
    console.log('[HISTORY CACHE] Could not load: ' + e.message);
}

function saveHistoryCache() {
    try {
        fs.writeFileSync(HISTORY_CACHE_FILE, JSON.stringify(_historyCache), 'utf8');
    } catch (e) {
        console.log('[HISTORY CACHE] Could not save: ' + e.message);
    }
}

var _HISTORY_CACHE_TTL = 6 * 3600 * 1000; // 6 hours

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

// Yahoo crumb/cookie authentication for v7/v10 APIs
var _yahooCrumb = null;
var _yahooCookie = null;
var _yahooCrumbTs = 0;
var _CRUMB_TTL = 3600000; // 1 hour

async function getYahooCrumb() {
    if (_yahooCrumb && _yahooCookie && (Date.now() - _yahooCrumbTs < _CRUMB_TTL)) {
        return { crumb: _yahooCrumb, cookie: _yahooCookie };
    }
    // Step 1: GET fc.yahoo.com to obtain cookies
    try {
        var resp1 = await httpsGet('https://fc.yahoo.com/', YAHOO_HEADERS, 8000);
        var setCookies = resp1.headers['set-cookie'];
        if (!setCookies) {
            console.log('[YAHOO CRUMB] No cookies from fc.yahoo.com');
            return null;
        }
        // Extract cookie values
        var cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
        var cookies = cookieArr.map(function (c) { return c.split(';')[0]; }).join('; ');

        // Step 2: GET crumb using cookies
        var crumbHeaders = Object.assign({}, YAHOO_HEADERS, { 'Cookie': cookies });
        var resp2 = await httpsGet('https://query2.finance.yahoo.com/v1/test/getcrumb', crumbHeaders, 8000);
        if (resp2.status === 200) {
            var crumb = resp2.body.toString().trim();
            if (crumb && crumb.length < 50) {
                _yahooCrumb = crumb;
                _yahooCookie = cookies;
                _yahooCrumbTs = Date.now();
                console.log('[YAHOO CRUMB] obtained crumb: ' + crumb.substring(0, 8) + '...');
                return { crumb: _yahooCrumb, cookie: _yahooCookie };
            }
        }
        console.log('[YAHOO CRUMB] getcrumb returned HTTP ' + resp2.status);
    } catch (e) {
        console.log('[YAHOO CRUMB] error: ' + e.message);
    }
    return null;
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

    // Benchmark performance: fetch returns for QQQ and SPY across multiple time ranges
    if (url.pathname === '/api/yahoo/benchmarks') {
        console.log('[BENCHMARKS] fetching QQQ and SPY performance');
        var t0b = Date.now();
        var benchSymbols = ['QQQ', 'SPY', 'USDILS=X'];
        var ranges = [
            { key: '1d', range: '1d', interval: '5m' },
            { key: '5d', range: '5d', interval: '1d' },
            { key: '1mo', range: '1mo', interval: '1d' },
            { key: 'ytd', range: 'ytd', interval: '1mo' },
            { key: '1y', range: '1y', interval: '1mo' },
        ];
        var benchResult = {};

        // Fetch all symbols x ranges in parallel (10 requests)
        var allFetches = [];
        for (var bi = 0; bi < benchSymbols.length; bi++) {
            for (var ri = 0; ri < ranges.length; ri++) {
                (function (sym, rng) {
                    var bUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                        encodeURIComponent(sym) + '?range=' + rng.range + '&interval=' + rng.interval;
                    allFetches.push(
                        httpsGet(bUrl, YAHOO_HEADERS, 10000).then(function (r) {
                            return { sym: sym, key: rng.key, status: r.status, body: r.body.toString() };
                        }).catch(function () {
                            return { sym: sym, key: rng.key, status: 0, body: null };
                        })
                    );
                })(benchSymbols[bi], ranges[ri]);
            }
        }

        var allResults = await Promise.all(allFetches);
        for (var ai = 0; ai < allResults.length; ai++) {
            var ar = allResults[ai];
            if (!benchResult[ar.sym]) benchResult[ar.sym] = {};
            if (ar.status === 200 && ar.body) {
                try {
                    var json = JSON.parse(ar.body);
                    var meta = json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
                    var startPrice = meta ? meta.chartPreviousClose : null;
                    if (!startPrice) {
                        var opens = json.chart && json.chart.result && json.chart.result[0] &&
                            json.chart.result[0].indicators && json.chart.result[0].indicators.quote &&
                            json.chart.result[0].indicators.quote[0] && json.chart.result[0].indicators.quote[0].open;
                        if (opens) {
                            for (var oi = 0; oi < opens.length; oi++) {
                                if (opens[oi] != null) { startPrice = opens[oi]; break; }
                            }
                        }
                    }
                    var curPrice = meta ? meta.regularMarketPrice : null;
                    if (startPrice && curPrice && startPrice > 0) {
                        benchResult[ar.sym][ar.key] = ((curPrice - startPrice) / startPrice) * 100;
                    } else {
                        benchResult[ar.sym][ar.key] = null;
                    }
                } catch (e) {
                    benchResult[ar.sym][ar.key] = null;
                }
            } else {
                benchResult[ar.sym][ar.key] = null;
            }
        }

        console.log('[BENCHMARKS] done in ' + (Date.now() - t0b) + 'ms');
        sendJson(res, 200, benchResult);
        return;
    }

    // Yahoo yields: fetch returns for multiple symbols across time ranges
    if (url.pathname === '/api/yahoo/yields') {
        var syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        if (syms.length === 0) { sendJson(res, 400, { error: 'No symbols' }); return; }
        console.log('[YAHOO YIELDS] symbols=' + syms.join(','));
        var t0y2 = Date.now();
        var yieldsResult = {};
        var CONC = 3;
        var yieldRanges = [
            { key: '1d', range: '1d', interval: '5m' },
            { key: '5d', range: '5d', interval: '1d' },
            { key: '1mo', range: '1mo', interval: '1d' },
            { key: 'ytd', range: 'ytd', interval: '1mo' },
            { key: '1y', range: '1y', interval: '1mo' },
        ];

        function _extractReturn(chartJson) {
            if (!chartJson || !chartJson.chart || !chartJson.chart.result || !chartJson.chart.result[0]) return null;
            var m = chartJson.chart.result[0].meta;
            if (!m) return null;
            // chartPreviousClose is the close price right before the range started — most reliable reference
            var sp = m.chartPreviousClose;
            if (!sp) {
                // Fallback to first non-null open
                var opArr = chartJson.chart.result[0].indicators &&
                    chartJson.chart.result[0].indicators.quote &&
                    chartJson.chart.result[0].indicators.quote[0] &&
                    chartJson.chart.result[0].indicators.quote[0].open;
                if (opArr) { for (var i2 = 0; i2 < opArr.length; i2++) { if (opArr[i2] != null) { sp = opArr[i2]; break; } } }
            }
            var cp = m.regularMarketPrice;
            // Handle ILA (agorot) currency — both sp and cp should be in same unit from chart API
            if (sp && cp && sp > 0) return ((cp - sp) / sp) * 100;
            return null;
        }

        for (var ci2 = 0; ci2 < syms.length; ci2 += CONC) {
            var chunk2 = syms.slice(ci2, ci2 + CONC);
            var chunkResults2 = await Promise.allSettled(chunk2.map(function (s) {
                // Fetch all ranges for this symbol in parallel
                var rangeFetches = yieldRanges.map(function (rng) {
                    var yUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                        encodeURIComponent(s) + '?range=' + rng.range + '&interval=' + rng.interval;
                    return httpsGet(yUrl, YAHOO_HEADERS, 8000).then(function (r) {
                        if (r.status === 200) {
                            try { return { key: rng.key, data: JSON.parse(r.body.toString()) }; } catch (e) {}
                        }
                        return { key: rng.key, data: null };
                    }).catch(function () { return { key: rng.key, data: null }; });
                });
                return Promise.all(rangeFetches).then(function (results) {
                    return { symbol: s, ranges: results };
                });
            }));
            for (var cr2 = 0; cr2 < chunkResults2.length; cr2++) {
                var sym2 = chunk2[cr2];
                if (chunkResults2[cr2].status === 'fulfilled') {
                    var v = chunkResults2[cr2].value;
                    var entry = {};
                    for (var rri = 0; rri < v.ranges.length; rri++) {
                        var rr = v.ranges[rri];
                        var ret = _extractReturn(rr.data);
                        if (rr.key === 'ytd') entry.ytd = ret;
                        else if (rr.key === '1y') entry.oneYear = ret;
                        else if (rr.key === '1d') entry.day1 = ret;
                        else if (rr.key === '5d') entry.day5 = ret;
                        else if (rr.key === '1mo') entry.month1 = ret;
                    }
                    if (entry.oneYear != null) console.log('  ' + sym2 + ': 1Y=' + entry.oneYear.toFixed(2) + '%');
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

    // Yahoo P/E ratios: fetch trailingPE for multiple symbols via v7 quote API (with crumb auth)
    if (url.pathname === '/api/yahoo/pe') {
        var pSyms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        if (pSyms.length === 0) { sendJson(res, 400, { error: 'No symbols' }); return; }
        console.log('[YAHOO PE] symbols=' + pSyms.join(','));
        var t0pe = Date.now();
        var peResult = {};

        var auth = await getYahooCrumb();
        if (auth) {
            var peUrl = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' +
                pSyms.map(encodeURIComponent).join(',') +
                '&fields=trailingPE,forwardPE&crumb=' + encodeURIComponent(auth.crumb);
            var peHeaders = Object.assign({}, YAHOO_HEADERS, { 'Cookie': auth.cookie });
            try {
                var peResp = await httpsGet(peUrl, peHeaders, 15000);
                if (peResp.status === 200) {
                    var peJson = JSON.parse(peResp.body.toString());
                    var quotes = peJson && peJson.quoteResponse && peJson.quoteResponse.result;
                    if (quotes) {
                        for (var qi = 0; qi < quotes.length; qi++) {
                            var q = quotes[qi];
                            var qSym = q.symbol ? q.symbol.toUpperCase() : null;
                            if (qSym) {
                                peResult[qSym] = {
                                    trailingPE: q.trailingPE != null ? q.trailingPE : null,
                                    forwardPE: q.forwardPE != null ? q.forwardPE : null,
                                };
                            }
                        }
                    }
                } else {
                    console.log('[YAHOO PE] v7 returned HTTP ' + peResp.status + ', invalidating crumb');
                    _yahooCrumb = null; // force refresh next time
                }
            } catch (e) {
                console.log('[YAHOO PE] fetch error: ' + e.message);
            }
        } else {
            console.log('[YAHOO PE] could not obtain crumb, skipping');
        }

        // Fill in missing symbols with null
        for (var pi = 0; pi < pSyms.length; pi++) {
            var upperSym = pSyms[pi].toUpperCase();
            if (!peResult[upperSym]) {
                peResult[upperSym] = null;
            }
        }

        console.log('[YAHOO PE] done in ' + (Date.now() - t0pe) + 'ms');
        sendJson(res, 200, peResult);
        return;
    }

    // Weekly history: fetch 1y of weekly close data for symbols + benchmarks
    if (url.pathname === '/api/yahoo/history') {
        var hSyms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        // Always include benchmarks and FX
        var allSyms = ['QQQ', 'SPY', 'USDILS=X'];
        for (var hi = 0; hi < hSyms.length; hi++) {
            if (allSyms.indexOf(hSyms[hi]) === -1) allSyms.push(hSyms[hi]);
        }
        console.log('[HISTORY] symbols=' + allSyms.join(','));
        var t0h = Date.now();
        var now = Date.now();

        // Determine which symbols need fetching (not cached or cache expired)
        var toFetch = [];
        for (var si = 0; si < allSyms.length; si++) {
            var s = allSyms[si];
            var cached = _historyCache[s];
            if (cached && cached.fetchedAt && (now - cached.fetchedAt < _HISTORY_CACHE_TTL)) {
                console.log('  ' + s + ': using cache (' + Math.round((now - cached.fetchedAt) / 60000) + 'min old)');
            } else {
                toFetch.push(s);
            }
        }

        // Fetch stale symbols from Yahoo (1y range, 1wk interval)
        if (toFetch.length > 0) {
            console.log('  Fetching: ' + toFetch.join(','));
            var histFetches = toFetch.map(function (sym) {
                var hUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(sym) + '?range=1y&interval=1wk';
                return httpsGet(hUrl, YAHOO_HEADERS, 15000).then(function (r) {
                    return { sym: sym, status: r.status, body: r.body.toString() };
                }).catch(function (e) {
                    return { sym: sym, status: 0, body: null, error: e.message };
                });
            });
            var histResults = await Promise.all(histFetches);
            for (var hri = 0; hri < histResults.length; hri++) {
                var hr = histResults[hri];
                if (hr.status === 200 && hr.body) {
                    try {
                        var hJson = JSON.parse(hr.body);
                        var hResult = hJson.chart && hJson.chart.result && hJson.chart.result[0];
                        if (hResult) {
                            var ts = hResult.timestamp || [];
                            var closes = hResult.indicators && hResult.indicators.quote &&
                                hResult.indicators.quote[0] && hResult.indicators.quote[0].close || [];
                            var adjCloses = hResult.indicators && hResult.indicators.adjclose &&
                                hResult.indicators.adjclose[0] && hResult.indicators.adjclose[0].adjclose || closes;
                            var currency = hResult.meta && hResult.meta.currency || 'USD';
                            _historyCache[hr.sym] = {
                                timestamps: ts,
                                closes: adjCloses,
                                currency: currency,
                                fetchedAt: Date.now(),
                            };
                            console.log('  ' + hr.sym + ': got ' + ts.length + ' data points');
                        }
                    } catch (e) {
                        console.log('  ' + hr.sym + ': parse error: ' + e.message);
                    }
                } else {
                    console.log('  ' + hr.sym + ': HTTP ' + hr.status + (hr.error ? ' ' + hr.error : ''));
                }
            }
            saveHistoryCache();
        }

        // Build response
        var histResponse = {};
        for (var ri2 = 0; ri2 < allSyms.length; ri2++) {
            var rs = allSyms[ri2];
            histResponse[rs] = _historyCache[rs] ? {
                timestamps: _historyCache[rs].timestamps,
                closes: _historyCache[rs].closes,
                currency: _historyCache[rs].currency,
            } : null;
        }

        console.log('[HISTORY] done in ' + (Date.now() - t0h) + 'ms');
        sendJson(res, 200, histResponse);
        return;
    }

    // Clear history cache
    if (url.pathname === '/api/yahoo/history/clear-cache') {
        _historyCache = {};
        saveHistoryCache();
        console.log('[HISTORY CACHE] Cleared');
        sendJson(res, 200, { ok: true, message: 'History cache cleared' });
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
