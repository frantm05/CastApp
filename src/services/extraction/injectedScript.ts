/**
 * Injected JavaScript for the WebView browser.
 *
 * Two scripts:
 * - EARLY_HOOKS_JS: Lightweight XHR/Fetch/body-inspection hooks, injected before content loads in ALL frames
 * - INJECTED_JS: Full extraction engine with DOM scanning, ad blocking, etc. — main frame only
 *
 * ESCAPING NOTE: These are template literal strings. For regex backslashes:
 *   Template literal source \\  →  String value \  →  JS regex engine sees \
 *   So \\. in source → \. in string → regex literal dot match ✓
 */

// ─── EARLY HOOKS (all frames, before content loaded) ───────────────────────
export const EARLY_HOOKS_JS = `
(function() {
  'use strict';
  if (window.__castapp_early) return;
  window.__castapp_early = true;

  var STREAM_PATTERN = /\\.(m3u8|mp4|mkv|mpd|ts)(\\?|$|#)/i;
  var PATH_HINTS = /\\/hls\\/|\\/dash\\/|master\\.m3u8|index\\.m3u8|playlist\\.m3u8|manifest\\.mpd|\\/video\\/|\\/stream\\//i;
  var BODY_PATTERN = /https?:\\/\\/[^"'\\\\s<>]+?\\.(m3u8|mp4|mpd)(\\?[^"'\\\\s<>]*)?/gi;
  var AD_DOMAINS = /doubleclick|googlesyndication|googleadservices|popads|popcash|adnxs|adsrv|propellerads|exoclick|juicyads|trafficjunky/i;
  var reported = {};

  function isStream(url) {
    return typeof url === 'string' && (STREAM_PATTERN.test(url) || PATH_HINTS.test(url));
  }

  function post(data) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(data);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __castapp: true, payload: data }, '*');
      }
    } catch(e) {}
  }

  function report(url, source) {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:\\/\\//i.test(url)) return;
    if (AD_DOMAINS.test(url)) return;
    var clean = url.split('#')[0];
    if (reported[clean]) return;
    reported[clean] = 1;
    post(JSON.stringify({ type: 'STREAM_FOUND', url: clean, source: source }));
  }

  function scanText(text, source) {
    if (!text || text.length > 2000000) return;
    var match;
    BODY_PATTERN.lastIndex = 0;
    while ((match = BODY_PATTERN.exec(text)) !== null) {
      report(match[0], source);
    }
  }

  // Patch XHR
  var xOpen = XMLHttpRequest.prototype.open;
  var xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__cu = url;
    if (isStream(url)) report(url, 'xhr');
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    this.addEventListener('load', function() {
      try {
        if (self.responseURL && isStream(self.responseURL)) report(self.responseURL, 'xhr-resp');
        var text = self.responseText;
        if (text) scanText(text, 'xhr-body');
      } catch(e) {}
    });
    return xSend.apply(this, arguments);
  };

  // Patch Fetch — clone response and inspect body
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (isStream(url)) report(url, 'fetch');
    return origFetch.apply(this, arguments).then(function(response) {
      try {
        if (response.url && isStream(response.url)) report(response.url, 'fetch-resp');
        var ct = response.headers && response.headers.get('content-type');
        if (ct && /mpegurl|mp4|dash|video\\//i.test(ct) && response.url) {
          report(response.url, 'fetch-ct');
        }
        if (ct && /json|text|javascript|html/i.test(ct)) {
          response.clone().text().then(function(body) {
            scanText(body, 'fetch-body');
          }).catch(function() {});
        }
      } catch(e) {}
      return response;
    });
  };

  // Listen for relayed messages from child iframes (main frame only)
  if (window === window.top) {
    window.addEventListener('message', function(ev) {
      try {
        if (ev.data && ev.data.__castapp && ev.data.payload) {
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(ev.data.payload);
          }
        }
      } catch(e) {}
    });
  }

  true;
})();
`;

