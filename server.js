const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8081;
const STATIC_DIR = __dirname;

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
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
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        return res.end();
    }

    // Yahoo batch: fetch multiple symbols, 3 at a time to avoid rate limits
    // NOTE: Must be checked BEFORE the single-symbol route (startsWith '/api/yahoo/')
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
                return httpsGet(tgt, {}, 8000).then(function (r) {
                    return { symbol: s, status: r.status, body: r.body.toString() };
                });
            }));
            for (var cr = 0; cr < chunkResults.length; cr++) {
                var sym = chunk[cr];
                if (chunkResults[cr].status === 'fulfilled') {
                    var val = chunkResults[cr].value;
                    if (val.status === 200) {
                        try { batchResult[sym] = JSON.parse(val.body); } catch (e) { batchResult[sym] = null; }
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

    // Proxy: Yahoo Finance v8 chart API (single symbol)
    if (url.pathname.startsWith('/api/yahoo/')) {
        var symbol = url.pathname.replace('/api/yahoo/', '');
        var target = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(symbol) + '?range=1d&interval=1d';
        try {
            var r = await httpsGet(target);
            res.writeHead(r.status, {
                'Content-Type': r.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(r.body);
        } catch (err) {
            sendJson(res, 502, { error: err.message });
        }
        return;
    }

    // Proxy: TASE quote - tries BOTH stock and fund endpoints IN PARALLEL for speed
    if (url.pathname === '/api/tase/quote') {
        var id = url.searchParams.get('id') || '';
        var t0 = Date.now();
        console.log('[TASE] id=' + id);

        var secUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
            encodeURIComponent(id) + '&lang=1';
        var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' +
            encodeURIComponent(id);

        // Fire both requests in parallel with 5s timeout
        var results = await Promise.allSettled([
            httpsGet(secUrl, TASE_STOCK_HEADERS, 5000),
            httpsGet(fundUrl, TASE_FUND_HEADERS, 5000),
        ]);

        var secData = parseTaseResponse(results[0].status === 'fulfilled' ? results[0].value : null);
        var fundData = parseTaseResponse(results[1].status === 'fulfilled' ? results[1].value : null);

        var elapsed = Date.now() - t0;

        // Log what happened
        if (results[0].status === 'rejected') console.log('  stock: ' + results[0].reason.message);
        else console.log('  stock: HTTP ' + results[0].value.status + ' json=' + !!secData);
        if (results[1].status === 'rejected') console.log('  fund:  ' + results[1].reason.message);
        else console.log('  fund:  HTTP ' + results[1].value.status + ' json=' + !!fundData);

        // Prefer stock data if available
        if (secData && secData.LastRate != null) {
            console.log('  => stock: ' + (secData.Name || id) + ' price=' + secData.LastRate + ' (' + elapsed + 'ms)');
            sendJson(res, 200, {
                source: 'tase-security',
                price: secData.LastRate,
                name: secData.LongName || secData.Name || id,
                change: secData.Change,
            });
            return;
        }

        // Otherwise use fund data
        if (fundData && fundData.UnitValuePrice != null) {
            console.log('  => fund: ' + (fundData.FundShortName || id) + ' price=' + fundData.UnitValuePrice + ' (' + elapsed + 'ms)');
            sendJson(res, 200, {
                source: 'tase-fund',
                price: fundData.UnitValuePrice,
                name: fundData.FundLongName || fundData.FundShortName || id,
                dayYield: fundData.DayYield,
                monthYield: fundData.MonthYield,
                yearYield: fundData.YearYield,
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

        // Fire ALL requests for all IDs in parallel (stock + fund per ID)
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
                batchResult[bid] = {
                    source: 'tase-security',
                    price: sd.LastRate,
                    name: sd.LongName || sd.Name || bid,
                    change: sd.Change,
                };
                console.log('  ' + bid + ': stock ' + (sd.Name || bid) + ' price=' + sd.LastRate);
            } else if (fd && fd.UnitValuePrice != null) {
                batchResult[bid] = {
                    source: 'tase-fund',
                    price: fd.UnitValuePrice,
                    name: fd.FundLongName || fd.FundShortName || bid,
                    dayYield: fd.DayYield,
                    monthYield: fd.MonthYield,
                    yearYield: fd.YearYield,
                };
                console.log('  ' + bid + ': fund ' + (fd.FundShortName || bid) + ' price=' + fd.UnitValuePrice);
            } else {
                batchResult[bid] = null;
                console.log('  ' + bid + ': not found');
            }
        }

        console.log('[TASE BATCH] done in ' + (Date.now() - t0b) + 'ms');
        sendJson(res, 200, batchResult);
        return;
    }

    // Ping
    if (url.pathname === '/api/ping') {
        sendJson(res, 200, { ok: true, time: new Date().toISOString() });
        return;
    }

    // Diagnostic
    if (url.pathname === '/api/tase/test') {
        var testId = url.searchParams.get('id') || '507012';
        var results = { testId: testId, stock: {}, fund: {}, timestamp: new Date().toISOString() };

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
