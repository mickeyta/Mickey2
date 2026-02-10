/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API (via local proxy server).
 *
 * Usage:
 *   const quotes = await MarketData.fetchQuotes(['AAPL', 'MSFT']);
 *   console.log(quotes.AAPL.price); // 185.50
 *
 * With progress callback:
 *   await MarketData.fetchQuotes(['AAPL','MSFT'], function(done, total) {
 *       console.log(done + '/' + total);
 *   });
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = 'https://api.allorigins.win/get?url=';

    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.corsProxy !== undefined) _corsProxy = options.corsProxy;
    }

    /** Israeli security IDs are 5-8 digit numbers */
    function _isIsraeliSecurity(symbol) {
        return /^\d{5,8}$/.test(symbol);
    }

    /**
     * Fetch a URL through the allorigins CORS proxy with retry.
     * The /get endpoint wraps the response in {contents: "..."}.
     */
    async function _proxiedFetch(targetUrl, retries) {
        if (retries === undefined) retries = 2;
        var url = _corsProxy + encodeURIComponent(targetUrl);

        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                if (attempt > 0) {
                    await new Promise(function (r) { setTimeout(r, 1000 * attempt); });
                }
                var resp = await fetch(url);
                if (!resp.ok) continue;

                var wrapper = await resp.json();
                // allorigins /get returns {contents: "...", status: {http_code: N}}
                if (wrapper && wrapper.contents !== undefined) {
                    if (wrapper.status && wrapper.status.http_code && wrapper.status.http_code >= 400) {
                        continue;
                    }
                    return JSON.parse(wrapper.contents);
                }
                // If proxy returns raw JSON (user configured a different proxy)
                return wrapper;
            } catch (e) {
                // retry
            }
        }
        return null;
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * @param {string[]} symbols
     * @param {Function} [onProgress] - callback(fetched, total)
     * @returns {Promise<Object.<string, QuoteData|null>>}
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
            function progress() {
                done++;
                if (onProgress) onProgress(done, total);
            }

            var fetched = {};

            // Fetch Yahoo symbols via allorigins CORS proxy
            for (var ri = 0; ri < yahooSymbols.length; ri++) {
                var sym = yahooSymbols[ri];
                var quote = await _fetchYahooSingle(sym);
                if (quote) fetched[sym] = quote;
                progress();
            }

            // Fetch Israeli securities via local server proxy
            for (var fi = 0; fi < israeliIds.length; fi++) {
                var id = israeliIds[fi];
                var iquote = await _fetchTASESingle(id);
                if (iquote) fetched[id] = iquote;
                progress();
            }

            var ts = Date.now();
            for (var sym2 in fetched) {
                _cache[sym2] = Object.assign({}, fetched[sym2], { _ts: ts });
            }
            for (var i = 0; i < stale.length; i++) {
                if (!fetched[stale[i]] && !_cache[stale[i]]) {
                    _cache[stale[i]] = { price: null, _ts: ts };
                }
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

    /** Fetch a single stock quote from Yahoo Finance v8 chart API. Uses local proxy if available, falls back to allorigins. */
    async function _fetchYahooSingle(sym) {
        var json = null;

        // Try local server proxy first (faster and more reliable)
        try {
            var localResp = await fetch('/api/yahoo/' + encodeURIComponent(sym));
            if (localResp.ok) {
                json = await localResp.json();
            }
        } catch (e) {
            // Local server not running, fall back to CORS proxy
        }

        // Fall back to allorigins CORS proxy
        if (!json) {
            var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(sym) + '?range=1d&interval=1d';
            json = await _proxiedFetch(targetUrl);
        }

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

    /**
     * Fetch a single Israeli security from the local TASE proxy.
     * The server tries the stock endpoint first, then the fund endpoint.
     * Requires running: node server.js
     */
    async function _fetchTASESingle(id) {
        try {
            var resp = await fetch('/api/tase/quote?id=' + encodeURIComponent(id));
            if (!resp.ok) {
                console.warn('[TASE] HTTP ' + resp.status + ' for id=' + id);
                var errText = '';
                try { errText = await resp.text(); } catch (e2) { /* ignore */ }
                console.warn('[TASE] Response: ' + errText.substring(0, 200));
                return null;
            }
            var data = await resp.json();
            if (!data || data.error) {
                console.warn('[TASE] Error for id=' + id + ': ' + (data && data.error || 'empty response'));
                return null;
            }

            if (data.source === 'tase-security') {
                // Stock: price is in agorot, convert to ILS
                return {
                    price: data.price != null ? data.price / 100 : null,
                    previousClose: null,
                    change: null,
                    changePercent: null,
                    currency: 'ILS',
                    name: data.name || id,
                };
            } else if (data.source === 'tase-fund') {
                // Fund: UnitValuePrice is in agorot, convert to ILS
                return {
                    price: data.price != null ? data.price / 100 : null,
                    previousClose: null,
                    change: null,
                    changePercent: data.dayYield != null ? data.dayYield : null,
                    currency: 'ILS',
                    name: data.name || id,
                };
            }
        } catch (e) {
            console.warn('[TASE] Fetch failed for id=' + id + ': ' + e.message);
        }
        return null;
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
