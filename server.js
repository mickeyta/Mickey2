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

const TASE_HEADERS = {
    'User-Agent': 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; FSL 7.0.6.01001)',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.tase.co.il/',
};

function httpsGet(targetUrl, headers) {
    return new Promise(function (resolve, reject) {
        https.get(targetUrl, { headers: headers || {} }, function (upstream) {
            var chunks = [];
            upstream.on('data', function (c) { chunks.push(c); });
            upstream.on('end', function () {
                resolve({ status: upstream.statusCode, body: Buffer.concat(chunks), headers: upstream.headers });
            });
        }).on('error', reject);
    });
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

http.createServer(async function (req, res) {
    var url = new URL(req.url, 'http://localhost');

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
        try {
            // Try stock/security endpoint first
            var secUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                encodeURIComponent(id) + '&lang=1';
            var secResp = await httpsGet(secUrl, TASE_HEADERS);
            var secBody = secResp.body.toString();

            if (secResp.status === 200 && secBody && secBody !== 'null') {
                var secData = JSON.parse(secBody);
                if (secData && secData.LastRate != null) {
                    sendJson(res, 200, {
                        source: 'tase-security',
                        price: secData.LastRate,
                        name: secData.SecurityLongName || secData.Name || id,
                        type: secData.Type,
                        symbol: secData.Symbol,
                        change: secData.Change,
                        monthYield: secData.MonthYield,
                        annualYield: secData.AnnualYield,
                    });
                    return;
                }
            }

            // Fall back to fund endpoint
            var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(id);
            var fundHeaders = Object.assign({}, TASE_HEADERS, {
                'X-Maya-With': 'allow',
                'Accept-Language': 'en-US',
            });
            var fundResp = await httpsGet(fundUrl, fundHeaders);
            var fundBody = fundResp.body.toString();

            if (fundResp.status === 200 && fundBody) {
                var fundData = JSON.parse(fundBody);
                if (fundData && fundData.UnitValuePrice != null) {
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
            }

            sendJson(res, 404, { error: 'Security not found: ' + id });
        } catch (err) {
            sendJson(res, 502, { error: err.message });
        }
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
}).listen(PORT, function () {
    console.log('Server running at http://localhost:' + PORT);
});
