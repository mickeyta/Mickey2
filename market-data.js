/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices and historical data from Twelve Data API.
 * Caches results to minimize API calls.
 *
 * Setup:
 *   1. Get a free API key at https://twelvedata.com/pricing (takes 10 seconds)
 *   2. Enter the key in the app's API Key field, or call:
 *      MarketData.configure({ apiKey: 'YOUR_KEY' });
 *
 * Usage:
 *   const quotes = await MarketData.fetchQuotes(['AAPL', 'MSFT']);
 *   console.log(quotes.AAPL.price); // 276.21
 *
 *   await MarketData.fetchHistorical(['AAPL']);
 *   console.log(MarketData.getHistorical('AAPL'));
 *   // { ytdPrice: 273.08, oneYearAgoPrice: 227.63 }
 */
const MarketData = (function () {
    'use strict';

    var STORAGE_KEY = 'marketDataApiKey';
    var API_BASE = 'https://api.twelvedata.com';
    var _cache = {};
    var _historicalCache = {};
    var _cacheTTL = 5 * 60 * 1000; // 5 minutes
    var _historicalCacheTTL = 60 * 60 * 1000; // 1 hour (historical data rarely changes)
    var _apiKey = localStorage.getItem(STORAGE_KEY) || '';
    var _exchangeMap = {}; // Cache resolved exchanges for ambiguous symbols
    var US_EXCHANGES = ['NYSE', 'NASDAQ', 'TSX'];

    /**
     * Configure the service.
     * @param {Object} options
     * @param {string} [options.apiKey] - Twelve Data API key (persisted to localStorage)
     * @param {number} [options.cacheTTL] - Cache duration in ms (default 5 min)
     */
    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.apiKey !== undefined) {
            _apiKey = options.apiKey;
            localStorage.setItem(STORAGE_KEY, _apiKey);
        }
    }

    /** @returns {string} The current API key */
    function getApiKey() {
        return _apiKey;
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * @param {string[]} symbols
     * @returns {Promise<Object.<string, QuoteData|null>>}
     */
    async function fetchQuotes(symbols) {
        if (!symbols || symbols.length === 0) return {};
        if (!_apiKey) throw new Error('API key not set');

        var now = Date.now();
        var upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            var fetched = await _fetchFromTwelveData(stale);
            var ts = Date.now();
            for (var sym in fetched) {
                _cache[sym] = Object.assign({}, fetched[sym], { _ts: ts });
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
     * Fetch historical reference prices (YTD start and 1-year ago) for the given symbols.
     * @param {string[]} symbols
     * @returns {Promise<Object.<string, HistoricalData|null>>}
     */
    async function fetchHistorical(symbols) {
        if (!symbols || symbols.length === 0) return {};
        if (!_apiKey) throw new Error('API key not set');

        var now = Date.now();
        var upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_historicalCache[s] || (now - _historicalCache[s]._ts > _historicalCacheTTL);
        });

        if (stale.length > 0) {
            var today = new Date();
            var year = today.getFullYear();

            // Last trading day of previous year: Dec 26-31
            var ytdStart = (year - 1) + '-12-26';
            var ytdEnd = (year - 1) + '-12-31';

            // ~365 days ago: look in a 7-day window
            var oneYearAgo = new Date(today);
            oneYearAgo.setDate(oneYearAgo.getDate() - 365);
            var oyaStart = _dateStr(new Date(oneYearAgo.getTime() - 4 * 86400000));
            var oyaEnd = _dateStr(new Date(oneYearAgo.getTime() + 3 * 86400000));

            var ts = Date.now();
            for (var idx = 0; idx < stale.length; idx++) {
                var symbol = stale[idx];
                try {
                    var ytdPrice = await _fetchTimeSeries(symbol, ytdStart, ytdEnd);
                    var oyaPrice = await _fetchTimeSeries(symbol, oyaStart, oyaEnd);
                    _historicalCache[symbol] = {
                        ytdPrice: ytdPrice,
                        oneYearAgoPrice: oyaPrice,
                        _ts: ts,
                    };
                } catch (err) {
                    console.warn('Failed to fetch historical for ' + symbol + ':', err.message);
                }
            }
        }

        var result = {};
        for (var j = 0; j < upper.length; j++) {
            var s = upper[j];
            if (_historicalCache[s]) {
                result[s] = {
                    ytdPrice: _historicalCache[s].ytdPrice,
                    oneYearAgoPrice: _historicalCache[s].oneYearAgoPrice,
                };
            } else {
                result[s] = null;
            }
        }
        return result;
    }

    /**
     * Fetch the closing price from a date range using time_series endpoint.
     * Returns the most recent closing price in the range, or null.
     * @param {string} symbol
     * @param {string} startDate - YYYY-MM-DD
     * @param {string} endDate - YYYY-MM-DD
     * @returns {Promise<number|null>}
     */
    async function _fetchTimeSeries(symbol, startDate, endDate) {
        var resolved = _resolvedSymbol(symbol);
        var url = API_BASE + '/time_series?symbol=' + encodeURIComponent(resolved) +
            '&interval=1day&start_date=' + startDate + '&end_date=' + endDate +
            '&outputsize=1&apikey=' + encodeURIComponent(_apiKey);

        var json = await _apiCall(url);
        if (!json || json.code) return null;
        if (json.values && json.values.length > 0) {
            return parseFloat(json.values[0].close);
        }
        return null;
    }

    /** Format a Date as YYYY-MM-DD */
    function _dateStr(d) {
        var m = d.getMonth() + 1;
        var day = d.getDate();
        return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }

    /**
     * Resolve the API symbol string for a given ticker.
     * For ambiguous symbols (listed on multiple exchanges), tries US exchanges.
     * Results are cached so subsequent calls don't waste API requests.
     * @param {string} symbol - Plain ticker like "CAAP"
     * @returns {string} Resolved symbol like "CAAP:NYSE" or plain "CAAP"
     */
    function _resolvedSymbol(symbol) {
        return _exchangeMap[symbol] || symbol;
    }

    /** Wait for given milliseconds */
    function _sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Make a single API call with rate-limit retry.
     * If the API returns 429, waits and retries up to 2 times.
     * @param {string} url
     * @returns {Promise<Object|null>} Parsed JSON or null
     */
    async function _apiCall(url) {
        for (var attempt = 0; attempt < 3; attempt++) {
            var resp = await fetch(url);
            if (!resp.ok) return null;
            var json = await resp.json();
            if (json.code && json.code === 429) {
                // Rate limited - wait and retry
                await _sleep(attempt === 0 ? 8000 : 15000);
                continue;
            }
            return json;
        }
        return null;
    }

    /**
     * Try fetching a quote for a single symbol. If no data is returned,
     * retry with exchange suffixes (NYSE, NASDAQ, TSX).
     * @param {string} symbol
     * @returns {Promise<Object|null>} Parsed quote data or null
     */
    async function _fetchQuoteWithFallback(symbol) {
        // If we already resolved this symbol's exchange, use it directly
        var trySymbols = [_resolvedSymbol(symbol)];
        // Only add fallbacks if we haven't resolved the exchange yet
        if (!_exchangeMap[symbol]) {
            for (var i = 0; i < US_EXCHANGES.length; i++) {
                var suffixed = symbol + ':' + US_EXCHANGES[i];
                if (trySymbols.indexOf(suffixed) === -1) trySymbols.push(suffixed);
            }
        }

        for (var j = 0; j < trySymbols.length; j++) {
            var sym = trySymbols[j];
            var url = API_BASE + '/quote?symbol=' + encodeURIComponent(sym) + '&apikey=' + encodeURIComponent(_apiKey);
            try {
                var q = await _apiCall(url);
                if (!q) continue;
                if (q.code && q.code === 401) throw new Error(q.message || 'Invalid API key');
                if (q.code) continue;
                if (q.symbol && q.close) {
                    // Cache which exchange worked
                    _exchangeMap[symbol] = sym;
                    return {
                        price: parseFloat(q.close),
                        previousClose: q.previous_close ? parseFloat(q.previous_close) : null,
                        change: q.change ? parseFloat(q.change) : null,
                        changePercent: q.percent_change ? parseFloat(q.percent_change) : null,
                        currency: q.currency || 'USD',
                        name: q.name || q.symbol,
                    };
                }
            } catch (err) {
                if (err.message && err.message.indexOf('Invalid API key') !== -1) throw err;
                // Otherwise try next exchange
            }
        }
        return null;
    }

    /**
     * Fetch quotes from Twelve Data API.
     * Processes symbols sequentially to avoid hitting the 8 calls/min rate limit.
     * @param {string[]} symbols
     * @returns {Promise<Object>}
     */
    async function _fetchFromTwelveData(symbols) {
        var out = {};
        for (var i = 0; i < symbols.length; i++) {
            var symbol = symbols[i];
            try {
                var result = await _fetchQuoteWithFallback(symbol);
                if (result) out[symbol] = result;
            } catch (err) {
                console.warn('Failed to fetch ' + symbol + ':', err.message);
            }
        }
        return out;
    }

    /**
     * Get a previously cached quote without making a network request.
     * @param {string} symbol
     * @returns {QuoteData|null}
     */
    function getCached(symbol) {
        var c = _cache[symbol.toUpperCase()];
        if (!c) return null;
        var entry = Object.assign({}, c);
        delete entry._ts;
        return entry;
    }

    /**
     * Get cached historical data (YTD start price and 1Y ago price).
     * @param {string} symbol
     * @returns {{ ytdPrice: number|null, oneYearAgoPrice: number|null }|null}
     */
    function getHistorical(symbol) {
        var c = _historicalCache[symbol.toUpperCase()];
        if (!c) return null;
        return { ytdPrice: c.ytdPrice, oneYearAgoPrice: c.oneYearAgoPrice };
    }

    /** Clear all cached data. */
    function clearCache() {
        var k;
        for (k in _cache) {
            if (_cache.hasOwnProperty(k)) delete _cache[k];
        }
        for (k in _historicalCache) {
            if (_historicalCache.hasOwnProperty(k)) delete _historicalCache[k];
        }
        for (k in _exchangeMap) {
            if (_exchangeMap.hasOwnProperty(k)) delete _exchangeMap[k];
        }
    }

    return {
        configure: configure,
        getApiKey: getApiKey,
        fetchQuotes: fetchQuotes,
        fetchHistorical: fetchHistorical,
        getCached: getCached,
        getHistorical: getHistorical,
        clearCache: clearCache,
    };
})();
