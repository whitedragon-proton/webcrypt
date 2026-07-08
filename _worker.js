// Cloudflare Workers Path-Prefix Proxy - HOST FIX
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([^\/]+\.[^\/]+)(\/.*)?$/);

    if (!match) {
      if (url.pathname === '/') {
        return new Response('Usage: /example.com/path', { status: 200, headers: {'Content-Type': 'text/plain'} });
      }
      const referer = request.headers.get('Referer');
      if (referer) {
        try {
          const refUrl = new URL(referer);
          if (refUrl.origin === url.origin) {
            const refMatch = refUrl.pathname.match(/^\/([^\/]+\.[^\/]+)(\/.*)?$/);
            if (refMatch) {
              return Response.redirect(`${url.origin}/${refMatch[1]}${url.pathname}${url.search}`, 302);
            }
          }
        } catch {}
      }
      return new Response('Not found', { status: 404 });
    }

    const targetHost = match[1];
    const targetPath = match[2] || '/';
    let target;
    try {
      target = new URL(targetPath + url.search, `https://${targetHost}`);
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }

    let upstream;
    try {
      const init = { method: request.method };
      init.headers = {
        'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        'Accept': request.headers.get('Accept') || '*/*'
      };
      const cookie = request.headers.get('Cookie');
      if (cookie) init.headers['Cookie'] = cookie;
      if (['POST','PUT','PATCH'].includes(request.method)) {
        init.body = await request.arrayBuffer();
        init.headers['Content-Type'] = request.headers.get('Content-Type') || '*/*';
      }
      upstream = await fetch(target.href, init);
    } catch (err) {
      return new Response('Fetch failed: ' + err.message, { status: 502 });
    }

    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('text/html')) {
      const h = new Headers(upstream.headers);
      h.delete('content-encoding'); h.delete('content-length'); h.delete('set-cookie');
      const resp = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
      // Add cookies back
      const raw = typeof upstreamHeaders.getSetCookie === 'function' ? upstreamHeaders.getSetCookie() : [upstreamHeaders.get('set-cookie')];
      raw.forEach(c => { if(c) { const r = c.replace(/;\s*Domain=[^;]/gi,'').replace(/;\s*Path=[^;]/gi,''); resp.headers.append('Set-Cookie', r); }});
      return resp;
    }

    let rewritten;
    try {
      const injector = new HTMLRewriter()
        .on('head', { element(el) { el.prepend(generateScript(url.origin, target.href), { html: true }); }})
        .on('link[href]', new UrlReplacer('href', target.href))
        .on('script[src]', new UrlReplacer('src', target.href))
        .on('img[src]', new UrlReplacer('src', target.href))
        .on('img[srcset]', new SrcReplacer(target.href))
        .on('source[src]', new UrlReplacer('src', target.href))
        .on('source[srcset]', new SrcReplacer(target.href));
      rewritten = injector.transform(upstream);
    } catch { return upstream; }

    return new Response(rewritten.body, {
      status: upstream.status,
      headers: { 'Content-Type': ct, 'Cache-Control': 'no-cache' }
    });
  }
};

