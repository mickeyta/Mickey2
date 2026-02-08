/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices and historical data from Twelve Data API
 * (US/international stocks) and TASE API (Israeli stocks by security number).
 * Caches results to minimize API calls. Persists exchange resolutions
 * to localStorage so subsequent page loads need fewer API calls.
 *
 * Setup:
 *   1. Get a free API key at https://twelvedata.com/pricing (takes 10 seconds)
 *   2. Enter the key in the app's API Key field, or call:
 *      MarketData.configure({ apiKey: 'YOUR_KEY' });
 *   Note: Israeli stocks (numeric TASE security numbers) work without an API key.
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
    var EXCHANGE_MAP_KEY = 'marketDataExchangeMap';
    var HISTORICAL_CACHE_KEY = 'marketDataHistorical';
    var FOREX_CACHE_KEY = 'marketDataForex';
    var API_BASE = 'https://api.twelvedata.com';
    var TASE_API_BASE = 'https://api.tase.co.il/api/';
    var TASE_PROXIES = [
        { prefix: 'https://corsproxy.io/?url=', encode: true },
        { prefix: 'https://api.codetabs.com/v1/proxy/?quest=', encode: true },
    ];
    var _cache = {};
    var _historicalCache = _loadHistoricalCache();
    var _forexCache = _loadForexCache();
    var _cacheTTL = 5 * 60 * 1000; // 5 minutes
    var _historicalCacheTTL = 24 * 60 * 60 * 1000; // 24 hours (historical reference prices are fixed)
    var _forexCacheTTL = 60 * 60 * 1000; // 1 hour for current forex rate
    var _apiKey = localStorage.getItem(STORAGE_KEY) || '';
    var _exchangeMap = _loadExchangeMap();
    var EXCHANGES = ['NYSE', 'NASDAQ', 'TSX'];
    var _onProgress = null;

    // Proactive rate limiting to avoid 429s
    var _callTimestamps = [];
    var MAX_CALLS_PER_MINUTE = 8; // match the free-tier limit exactly

    /** Check if a symbol is a TASE security number (all digits). */
    function _isTaseNumber(symbol) {
        return /^\d+$/.test(symbol);
    }

    /** Load persisted exchange map from localStorage */
    function _loadExchangeMap() {
        try {
            var saved = localStorage.getItem(EXCHANGE_MAP_KEY);
            return saved ? JSON.parse(saved) : {};
        } catch (e) { return {}; }
    }

    /** Save exchange map to localStorage */
    function _saveExchangeMap() {
        try {
            localStorage.setItem(EXCHANGE_MAP_KEY, JSON.stringify(_exchangeMap));
        } catch (e) { /* ignore quota errors */ }
    }

    /** Load persisted historical cache from localStorage */
    function _loadHistoricalCache() {
        try {
            var saved = localStorage.getItem(HISTORICAL_CACHE_KEY);
            return saved ? JSON.parse(saved) : {};
        } catch (e) { return {}; }
    }

    /** Save historical cache to localStorage */
    function _saveHistoricalCache() {
        try {
            localStorage.setItem(HISTORICAL_CACHE_KEY, JSON.stringify(_historicalCache));
        } catch (e) { /* ignore quota errors */ }
    }

    /** Load persisted forex cache from localStorage */
    function _loadForexCache() {
        try {
            var saved = localStorage.getItem(FOREX_CACHE_KEY);
            return saved ? JSON.parse(saved) : {};
        } catch (e) { return {}; }
    }

    /** Save forex cache to localStorage */
    function _saveForexCache() {
        try {
            localStorage.setItem(FOREX_CACHE_KEY, JSON.stringify(_forexCache));
        } catch (e) { /* ignore quota errors */ }
    }

    /**
     * Configure the service.
     * @param {Object} options
     * @param {string} [options.apiKey] - Twelve Data API key (persisted to localStorage)
     * @param {number} [options.cacheTTL] - Cache duration in ms (default 5 min)
     * @param {Function} [options.onProgress] - Callback(symbol, type) called after each symbol is fetched
     */
    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.apiKey !== undefined) {
            _apiKey = options.apiKey;
            localStorage.setItem(STORAGE_KEY, _apiKey);
        }
        if (options.onProgress !== undefined) _onProgress = options.onProgress;
    }

    /** @returns {string} The current API key */
    function getApiKey() {
        return _apiKey;
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * TASE security numbers (numeric) are fetched from the TASE API (no API key needed).
     * Other symbols are fetched from Twelve Data (requires API key).
     * @param {string[]} symbols
     * @returns {Promise<Object.<string, QuoteData|null>>}
     */
    async function fetchQuotes(symbols) {
        if (!symbols || symbols.length === 0) return {};

        var now = Date.now();
        var upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            // Check if non-TASE symbols need an API key
            var hasNonTase = stale.some(function (s) { return !_isTaseNumber(s); });
            if (hasNonTase && !_apiKey) throw new Error('API key not set');

            await _fetchAllQuotes(stale);
            // Mark any symbols that weren't fetched as null
            var ts = Date.now();
            for (var i = 0; i < stale.length; i++) {
                if (!_cache[stale[i]]) {
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

        // Only require API key if there are non-TASE symbols
        var hasNonTase = symbols.some(function (s) { return !_isTaseNumber(s.toUpperCase()); });
        if (hasNonTase && !_apiKey) throw new Error('API key not set');

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
                    _saveHistoricalCache();
                    if (_onProgress) _onProgress(symbol, 'historical', idx + 1, stale.length);
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
     * Fetch the closing price from a date range.
     * Routes to TASE API for numeric symbols, Twelve Data for others.
     */
    async function _fetchTimeSeries(symbol, startDate, endDate) {
        // TASE historical is pre-populated from the quote's AnnualYield
        if (_isTaseNumber(symbol)) return null;
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

    // ---- TASE API functions (Israeli stocks) ----
    // TASE API requires Referer: https://www.tase.co.il/ which browsers can't set
    // cross-origin, so we route through a CORS proxy for the GET endpoint.
    // Historical prices are derived from AnnualYield in the quote response.

    /**
     * Fetch a URL through CORS proxies, trying each in order until one succeeds.
     * Returns the parsed JSON response or null if all fail.
     */
    async function _fetchViaProxy(targetUrl) {
        for (var i = 0; i < TASE_PROXIES.length; i++) {
            var proxy = TASE_PROXIES[i];
            var url = proxy.prefix + (proxy.encode ? encodeURIComponent(targetUrl) : targetUrl);
            try {
                var resp = await fetch(url);
                if (!resp.ok) continue;
                var text = await resp.text();
                // Some proxies return error pages as HTML
                if (text.charAt(0) !== '{' && text.charAt(0) !== '[') continue;
                return JSON.parse(text);
            } catch (err) {
                console.warn('Proxy ' + (i + 1) + ' failed for TASE:', err.message);
            }
        }
        return null;
    }

    /**
     * Fetch a quote for a TASE security number via CORS proxy.
     * Prices are in Agorot (1/100 ILS), converted to ILS here.
     * Also pre-populates the historical cache from AnnualYield data.
     */
    async function _fetchTaseQuote(symbol) {
        var taseUrl = TASE_API_BASE + 'company/securitydata?securityId=' +
            encodeURIComponent(symbol) + '&lang=1';
        try {
            var data = await _fetchViaProxy(taseUrl);
            if (!data || !data.LastRate) return null;
            var price = data.LastRate / 100;

            // Pre-populate historical cache from yield data
            var oneYearAgoPrice = (data.AnnualYield != null && data.AnnualYield !== 0)
                ? price / (1 + data.AnnualYield / 100) : null;
            _historicalCache[symbol] = {
                ytdPrice: null,
                oneYearAgoPrice: oneYearAgoPrice,
                _ts: Date.now(),
            };
            _saveHistoricalCache();

            return {
                price: price,
                previousClose: data.BaseRate ? data.BaseRate / 100 : null,
                change: data.BaseRate ? (data.LastRate - data.BaseRate) / 100 : null,
                changePercent: data.Change || null,
                currency: 'ILS',
                name: data.SecurityLongName || data.CompanyName || data.Name || symbol,
            };
        } catch (err) {
            console.warn('TASE API error for ' + symbol + ':', err.message);
            return null;
        }
    }

    // ---- End TASE API functions ----

    /** Format a Date as YYYY-MM-DD */
    function _dateStr(d) {
        var m = d.getMonth() + 1;
        var day = d.getDate();
        return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }

    /** Resolve the API symbol string for a given ticker using cached exchange info. */
    function _resolvedSymbol(symbol) {
        return _exchangeMap[symbol] || symbol;
    }

    /** Wait for given milliseconds */
    function _sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Make a single Twelve Data API call with proactive rate limiting and 429 retry.
     * Proactively waits if we're approaching the per-minute call limit.
     */
    async function _apiCall(url) {
        // Proactive rate limiting: wait if we'd exceed the limit
        var now = Date.now();
        _callTimestamps = _callTimestamps.filter(function (t) { return now - t < 60000; });
        if (_callTimestamps.length >= MAX_CALLS_PER_MINUTE) {
            var waitTime = 60000 - (now - _callTimestamps[0]) + 200;
            if (waitTime > 0) await _sleep(waitTime);
        }
        _callTimestamps.push(Date.now());

        for (var attempt = 0; attempt < 3; attempt++) {
            var resp = await fetch(url);
            if (!resp.ok) return null;
            var json = await resp.json();
            if (json.code && json.code === 429) {
                // Rate limited despite our proactive throttling - wait briefly and retry
                await _sleep(attempt === 0 ? 3000 : 6000);
                continue;
            }
            return json;
        }
        return null;
    }

    /**
     * Try fetching a quote for a single symbol. If no data is returned,
     * retry with exchange suffixes (NYSE, NASDAQ, TSX).
     * TASE security numbers are routed to the TASE API directly.
     */
    async function _fetchQuoteWithFallback(symbol) {
        // Route TASE security numbers to the TASE API
        if (_isTaseNumber(symbol)) {
            return _fetchTaseQuote(symbol);
        }

        // If we already resolved this symbol's exchange, use it directly
        var trySymbols = [_resolvedSymbol(symbol)];
        // Only add fallbacks if we haven't resolved the exchange yet
        if (!_exchangeMap[symbol]) {
            for (var i = 0; i < EXCHANGES.length; i++) {
                var suffixed = symbol + ':' + EXCHANGES[i];
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
                    // Cache which exchange worked and persist it
                    _exchangeMap[symbol] = sym;
                    _saveExchangeMap();
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
     * Fetch quotes for all symbols. Routes TASE and non-TASE symbols appropriately.
     * Updates cache and calls onProgress after each symbol for incremental rendering.
     */
    async function _fetchAllQuotes(symbols) {
        var out = {};
        for (var i = 0; i < symbols.length; i++) {
            var symbol = symbols[i];
            try {
                var result = await _fetchQuoteWithFallback(symbol);
                if (result) {
                    out[symbol] = result;
                    // Update cache immediately for incremental rendering
                    _cache[symbol] = Object.assign({}, result, { _ts: Date.now() });
                    if (_onProgress) _onProgress(symbol, 'quote');
                }
            } catch (err) {
                console.warn('Failed to fetch ' + symbol + ':', err.message);
            }
        }
        return out;
    }

    /**
     * Fetch USD/ILS exchange rates: current, YTD start, and 1-year ago.
     * Uses the same date windows as fetchHistorical for consistency.
     * @returns {Promise<{current: number|null, ytdStart: number|null, oneYearAgo: number|null}>}
     */
    async function fetchForexRates() {
        if (!_apiKey) throw new Error('API key not set');

        var now = Date.now();
        var needCurrent = !_forexCache.current || (now - _forexCache.current._ts > _forexCacheTTL);
        var needHistorical = !_forexCache.ytdStart || (now - (_forexCache.ytdStart._ts || 0) > _historicalCacheTTL);

        if (needCurrent) {
            var url = API_BASE + '/quote?symbol=USD/ILS&apikey=' + encodeURIComponent(_apiKey);
            var q = await _apiCall(url);
            if (q && !q.code && q.close) {
                _forexCache.current = { rate: parseFloat(q.close), _ts: Date.now() };
                _saveForexCache();
            }
            if (_onProgress) _onProgress('USD/ILS', 'forex');
        }

        if (needHistorical) {
            var today = new Date();
            var year = today.getFullYear();
            var ytdStart = (year - 1) + '-12-26';
            var ytdEnd = (year - 1) + '-12-31';
            var oneYearAgo = new Date(today);
            oneYearAgo.setDate(oneYearAgo.getDate() - 365);
            var oyaStart = _dateStr(new Date(oneYearAgo.getTime() - 4 * 86400000));
            var oyaEnd = _dateStr(new Date(oneYearAgo.getTime() + 3 * 86400000));

            var ytdRate = await _fetchForexTimeSeries(ytdStart, ytdEnd);
            var oyaRate = await _fetchForexTimeSeries(oyaStart, oyaEnd);
            var ts = Date.now();
            if (ytdRate != null) {
                _forexCache.ytdStart = { rate: ytdRate, _ts: ts };
            }
            if (oyaRate != null) {
                _forexCache.oneYearAgo = { rate: oyaRate, _ts: ts };
            }
            _saveForexCache();
            if (_onProgress) _onProgress('USD/ILS', 'forex');
        }

        return getForexRates();
    }

    /**
     * Fetch USD/ILS closing rate for a date range.
     * @param {string} startDate - YYYY-MM-DD
     * @param {string} endDate - YYYY-MM-DD
     * @returns {Promise<number|null>}
     */
    async function _fetchForexTimeSeries(startDate, endDate) {
        var url = API_BASE + '/time_series?symbol=USD/ILS&interval=1day&start_date=' +
            startDate + '&end_date=' + endDate +
            '&outputsize=1&apikey=' + encodeURIComponent(_apiKey);
        var json = await _apiCall(url);
        if (!json || json.code) return null;
        if (json.values && json.values.length > 0) {
            return parseFloat(json.values[0].close);
        }
        return null;
    }

    /**
     * Get cached forex rates (USD/ILS) without making network requests.
     * @returns {{current: number|null, ytdStart: number|null, oneYearAgo: number|null}}
     */
    function getForexRates() {
        return {
            current: _forexCache.current ? _forexCache.current.rate : null,
            ytdStart: _forexCache.ytdStart ? _forexCache.ytdStart.rate : null,
            oneYearAgo: _forexCache.oneYearAgo ? _forexCache.oneYearAgo.rate : null,
        };
    }

    /**
     * Get a previously cached quote without making a network request.
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
     */
    function getHistorical(symbol) {
        var c = _historicalCache[symbol.toUpperCase()];
        if (!c) return null;
        return { ytdPrice: c.ytdPrice, oneYearAgoPrice: c.oneYearAgoPrice };
    }

    /** Clear all cached data including persisted exchange map. */
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
        for (k in _forexCache) {
            if (_forexCache.hasOwnProperty(k)) delete _forexCache[k];
        }
        localStorage.removeItem(EXCHANGE_MAP_KEY);
        localStorage.removeItem(HISTORICAL_CACHE_KEY);
        localStorage.removeItem(FOREX_CACHE_KEY);
    }

    return {
        configure: configure,
        getApiKey: getApiKey,
        fetchQuotes: fetchQuotes,
        fetchHistorical: fetchHistorical,
        fetchForexRates: fetchForexRates,
        getCached: getCached,
        getHistorical: getHistorical,
        getForexRates: getForexRates,
        clearCache: clearCache,
    };
})();
