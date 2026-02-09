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

function proxyRequest(targetUrl, extraHeaders, res) {
    https.get(targetUrl, { headers: extraHeaders }, function (upstream) {
        var chunks = [];
        upstream.on('data', function (c) { chunks.push(c); });
        upstream.on('end', function () {
            var body = Buffer.concat(chunks);
            res.writeHead(upstream.statusCode, {
                'Content-Type': upstream.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(body);
        });
    }).on('error', function (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });
}

http.createServer(function (req, res) {
    var url = new URL(req.url, 'http://localhost');

    // Proxy: Yahoo Finance
    if (url.pathname === '/api/yahoo') {
        var symbols = url.searchParams.get('symbols') || '';
        var target = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols);
        return proxyRequest(target, {}, res);
    }

    // Proxy: TASE Maya fund details
    if (url.pathname === '/api/tase/fund') {
        var fundId = url.searchParams.get('fundId') || '';
        var target = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(fundId);
        return proxyRequest(target, {
            'X-Maya-With': 'allow',
            'Accept-Language': 'en-US',
            'Referer': 'https://www.tase.co.il/',
        }, res);
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
