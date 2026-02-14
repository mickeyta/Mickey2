/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API.
 *
 * Tries local server first (same origin, then localhost:8081),
 * falls back to CORS proxy if server unavailable.
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = 'https://api.allorigins.win/get?url=';
    let _corsProxies = [
        { url: 'https://api.allorigins.win/get?url=', type: 'allorigins' },
        { url: 'https://api.allorigins.win/raw?url=', type: 'raw' },
        { url: 'https://corsproxy.io/?url=', type: 'raw' },
    ];
    let _serverBase = null; // null = not detected, '' = same origin, 'http://...' = different port, false = no server
    let _serverProbeTs = 0; // timestamp of last probe attempt
    const _serverProbeTTL = 60 * 1000; // re-probe after 60 seconds

    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.corsProxy !== undefined) _corsProxy = options.corsProxy;
    }

    /** Israeli security IDs are 5-8 digit numbers */
    function _isIsraeliSecurity(symbol) {
        return /^\d{5,8}$/.test(symbol);
    }

    /** Parse Yahoo v8 chart JSON into a quote object */
    function _parseYahooChart(json, sym) {
        if (!json || !json.chart || !json.chart.result || !json.chart.result[0]) return null;
        var meta = json.chart.result[0].meta;
        var currency = meta.currency || 'USD';
        if (currency === 'ILA') currency = 'ILS';
        var price = meta.regularMarketPrice;
        if (meta.currency === 'ILA' && price != null) price = price / 100;
        var prevClose = meta.chartPreviousClose;
        if (meta.currency === 'ILA' && prevClose != null) prevClose = prevClose / 100;
        return {
            price: price != null ? price : null,
            previousClose: prevClose != null ? prevClose : null,
            change: (price != null && prevClose != null) ? price - prevClose : null,
            changePercent: (price != null && prevClose != null && prevClose !== 0)
                ? ((price - prevClose) / prevClose) * 100 : null,
            currency: currency,
            name: meta.shortName || meta.longName || meta.symbol || sym,
        };
    }

    /** Fetch with a timeout (ms). Returns null on timeout/error. */
    async function _fetchWithTimeout(url, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        try {
            var resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            return resp;
        } catch (e) {
            clearTimeout(timer);
            return null;
        }
    }

    /** Check if a ping URL returns valid JSON with {ok: true} */
    async function _pingIsValid(url) {
        try {
            var resp = await _fetchWithTimeout(url, 1500);
            if (!resp || !resp.ok) return false;
            var json = await resp.json();
            return json && json.ok === true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Probe for an API server (same origin or localhost:8081).
     * Caches the result so it only runs once per session (or re-probes after TTL).
     */
    async function _probeServer() {
        // Already know the answer (server found or not found within TTL)
        if (_serverBase === false && Date.now() - _serverProbeTs < _serverProbeTTL) return;
        if (_serverBase !== null && _serverBase !== false) return;

        // Reset for fresh probe
        _serverBase = null;

        // Try relative URL (same origin)
        if (await _pingIsValid('/api/ping')) {
            _serverBase = '';
            console.log('[MarketData] Server at current origin');
            return;
        }

        // Try localhost:8081
        if (await _pingIsValid('http://localhost:8081/api/ping')) {
            _serverBase = 'http://localhost:8081';
            console.log('[MarketData] Server at http://localhost:8081');
            return;
        }

        // No server found
        _serverBase = false;
        _serverProbeTs = Date.now();
        console.log('[MarketData] No server detected, using CORS proxy fallback');
    }

    /**
     * Try to fetch a server API path. Returns the response or null.
     * Assumes _probeServer() has already been called.
     */
    async function _serverFetch(path, timeoutMs) {
        if (!_serverBase) return null; // false or null = no server

        var resp = await _fetchWithTimeout(_serverBase + path, timeoutMs);
        if (resp && resp.ok) return resp;
        // Server stopped working, reset detection
        _serverBase = null;
        return null;
    }

    /**
     * Fetch a URL through CORS proxies. Tries each proxy in order until one works.
     */
    async function _proxiedFetch(targetUrl) {
        for (var pi = 0; pi < _corsProxies.length; pi++) {
            var proxy = _corsProxies[pi];
            var url = proxy.url + encodeURIComponent(targetUrl);
            try {
                var resp = await _fetchWithTimeout(url, 8000);
                if (!resp) {
                    console.log('[proxy] ' + proxy.url.split('/')[2] + ': timeout/network error');
                    continue;
                }
                if (!resp.ok) {
                    console.log('[proxy] ' + proxy.url.split('/')[2] + ': HTTP ' + resp.status);
                    continue;
                }

                if (proxy.type === 'allorigins') {
                    // allorigins /get wraps in {contents: "...", status: {...}}
                    var wrapper = await resp.json();
                    if (wrapper && wrapper.contents !== undefined) {
                        if (wrapper.status && wrapper.status.http_code && wrapper.status.http_code >= 400) {
                            console.log('[proxy] ' + proxy.url.split('/')[2] + ': upstream HTTP ' + wrapper.status.http_code);
                            continue;
                        }
                        return JSON.parse(wrapper.contents);
                    }
                } else {
                    // raw proxy returns the content directly
                    var text = await resp.text();
                    if (text && (text[0] === '{' || text[0] === '[')) {
                        return JSON.parse(text);
                    }
                    console.log('[proxy] ' + proxy.url.split('/')[2] + ': non-JSON response (' + text.substring(0, 80) + ')');
                }
            } catch (e) {
                console.log('[proxy] ' + proxy.url.split('/')[2] + ': ' + e.message);
            }
        }
        return null;
    }

    /**
     * Fetch current quotes for the given stock symbols.
     */
    async function fetchQuotes(symbols, onProgress) {
        if (!symbols || symbols.length === 0) return {};

        const now = Date.now();
        const upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            var israeliIds = stale.filter(_isIsraeliSecurity);
            var yahooSymbols = stale.filter(function (s) { return !_isIsraeliSecurity(s); });

            var total = stale.length;
            var done = 0;
            var fetched = {};

            function progress(sym) {
                done++;
                if (onProgress) onProgress(done, total, sym);
            }

            // Probe for server once before parallel fetches to avoid duplicate pings
            await _probeServer();

            var yahooPromise = yahooSymbols.length > 0
                ? _fetchYahooSymbols(yahooSymbols, fetched, progress)
                : Promise.resolve();

            var tasePromise = israeliIds.length > 0
                ? _fetchTASESymbols(israeliIds, fetched, progress)
                : Promise.resolve();

            await Promise.all([yahooPromise, tasePromise]);

            var ts = Date.now();
            for (var sym2 in fetched) {
                _cache[sym2] = Object.assign({}, fetched[sym2], { _ts: ts });
            }
        }

        var result = {};
        for (var j = 0; j < upper.length; j++) {
            var s = upper[j];
            if (_cache[s]) {
                var entry = Object.assign({}, _cache[s]);
                delete entry._ts;
                result[s] = entry;
            } else {
                result[s] = null;
            }
        }
        return result;
    }

    /**
     * Fetch Yahoo symbols via server or CORS proxy.
     */
    async function _fetchYahooSymbols(syms, fetched, progress) {
        // Try server batch endpoint (same origin or localhost:8081)
        try {
            var resp = await _serverFetch(
                '/api/yahoo/batch?symbols=' + syms.map(encodeURIComponent).join(','), 30000);
            if (resp) {
                var batchData = await resp.json();
                for (var i = 0; i < syms.length; i++) {
                    var sym = syms[i];
                    if (batchData && batchData[sym]) {
                        var q = _parseYahooChart(batchData[sym], sym);
                        if (q) fetched[sym] = q;
                    }
                    progress(sym);
                }
                return;
            }
        } catch (e) {}

        // Fall back to individual CORS-proxied fetches, 3 at a time
        console.log('[Yahoo] Using CORS proxy');
        for (var ci = 0; ci < syms.length; ci += 3) {
            var chunk = syms.slice(ci, ci + 3);
            await Promise.all(chunk.map(function (sym) {
                var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(sym) + '?range=1d&interval=1d';
                return _proxiedFetch(targetUrl).then(function (json) {
                    var q = _parseYahooChart(json, sym);
                    if (q) {
                        fetched[sym] = q;
                    } else {
                        console.warn('[Yahoo] ' + sym + ': failed to parse response' + (json ? ' (got keys: ' + Object.keys(json).join(',') + ')' : ' (null response - all proxies failed)'));
                    }
                    progress(sym);
                }).catch(function (err) {
                    console.warn('[Yahoo] ' + sym + ': fetch error: ' + err.message);
                    progress(sym);
                });
            }));
        }
    }

    /**
     * Fetch TASE symbols via server or CORS proxy.
     */
    async function _fetchTASESymbols(ids, fetched, progress) {
        // Try server batch endpoint
        try {
            var resp = await _serverFetch(
                '/api/tase/batch?ids=' + ids.map(encodeURIComponent).join(','), 30000);
            if (resp) {
                var batchData = await resp.json();
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    if (batchData && batchData[id]) {
                        var q = _parseTASEResult(id, batchData[id]);
                        if (q) fetched[id] = q;
                    }
                    progress(id);
                }
                return;
            }
        } catch (e) {}

        // Fall back to Yahoo Finance with .TA suffix (works via CORS proxy)
        // TASE APIs block CORS proxies due to custom header requirements
        console.log('[TASE] Using Yahoo Finance .TA suffix via CORS proxy');
        for (var ci = 0; ci < ids.length; ci += 3) {
            var chunk = ids.slice(ci, ci + 3);
            await Promise.all(chunk.map(function (id) {
                var yahooSymbol = id + '.TA';
                var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(yahooSymbol) + '?range=1d&interval=1d';
                return _proxiedFetch(targetUrl).then(function (json) {
                    var q = _parseYahooChart(json, yahooSymbol);
                    if (q) {
                        // Override currency to ILS for TASE securities
                        q.currency = 'ILS';
                        fetched[id] = q;
                    } else {
                        console.warn('[TASE] ' + id + ' (' + yahooSymbol + '): failed to parse response' + (json ? ' (got keys: ' + Object.keys(json).join(',') + ')' : ' (null response - all proxies failed)'));
                    }
                    progress(id);
                }).catch(function (err) {
                    console.warn('[TASE] ' + id + ': fetch error: ' + err.message);
                    progress(id);
                });
            }));
        }
    }

    /** Convert a TASE batch result item (from server proxy) to a quote object */
    function _parseTASEResult(id, data) {
        if (!data || !data.price) return null;
        return {
            price: data.price / 100,  // agorot to ILS
            previousClose: null,
            change: null,
            changePercent: data.dayYield != null ? data.dayYield : null,
            currency: 'ILS',
            name: data.name || id,
        };
    }

    function getCached(symbol) {
        var c = _cache[symbol.toUpperCase()];
        if (!c) return null;
        var entry = Object.assign({}, c);
        delete entry._ts;
        return entry;
    }

    function clearCache() {
        for (var k in _cache) {
            if (_cache.hasOwnProperty(k)) {
                delete _cache[k];
            }
        }
    }

    return {
        configure: configure,
        fetchQuotes: fetchQuotes,
        getCached: getCached,
        clearCache: clearCache,
    };
})();
