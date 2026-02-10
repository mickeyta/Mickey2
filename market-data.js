/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli fund
 * data from the TASE Maya API. Uses a CORS proxy for browser access.
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

    /**
     * Configure the service.
     * @param {Object} options
     * @param {number} [options.cacheTTL] - Cache duration in ms (default 5 min)
     * @param {string} [options.corsProxy] - CORS proxy URL prefix
     */
    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.corsProxy !== undefined) _corsProxy = options.corsProxy;
    }

    function _isIsraeliFund(symbol) {
        return /^\d{5,8}$/.test(symbol);
    }

    /**
     * Fetch a URL through the CORS proxy with retry logic.
     * Uses the allorigins /get endpoint which wraps the response in JSON.
     * @param {string} targetUrl
     * @param {number} [retries]
     * @returns {Promise<Object|null>} parsed JSON or null on failure
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
                // If proxy returns raw JSON (e.g. user configured a different proxy)
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
            var israeliFunds = stale.filter(_isIsraeliFund);
            var regularSymbols = stale.filter(function (s) { return !_isIsraeliFund(s); });

            var total = stale.length;
            var done = 0;

            function progress() {
                done++;
                if (onProgress) onProgress(done, total);
            }

            // Fetch all symbols sequentially to avoid rate limiting
            var fetched = {};

            for (var ri = 0; ri < regularSymbols.length; ri++) {
                var sym = regularSymbols[ri];
                var quote = await _fetchYahooSingle(sym);
                if (quote) fetched[sym] = quote;
                progress();
            }

            for (var fi = 0; fi < israeliFunds.length; fi++) {
                var fid = israeliFunds[fi];
                var fquote = await _fetchTASESingle(fid);
                if (fquote) fetched[fid] = fquote;
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

    /**
     * Fetch a single stock quote from Yahoo Finance v8 chart API.
     */
    async function _fetchYahooSingle(sym) {
        var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(sym) + '?range=1d&interval=1d';

        var json = await _proxiedFetch(targetUrl);
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
     * Fetch a single Israeli fund quote from TASE Maya API.
     */
    async function _fetchTASESingle(id) {
        var targetUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(id);

        var data = await _proxiedFetch(targetUrl);
        if (!data || data.UnitValuePrice == null) return null;

        var priceILS = data.UnitValuePrice / 100;
        return {
            price: priceILS,
            previousClose: null,
            change: null,
            changePercent: data.DayYield != null ? data.DayYield : null,
            currency: 'ILS',
            name: data.FundLongName || data.FundShortName || id,
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
