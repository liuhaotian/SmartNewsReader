/**
 * SmartNewsReader v10.7
 * - BASE: v10.5 Git Source
 * - UPDATE: KV Summary TTL extended to 14 days (1209600s).
 * - UPDATE: AI badge absolute-positioned in home view.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    let apiKey;
    try {
      apiKey = await env.GEMINI_API_KEY.get();
    } catch (e) {
      return new Response("Secret Error: GEMINI_API_KEY binding required.", { status: 500 });
    }

    if (path.startsWith('/image/')) return await this.handleImageProxy(url, request);
    if (path === "/" || path === "") return await this.handleUnifiedFeed(request);
    
    if (path.startsWith('/summary/')) return await this.handleSummary(path, request, apiKey, env, ctx);
    if (path.startsWith('/article/')) {
      return await this.handleArticle(path, request, apiKey, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  async handleUnifiedFeed(request) {
    const sources = [
      { name: "法广", url: "https://www.rfi.fr/cn/rss", color: "text-red-600", domain: "www.rfi.fr" },
      { name: "BBC", url: "https://feeds.bbci.co.uk/zhongwen/trad/rss.xml", color: "text-orange-700", domain: "feeds.bbci.co.uk" },
      { name: "亚广", url: "https://www.rfa.org/arc/outboundfeeds/mandarin/rss/", color: "text-orange-600", domain: "www.rfa.org" },
      { name: "大纪元", url: "https://feed.epochtimes.com/gb/feed", color: "text-blue-600", domain: "feed.epochtimes.com" },
      { name: "美国之音", url: "https://www.voachinese.com/api/zm_yql-vomx-tpeybti", color: "text-sky-800", domain: "www.voachinese.com" }
    ];

    const feedResults = await Promise.all(
      sources.map(async (src) => {
        try {
          const res = await fetch(src.url, { 
            headers: this.getStealthHeaders(request, src.domain),
            cf: { cacheTtl: 600 } 
          });
          return this.parseRSS(await res.text(), src);
        } catch (e) { return []; }
      })
    );

    const allNews = feedResults.flat().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return new Response(this.renderHome(allNews), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  },

  parseRSS(xml, source) {
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const newsItems = [];

    for (const item of items) {
      if (source.domain === "feed.epochtimes.com") {
        const isShenYun = /<category>(?:<!\[CDATA\[)?神韵(?:\]\]>)?<\/category>/i.test(item);
        if (isShenYun) continue;
      }

      const title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/))?.[1] || "No Title";
      let link = (item.match(/<link>([\s\S]*?)<\/link>/))?.[1] || "";
      const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1] || "";
      
      const mediaMatch = item.match(/<media:thumbnail[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<media:content[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<enclosure[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<img[^>]*src="([\s\S]*?)"/);
      
      let articlePath = "#";
      if (link) {
        try {
          const u = new URL(link.trim());
          if (u.hostname.includes("bbc.com") && u.pathname.endsWith("/trad")) {
            u.pathname = u.pathname.replace(/\/trad$/, '/simp');
          }
          articlePath = `/article/${u.hostname}${u.pathname}`;
        } catch(e) {}
      }
      newsItems.push({ 
        title, 
        link: articlePath, 
        image: mediaMatch ? `/image/${mediaMatch[1].replace(/^https?:\/\//, '')}` : "", 
        source: source.name, 
        color: source.color, 
        timestamp: pubDate ? new Date(pubDate).getTime() : 0 
      });
    }
    return newsItems;
  },

  async handleSummary(path, request, apiKey, env, ctx) {
    const targetUrl = `https://${path.replace('/summary/', '')}`;
    let debugInfo = { prompt: "", raw: "" };
    try {
      const data = await this._getArticleData(targetUrl, request, apiKey, env, ctx);
      return new Response(JSON.stringify(data.summary_points), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return this.renderDebugPage(e, debugInfo.prompt, debugInfo.raw);
    }
  },

  async handleArticle(path, request, apiKey, env, ctx) {
    const fullPath = path.replace('/article/', '');
    const targetUrl = `https://${fullPath}`;
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const hitRes = new Response(cachedResponse.body, cachedResponse);
      hitRes.headers.set("X-Cache-Status", "HIT");
      return hitRes;
    }

    let debugInfo = { prompt: "", raw: "" };
    try {
      const data = await this._getArticleData(targetUrl, request, apiKey, env, ctx);
      debugInfo = data.debug;

      const html = this.renderArticle({
        title: data.title,
        image_url: data.image ? `/image/${data.image.replace(/^https?:\/\//, '')}` : "",
        summary_points: data.summary_points,
        paragraphs: data.paragraphs
      });

      const finalRes = new Response(html, { 
        headers: { 
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "public, s-maxage=604800" 
        } 
      });

      ctx.waitUntil(cache.put(cacheKey, finalRes.clone()));
      return finalRes;
    } catch (err) {
      return this.renderDebugPage(err, debugInfo.prompt, debugInfo.raw);
    }
  },

  async _getArticleData(targetUrl, request, apiKey, env, ctx) {
    let pageTitle = "", socialImg = "", firstBodyImg = "", paragraphs = [];
    const res = await fetch(targetUrl, { headers: this.getStealthHeaders(request, new URL(targetUrl).hostname) });
    if (!res.ok) throw new Error(`Fetch Exception: HTTP ${res.status}`);

    await new HTMLRewriter()
      .on("title", { text(t) { pageTitle += t.text; } })
      .on("meta", { element(el) {
        const prop = el.getAttribute("property") || el.getAttribute("name");
        const content = el.getAttribute("content");
        if (content && (prop === "og:image" || prop === "twitter:image")) socialImg = content;
      }})
      .on("img", { element(el) {
        const src = el.getAttribute("src") || el.getAttribute("data-src");
        if (!firstBodyImg && src && !src.startsWith('data:')) firstBodyImg = src;
      }})
      .on("p", { text(t) { 
        const txt = t.text.trim();
        if (txt.length > 15) paragraphs.push(txt); 
      }})
      .transform(res).arrayBuffer();

    const cleanTitle = pageTitle.trim() || "News Article";
    const b64 = btoa(targetUrl);
    const kvKey = b64.substring(Math.max(0, b64.length - 64));

    let summaryPoints = [];
    let currentPrompt = "";
    let rawAIResponse = "";
    
    const cachedSum = await env.AI_SUMMARY.get(kvKey);

    if (cachedSum) {
      summaryPoints = JSON.parse(cachedSum);
    } else {
      currentPrompt = `[SYSTEM]: You are a news analyst.
[TASK]: Summarize text into 3-5 concise bullet points in Simplified Chinese (简体中文).
[STRICT FORMAT]: Return ONLY the bullet points, one per line. 
- Do NOT use JSON. Do NOT use markdown (no * or -).
- Do NOT use any introductory text. Just the summary lines.

[TITLE]: ${cleanTitle}
[DATA]: ${paragraphs.join("\n").substring(0, 35000)}`;

      rawAIResponse = await this.callAI(currentPrompt, apiKey);
      summaryPoints = rawAIResponse.split('\n')
        .map(l => l.replace(/^[•\-\*\d\.\s]+/, '').trim())
        .filter(l => l.length > 5);

      if (summaryPoints.length > 0) {
        // Updated to 14 days (1209600 seconds)
        ctx.waitUntil(env.AI_SUMMARY.put(kvKey, JSON.stringify(summaryPoints), { expirationTtl: 1209600 }));
      }
    }

    return { 
      title: cleanTitle, 
      paragraphs, 
      image: socialImg || firstBodyImg, 
      summary_points: summaryPoints,
      debug: { prompt: currentPrompt, raw: rawAIResponse }
    };
  },

  async callAI(prompt, apiKey) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemma-3-4b-it:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } })
    });
    const json = await res.json();
    return json.candidates[0].content.parts[0].text;
  },

  async handleImageProxy(workerUrl, request) {
    const targetPathWithQuery = workerUrl.pathname.replace('/image/', '') + workerUrl.search;
    const targetUrl = "https://" + targetPathWithQuery;
    try {
      const imgRes = await fetch(targetUrl, { headers: this.getStealthHeaders(request, new URL(targetUrl).hostname) });
      const newHeaders = new Headers(imgRes.headers);
      if (imgRes.status === 200) newHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
    } catch(e) { return new Response(null, { status: 404 }); }
  },

  getStealthHeaders(req, host) {
    const h = new Headers();
    const userUA = req.headers.get("User-Agent") || "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    h.set("Host", host);
    h.set("User-Agent", userUA);
    h.set("Referer", `https://${host}/`);
    h.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8");
    h.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-real-ip", "x-forwarded-for"].forEach(x => h.delete(x));
    return h;
  },

  timeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + "m前";
    if (diff < 84000) return Math.floor(diff / 3600) + "h前";
    return Math.floor(diff / 86400) + "d前";
  },

  renderHome(news) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <title>智能新闻</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      .is-read .card-header { opacity: 0.3; filter: grayscale(1); }
      .accordion-content { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; }
      .expanded .accordion-content { max-height: 600px; }
      .expanded .card-chevron { transform: rotate(180deg); }
      header { padding-top: env(safe-area-inset-top, 0px); }
    </style></head>
    <body class="bg-slate-50 min-h-screen font-sans">
    <header class="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b shadow-sm">
      <div class="flex justify-between items-center p-4">
        <h1 class="font-black text-xl text-slate-900 tracking-tighter uppercase">SmartNews</h1>
        <button onclick="if(confirm('Clear history?')){localStorage.clear();location.reload();}" class="text-[9px] font-bold text-slate-400 border px-2 py-1 rounded hover:bg-slate-50 uppercase">Reset</button>
      </div>
    </header>
    <main id="feed" class="max-w-md mx-auto divide-y bg-white">${news.map(i => `
      <div class="news-card border-b last:border-0" data-id="${btoa(i.link)}" data-url="${i.link}">
        <div class="flex gap-4 p-5 cursor-pointer hover:bg-slate-50 transition-all card-header">
          <div class="w-24 h-16 shrink-0 rounded overflow-hidden bg-slate-100">${i.image ? `<img src="${i.image}" class="w-full h-full object-cover">` : ''}</div>
          <div class="flex flex-col justify-between py-0.5 flex-grow">
            <h2 class="text-xs font-bold leading-snug text-slate-800 line-clamp-2">${i.title}</h2>
            <div class="flex items-center justify-between mt-2">
              <div class="flex items-center gap-2">
                <span class="text-[8px] font-black uppercase px-1.5 py-0.5 border rounded ${i.color}">${i.source}</span>
                <span class="text-[8px] text-slate-400 font-medium">${this.timeAgo(i.timestamp)}</span>
              </div>
              <svg class="w-3 h-3 text-slate-300 card-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M19 9l-7 7-7-7"></path></svg>
            </div>
          </div>
        </div>
        <div class="accordion-content">
          <a href="${i.link}" class="block bg-red-50 border-l-4 border-red-600 p-5 pt-4 pb-4 relative mb-4 mx-4 rounded-r-xl shadow-sm active:bg-red-100/50 transition-colors">
            <ul class="summary-target space-y-2 list-disc list-inside text-[13px] leading-relaxed text-red-900 font-medium pb-2">
              <div class="flex justify-center p-2"><div class="animate-pulse flex space-x-1"><div class="h-1 w-1 bg-red-300 rounded-full"></div><div class="h-1 w-1 bg-red-300 rounded-full"></div><div class="h-1 w-1 bg-red-300 rounded-full"></div></div></div>
            </ul>
            <div class="absolute bottom-1.5 right-2 opacity-30"><span class="text-[7px] font-black uppercase tracking-tighter text-red-900 italic">AI 总结</span></div>
          </a>
        </div>
      </div>`).join('')}</main>
    <script>
      const syncStatus = () => document.querySelectorAll('.news-card').forEach(c => localStorage.getItem('read_'+c.dataset.id) && c.classList.add('is-read'));
      syncStatus();
      window.addEventListener('pageshow', (e) => e.persisted && syncStatus());

      document.querySelectorAll('.card-header').forEach(header => {
        let readTimer;
        const startTimer = (card) => {
          clearTimeout(readTimer);
          readTimer = setTimeout(() => {
            if (card.classList.contains('expanded')) {
              localStorage.setItem('read_' + card.dataset.id, Date.now());
              card.classList.add('is-read');
            }
          }, 1000);
        };

        header.addEventListener('click', async () => {
          const card = header.closest('.news-card');
          const isExpanded = card.classList.toggle('expanded');
          const target = card.querySelector('.summary-target');
          const url = card.dataset.url;
          
          if (isExpanded) {
            if (card.dataset.loaded) {
              startTimer(card);
            } else {
              try {
                const res = await fetch('/summary/' + url.replace('/article/', ''));
                if (!res.ok) throw new Error();
                const points = await res.json();
                target.innerHTML = points.map(p => \`<li>\${p}</li>\`).join('');
                card.dataset.loaded = "true";
                startTimer(card);
              } catch(err) {
                target.innerHTML = \`<li class="list-none text-center p-2"><p class="text-[10px] text-slate-500 mb-1 font-bold uppercase">Summary failed</p><span class="text-xs text-blue-600 underline">Read full article</span></li>\`;
              }
            }
          } else {
            clearTimeout(readTimer);
          }
        });
      });
    </script></body></html>`;
  },

  renderArticle(data) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="https://cdn.tailwindcss.com"></script><style>body { padding-top: env(safe-area-inset-top, 0px); }</style></head>
    <body class="bg-white"><div class="max-w-xl mx-auto">${data.image_url ? `<img src="${data.image_url}" class="w-full aspect-video object-cover">` : ''}
    <div class="p-6"><h1 class="text-2xl font-black mb-6 leading-tight text-slate-900">${data.title}</h1>
    <div class="bg-red-50 border-l-4 border-red-600 p-5 mb-8 rounded-r-xl shadow-sm relative">
      <ul class="space-y-2 list-disc list-inside text-sm font-medium text-red-900 pb-2">${data.summary_points.map(p => `<li>${p}</li>`).join('')}</ul>
      <div class="absolute bottom-1.5 right-2 opacity-30"><span class="text-[7px] font-black uppercase tracking-tighter text-red-900 italic">AI 总结</span></div>
    </div>
    <div class="space-y-6 text-slate-800 leading-relaxed text-lg">${data.paragraphs.map(p => `<p>${p}</p>`).join('')}</div></div>
    <footer class="p-10 border-t mt-10 text-center"><a href="/" class="bg-black text-white px-10 py-4 rounded-full text-[10px] font-black tracking-widest uppercase shadow-lg hover:bg-slate-800 transition-colors">← Back to Feed</a></footer></div>
    <script>const articleId = btoa(window.location.pathname); setTimeout(() => localStorage.setItem('read_' + articleId, Date.now()), 1000);</script></body></html>`;
  },

  renderDebugPage(err, prompt, response) {
    const tw = "https://cdn.tailwindcss.com";
    const escape = (str) => str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="${tw}"></script></head>
    <body class="bg-slate-950 text-slate-300 p-6 font-mono text-[10px] whitespace-pre-wrap break-all">
      <div class="max-w-4xl mx-auto space-y-6">
        <h1 class="text-red-500 text-lg font-black uppercase italic tracking-tighter">EXCEPTION // ${err.message}</h1>
        <div class="space-y-2"><h2 class="text-blue-500 font-bold uppercase tracking-widest">[Original Prompt]</h2><div class="bg-slate-900 p-4 rounded border border-slate-800 select-all">${escape(prompt) || 'NONE (CACHED OR FETCH FAILED)'}</div></div>
        <div class="space-y-2"><h2 class="text-green-500 font-bold uppercase tracking-widest">[Raw AI Response]</h2><div class="bg-slate-900 p-4 rounded border border-slate-800 select-all">${escape(response) || 'NONE (CACHED OR FETCH FAILED)'}</div></div>
        <a href="/" class="inline-block bg-slate-800 text-white px-8 py-3 rounded-full font-black uppercase text-[10px] tracking-widest hover:bg-slate-700">Return</a>
      </div>
    </body></html>`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }
};
