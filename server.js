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

// Full browser-like headers to bypass Incapsula bot detection
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

// Legacy IE6 User-Agent as fallback (sometimes bypasses bot protection)
const TASE_LEGACY_HEADERS = {
    'User-Agent': 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; FSL 7.0.6.01001)',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.tase.co.il/',
};

function httpsGet(targetUrl, headers, timeout) {
    if (!timeout) timeout = 15000;
    return new Promise(function (resolve, reject) {
        var parsedUrl = new URL(targetUrl);
        var options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: headers || {},
            rejectUnauthorized: true,
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
            req.destroy(new Error('Request timed out after ' + timeout + 'ms'));
        });
        req.end();
    });
}

/** Try a request with primary headers, then retry with legacy headers on failure */
async function httpsGetWithRetry(targetUrl, primaryHeaders, fallbackHeaders) {
    // Attempt 1: primary headers
    try {
        var r = await httpsGet(targetUrl, primaryHeaders);
        var body = r.body.toString();
        // Incapsula returns HTML challenge pages (not JSON) on block
        if (r.status === 200 && body.length > 0 && body[0] === '{') {
            return r;
        }
        console.log('  [attempt 1] status=' + r.status + ' bodyStart=' + body.substring(0, 120).replace(/\n/g, ' '));
    } catch (e) {
        console.log('  [attempt 1] error: ' + e.message);
    }

    // Attempt 2: fallback legacy headers
    if (fallbackHeaders) {
        try {
            await new Promise(function (r) { setTimeout(r, 500); });
            var r2 = await httpsGet(targetUrl, fallbackHeaders);
            var body2 = r2.body.toString();
            if (r2.status === 200 && body2.length > 0 && body2[0] === '{') {
                return r2;
            }
            console.log('  [attempt 2] status=' + r2.status + ' bodyStart=' + body2.substring(0, 120).replace(/\n/g, ' '));
        } catch (e) {
            console.log('  [attempt 2] error: ' + e.message);
        }
    }

    // Attempt 3: retry primary headers after a longer delay
    try {
        await new Promise(function (r) { setTimeout(r, 2000); });
        var r3 = await httpsGet(targetUrl, primaryHeaders);
        var body3 = r3.body.toString();
        if (r3.status === 200 && body3.length > 0 && body3[0] === '{') {
            return r3;
        }
        console.log('  [attempt 3] status=' + r3.status + ' bodyStart=' + body3.substring(0, 120).replace(/\n/g, ' '));
    } catch (e) {
        console.log('  [attempt 3] error: ' + e.message);
    }

    return null;
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

http.createServer(async function (req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        return res.end();
    }

    // Proxy: Yahoo Finance v8 chart API
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

    // Proxy: TASE unified quote - tries stock endpoint first, then fund endpoint
    if (url.pathname === '/api/tase/quote') {
        var id = url.searchParams.get('id') || '';
        console.log('[TASE] Fetching quote for id=' + id);

        try {
            // Try stock/security endpoint first
            var secUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                encodeURIComponent(id) + '&lang=1';
            console.log('  Trying stock endpoint: ' + secUrl);

            var secResp = await httpsGetWithRetry(secUrl, TASE_STOCK_HEADERS, TASE_LEGACY_HEADERS);

            if (secResp && secResp.status === 200) {
                var secBody = secResp.body.toString();
                if (secBody && secBody !== 'null' && secBody[0] === '{') {
                    try {
                        var secData = JSON.parse(secBody);
                        if (secData && secData.LastRate != null) {
                            console.log('  => Stock found: ' + (secData.Name || id) + ' price=' + secData.LastRate);
                            sendJson(res, 200, {
                                source: 'tase-security',
                                price: secData.LastRate,
                                name: secData.LongName || secData.Name || id,
                                type: secData.Type,
                                symbol: secData.Symbol,
                                change: secData.Change,
                                monthYield: secData.MonthYield,
                                annualYield: secData.AnnualYield,
                            });
                            return;
                        }
                    } catch (parseErr) {
                        console.log('  Stock JSON parse error: ' + parseErr.message);
                    }
                }
            }

            // Fall back to fund endpoint
            var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(id);
            console.log('  Trying fund endpoint: ' + fundUrl);

            var fundResp = await httpsGetWithRetry(fundUrl, TASE_FUND_HEADERS, TASE_LEGACY_HEADERS);

            if (fundResp && fundResp.status === 200) {
                var fundBody = fundResp.body.toString();
                if (fundBody && fundBody[0] === '{') {
                    try {
                        var fundData = JSON.parse(fundBody);
                        if (fundData && fundData.UnitValuePrice != null) {
                            console.log('  => Fund found: ' + (fundData.FundShortName || id) + ' price=' + fundData.UnitValuePrice);
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
                    } catch (parseErr) {
                        console.log('  Fund JSON parse error: ' + parseErr.message);
                    }
                }
            }

            console.log('  => NOT FOUND for id=' + id);
            sendJson(res, 404, { error: 'Security not found: ' + id });
        } catch (err) {
            console.log('  => ERROR for id=' + id + ': ' + err.message);
            sendJson(res, 502, { error: err.message });
        }
        return;
    }

    // Simple ping to verify server is running
    if (url.pathname === '/api/ping') {
        sendJson(res, 200, { ok: true, time: new Date().toISOString() });
        return;
    }

    // Diagnostic endpoint: test TASE APIs directly and report status
    if (url.pathname === '/api/tase/test') {
        var testId = url.searchParams.get('id') || '507012';
        var results = { testId: testId, stock: {}, fund: {}, timestamp: new Date().toISOString() };

        // Test stock endpoint with short timeout
        try {
            var sUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                encodeURIComponent(testId) + '&lang=1';
            console.log('[TEST] Testing stock endpoint for id=' + testId);
            var sResp = await httpsGet(sUrl, TASE_STOCK_HEADERS, 8000);
            var sBody = sResp.body.toString();
            results.stock = {
                status: sResp.status,
                isJson: sBody.length > 0 && sBody[0] === '{',
                bodyLength: sBody.length,
                bodyPreview: sBody.substring(0, 300),
                contentType: sResp.headers['content-type'],
            };
            if (results.stock.isJson) {
                try {
                    var parsed = JSON.parse(sBody);
                    results.stock.name = parsed.Name;
                    results.stock.lastRate = parsed.LastRate;
                } catch (e) { results.stock.parseError = e.message; }
            }
            console.log('[TEST] Stock result: status=' + sResp.status + ' isJson=' + results.stock.isJson);
        } catch (e) {
            results.stock = { error: e.message };
            console.log('[TEST] Stock error: ' + e.message);
        }

        // Test fund endpoint with short timeout
        try {
            var fUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(testId);
            console.log('[TEST] Testing fund endpoint for id=' + testId);
            var fResp = await httpsGet(fUrl, TASE_FUND_HEADERS, 8000);
            var fBody = fResp.body.toString();
            results.fund = {
                status: fResp.status,
                isJson: fBody.length > 0 && fBody[0] === '{',
                bodyLength: fBody.length,
                bodyPreview: fBody.substring(0, 300),
                contentType: fResp.headers['content-type'],
            };
            if (results.fund.isJson) {
                try {
                    var parsed2 = JSON.parse(fBody);
                    results.fund.name = parsed2.FundShortName;
                    results.fund.unitPrice = parsed2.UnitValuePrice;
                } catch (e) { results.fund.parseError = e.message; }
            }
            console.log('[TEST] Fund result: status=' + fResp.status + ' isJson=' + results.fund.isJson);
        } catch (e) {
            results.fund = { error: e.message };
            console.log('[TEST] Fund error: ' + e.message);
        }

        sendJson(res, 200, results);
        return;
    }

    // Static files
    var filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    var fullPath = path.join(STATIC_DIR, filePath);

    // Prevent directory traversal
    if (!fullPath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.readFile(fullPath, function (err, data) {
        if (err) {
            res.writeHead(404);
            return res.end('Not found');
        }
        var ext = path.extname(fullPath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
  } catch (err) {
    console.error('[SERVER] Unhandled error: ' + err.message);
    try { sendJson(res, 500, { error: 'Internal server error: ' + err.message }); } catch (e2) { /* ignore */ }
  }
}).listen(PORT, '0.0.0.0', function () {
    console.log('Server running at http://localhost:' + PORT);
    console.log('  Open in browser: http://localhost:' + PORT);
    console.log('  TASE diagnostic: http://localhost:' + PORT + '/api/tase/test?id=507012');
    console.log('');
});