// ─── FULL INJECTION (main frame only, after content loaded) ─────────────────
export const INJECTED_JS = `
(function() {
  'use strict';

  if (window.__castapp_injected) return;
  window.__castapp_injected = true;

  var TAG = '[CastApp Inject]';

  function postToRN(data) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(data);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __castapp: true, payload: data }, '*');
      }
    } catch(e) {}
  }

  var STREAM_URL_PATTERN = /\\.(m3u8|mp4|mkv|mpd|ts)(\\?|$|#)/i;
  var EMBEDDED_URL_PATTERN = /https?:\\/\\/[^"'\\\\s<>]+?\\.(m3u8|mp4|mpd)(\\?[^"'\\\\s<>]*)?/gi;
  var STREAM_CONTENT_TYPES = /mpegurl|mp4|dash\\+xml|octet-stream|video\\//i;
  var STREAM_PATH_HINTS = /\\/hls\\/|\\/dash\\/|master\\.m3u8|index\\.m3u8|playlist\\.m3u8|manifest\\.mpd|\\/video\\/|\\/stream\\//i;
  var AD_DOMAINS = /doubleclick\\.net|googlesyndication|googleadservices|adservice\\.google|popads\\.net|popcash\\.net|adnxs\\.com|adsrv|propellerads|exoclick|juicyads|trafficjunky|revcontent|taboola|outbrain|mgid\\.com|clickadu|hilltopads|pushhouse/i;

  var reportedUrls = new Set();
  var streamCount = 0;

  function reportStream(url, source) {
    if (!url || typeof url !== 'string') return;
    if (/^(blob:|data:|chrome-extension:)/i.test(url)) return;
    if (!/^https?:\\/\\//i.test(url)) return;
    if (AD_DOMAINS.test(url)) return;
    var cleanUrl = url.split('#')[0];
    if (reportedUrls.has(cleanUrl)) return;
    reportedUrls.add(cleanUrl);
    streamCount++;
    console.log(TAG + ' [' + streamCount + '] Stream via ' + (source || '?') + ':', cleanUrl);
    postToRN(JSON.stringify({ type: 'STREAM_FOUND', url: cleanUrl, source: source || 'unknown' }));
  }

  function isStreamUrl(url) {
    if (typeof url !== 'string') return false;
    return STREAM_URL_PATTERN.test(url) || STREAM_PATH_HINTS.test(url);
  }

  // =============================================
  // 1. Monitor <video>, <audio>, <source>, <iframe>
  //    (XHR/Fetch already hooked by EARLY_HOOKS_JS)
  // =============================================
  var reportedIframes = new Set();

  function checkMediaElements() {
    document.querySelectorAll('video, audio').forEach(function(el) {
      if (el.src && isStreamUrl(el.src)) reportStream(el.src, 'media-element');
      if (el.currentSrc && isStreamUrl(el.currentSrc)) reportStream(el.currentSrc, 'media-currentSrc');
      el.querySelectorAll('source').forEach(function(s) {
        if (s.src && isStreamUrl(s.src)) reportStream(s.src, 'source-element');
      });
    });
    document.querySelectorAll('iframe').forEach(function(iframe) {
      try {
        var src = iframe.src || iframe.getAttribute('data-src') || '';
        if (!src || src === 'about:blank' || /^javascript:/i.test(src)) return;
        if (reportedIframes.has(src)) return;
        if (isStreamUrl(src)) reportStream(src, 'iframe-src');
        if (!AD_DOMAINS.test(src) && /^https?:\\/\\//i.test(src)) {
          reportedIframes.add(src);
          postToRN(JSON.stringify({ type: 'IFRAME_FOUND', url: src, width: iframe.offsetWidth || 0, height: iframe.offsetHeight || 0 }));
        }
      } catch(e) {}
    });
  }

  setInterval(checkMediaElements, 2500);

  var domObserver = new MutationObserver(function(mutations) {
    var shouldCheck = false;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j];
        if (node.nodeType === 1) {
          var tag = node.tagName;
          if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE' || tag === 'IFRAME') { shouldCheck = true; break; }
          if (node.querySelector && node.querySelector('video, audio, source, iframe')) { shouldCheck = true; break; }
        }
      }
      if (!shouldCheck && m.type === 'attributes' && m.target && m.target.nodeType === 1) {
        var tt = m.target.tagName;
        if (tt === 'VIDEO' || tt === 'AUDIO' || tt === 'SOURCE') shouldCheck = true;
      }
      if (shouldCheck) break;
    }
    if (shouldCheck) setTimeout(checkMediaElements, 300);
  });
  domObserver.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'data-src', 'currentSrc']
  });

  // =============================================
  // 2. Intercept HTMLMediaElement.src setter
  // =============================================
  (function() {
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (desc && desc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          set: function(value) {
            if (typeof value === 'string' && isStreamUrl(value)) {
              console.log(TAG + ' MediaElement.src =', value);
              reportStream(value, 'media-src-setter');
            }
            return desc.set.call(this, value);
          },
          get: desc.get,
          configurable: true
        });
      }
    } catch(e) {
      console.log(TAG + ' Cannot override MediaElement.src:', e.message);
    }
  })();

  // =============================================
  // 3. Intercept URL.createObjectURL (HLS.js etc)
  // =============================================
  (function() {
    try {
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function(obj) {
        var blobUrl = origCreate.apply(this, arguments);
        if (obj && obj instanceof MediaSource) {
          console.log(TAG + ' MediaSource blob created');
          postToRN(JSON.stringify({ type: 'PLAYER_DETECTED', detail: 'MediaSource blob - HLS/DASH player active' }));
        }
        return blobUrl;
      };
    } catch(e) {}
  })();

  // =============================================
  // 4. Scrape inline scripts & data-attributes
  // =============================================
  function scrapePageForUrls() {
    try {
      document.querySelectorAll('script:not([src])').forEach(function(script) {
        var text = script.textContent || '';
        if (text.length > 1000000) return;
        var matches = text.match(EMBEDDED_URL_PATTERN);
        if (matches) { matches.forEach(function(m) { reportStream(m, 'inline-script'); }); }
      });
      var playerAttrs = ['data-src', 'data-url', 'data-video', 'data-stream', 'data-file', 'data-source'];
      playerAttrs.forEach(function(attr) {
        document.querySelectorAll('[' + attr + ']').forEach(function(el) {
          var val = el.getAttribute(attr);
          if (val && isStreamUrl(val)) reportStream(val, 'data-attr:' + attr);
        });
      });
    } catch(e) {
      console.log(TAG + ' Scrape error:', e.message);
    }
  }

  setTimeout(scrapePageForUrls, 3000);
  setTimeout(scrapePageForUrls, 8000);
  setInterval(scrapePageForUrls, 15000);

  // =============================================
  // 5. Block popups and window.open
  // =============================================
  window.open = function(url) {
    console.log(TAG + ' Blocked window.open:', url);
    postToRN(JSON.stringify({ type: 'AD_BLOCKED', detail: 'window.open: ' + (url || 'about:blank') }));
    return null;
  };

  // =============================================
  // 6. Remove ad overlays periodically
  // =============================================
  function removeAdOverlays() {
    var selectors = [
      'div[class*="popup"]', 'div[class*="overlay"]',
      'div[id*="popunder"]', 'div[class*="ad-"]',
      'div[id*="ad-overlay"]', 'iframe[src*="ads"]',
      'iframe[src*="popunder"]', 'div[class*="modal"][style*="z-index"]'
    ];
    var removed = 0;
    selectors.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) {
          var style = window.getComputedStyle(el);
          var zIndex = parseInt(style.zIndex) || 0;
          var isFixed = style.position === 'fixed' || style.position === 'absolute';
          var coversScreen = el.offsetWidth > window.innerWidth * 0.5 && el.offsetHeight > window.innerHeight * 0.5;
          if (isFixed && zIndex > 999 && coversScreen) {
            el.remove();
            removed++;
          }
        });
      } catch(e) {}
    });
    if (removed > 0) {
      postToRN(JSON.stringify({ type: 'AD_BLOCKED', detail: 'Removed ' + removed + ' overlay(s)' }));
    }
    try {
      if (document.body) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    } catch(e) {}
  }

  setInterval(removeAdOverlays, 3000);

  // =============================================
  // 7. Block ad scripts from loading
  // =============================================
  (function() {
    try {
      var origAppendChild = Element.prototype.appendChild;
      Element.prototype.appendChild = function(child) {
        if (child && child.tagName === 'SCRIPT' && child.src && AD_DOMAINS.test(child.src)) {
          postToRN(JSON.stringify({ type: 'AD_BLOCKED', detail: 'script: ' + child.src.substring(0, 100) }));
          return child;
        }
        return origAppendChild.call(this, child);
      };
    } catch(e) {}
  })();

  console.log(TAG + ' v3 ready. DOM + MediaElement + scripts + ad blocking active.');
  true;
})();
`;