function UrlReplacer(attr, baseUrl) {
  this.attr = attr; this.baseUrl = baseUrl;
  this.element = function(el) {
    const val = el.getAttribute(this.attr);
    if (!val || /^(javascript|data|mailto|tel|#):/i.test(val)) return;
    try { el.setAttribute(this.attr, new URL(val, this.baseUrl).href); } catch {}
  };
}

function SrcReplacer(baseUrl) {
  this.baseUrl = baseUrl;
  this.element = function(el) {
    const val = el.getAttribute('srcset');
    if (!val) return;
    const w = val.split(',').map(p => {
      const t = p.trim(), i = t.indexOf(' ');
      const u = i === -1 ? t : t.slice(0, i);
      const d = i === -1 ? '' : t.slice(i);
      try { return new URL(u, baseUrl).href + d; } catch { return p; }
    }).join(', ');
    el.setAttribute('srcset', w);
  };
}

function generateScript(origin, currentTarget) {
  // EXTRACT THE HOST FROM currentTarget - THIS IS CRITICAL
  let actualHost = 'github.com';
  try {
    actualHost = new URL(currentTarget).hostname;
  } catch {}

  return `<script>
    (function() {
      const PROXY = ${JSON.stringify(origin)};
      const HOST = ${JSON.stringify(actualHost)}; // STORED HOST - NEVER CHANGE
      const INITIAL = ${JSON.stringify(currentTarget)};
      
      // VIRTUAL HREF ALWAYS includes the stored HOST
      let virtualHref = INITIAL;
      
      function toProxied(u) {
        // u must have a hostname - use HOST as backup
        const h = u.hostname || HOST;
        return PROXY + '/' + h + u.pathname + u.search + u.hash;
      }
      
      function resolve(href) {
        if (!href) return null;
        if (/^(javascript|mailto|tel|#|data|blob):/i.test(href)) return null;
        
        // Already proxied - extract virtual URL
        if (href.indexOf(PROXY + '/') === 0) {
          const m = href.substring(PROXY.length).match(/^\/([^\/]+)(.*)/);
          if (m && m[1]) {
            try { return new URL(m[2] || '/', 'https://' + m[1]); } catch {}
          }
          return null;
        }
        
        // Absolute path starting with / - ALWAYS prepend stored HOST
        if (href.charAt(0) === '/') {
          try { return new URL(HOST + href, 'https://' + HOST); } catch { return null; }
        }
        
        // Relative or absolute - resolve against virtual location
        try {
          const r = new URL(href, virtualHref);
          // FORCE HOST if different
          if (r.hostname !== HOST) {
            try {
              const forced = new URL(r.pathname + r.search + r.hash, 'https://' + HOST);
              return forced;
            } catch {}
          }
          return r;
        } catch { return null; }
      }
      
      function findLink(e) {
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const n of path) {
          if (n && n.nodeType === 1 && n.tagName === 'A' && n.hasAttribute('href')) return n;
        }
        return null;
      }
      
      // NAV LOCK TO PREVENT RACE CONDITIONS
      let locked = false;
      
      function nav(url) {
        if (locked) return;
        locked = true;
        setTimeout(() => locked = false, 500);
        window.location.href = url;
      }
      
      // 1) CLICK INTERCEPTION
      document.addEventListener('click', function(e) {
        if (locked) { e.stopImmediatePropagation(); return; }
        const link = findLink(e);
        if (!link || !link.hasAttribute('href')) return;
        
        const href = link.getAttribute('href');
        const resolved = resolve(href);
        if (!resolved) return;
        
        // UPDATE VIRTUAL HREF NOW
        virtualHref = resolved.href;
        
        const proxied = toProxied(resolved);
        
        // STOP EVERYTHING BEFORE NAVIGATING
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        
        nav(proxied);
      }, true);
      
      // 2) MIDDLE CLICK
      document.addEventListener('auxclick', function(e) {
        if (e.button !== 1) return;
        const link = findLink(e);
        if (!link) return;
        const resolved = resolve(link.getAttribute('href'));
        if (!resolved) return;
        virtualHref = resolved.href;
        const proxied = toProxied(resolved);
        e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
        window.open(proxied, '_blank');
      }, true);
      
      // 3) FORM SUBMIT
      document.addEventListener('submit', function(e) {
        const form = findLink(e) || (function(){ const p=e.composedPath?e.composedPath():[]; for(const n of p){if(n&&n.tagName==='FORM')return n;}return null;})();
        if (!form) return;
        const method = (form.method || 'GET').toUpperCase();
        if (method !== 'GET') return;
        let action = form.action || virtualHref;
        const resolved = resolve(action.replace(window.location.origin,''));
        if (!resolved) return;
        const params = new URLSearchParams(new FormData(form)).toString();
        resolved.search = '?' + params;
        virtualHref = resolved.href;
        const proxied = toProxied(resolved);
        e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
        nav(proxied);
      }, true);
      
      // 4) HISTORY API - KEEP VIRTUAL HREF SYNCHRONIZED
      const push = history.pushState.bind(history);
      const rep = history.replaceState.bind(history);
      
      history.pushState = function(s,t,h) {
        const r = push(s,t,h);
        if (h) { const res = resolve(h); if (res) virtualHref = res.href; }
        return r;
      };
      history.replaceState = function(s,t,h) {
        const r = rep(s,t,h);
        if (h) { const res = resolve(h); if (res) virtualHref = res.href; }
        return r;
      };
      
      // 5) POPSTATE
      window.addEventListener('popstate', function() {
        const m = location.pathname.match(/^\/([^\/]+\.[^\/]+)(.*)/);
        if (m && m[1]) {
          try { virtualHref = 'https://' + m[1] + m[2]; } catch {}
        }
      });
      
      // 6) PERIODIC CHECK - ENSURE WE'RE STILL IN PROXY
      setInterval(function() {
        const m = location.pathname.match(/^\/([^\/]+\.[^\/]+)(.*)/);
        if (m && m[1]) {
          const expected = 'https://' + m[1];
          if (virtualHref.indexOf(expected) !== 0) {
            virtualHref = expected + (location.search || '') + (location.hash || '');
          }
        } else {
          // WE ESCAPED - REDIRECT BACK
          if (location.hostname !== new URL(PROXY).hostname) {
            // Outside our proxy entirely
          } else {
            // Our proxy but bad path - try to recover
            console.log('[PROXY] Path missing host prefix!', location.pathname);
          }
        }
      }, 150);
      
      // 7) FETCH / XHR
      const origFetch = window.fetch;
      window.fetch = function(inp, init) {
        const h = typeof inp === 'string' ? inp : (inp && inp.url);
        const res = resolve(h);
        if (res) { inp = toProxied(res); }
        return origFetch(inp, init);
      };
      
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(m,h) {
        const res = resolve(h);
        if (res) h = toProxied(res);
        return origOpen.apply(this, [m, h, ...Array.from(arguments).slice(2)]);
      };
      
      console.log('[PROXY] Ready - Host:', HOST, 'Virtual:', virtualHref);
    })();
  </script>`;
}
