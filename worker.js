/**
 * SmartNewsReader v5.2.2
 * Architecture: Hybrid (Deterministic + AI Synthesis)
 * Features: <enclosure> support, Data-Last prompting, Full Debug View
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    let apiKey;
    try {
      apiKey = await env.GEMINI_API_KEY.get();
    } catch (e) {
      return new Response("Secret Error: Bound GEMINI_API_KEY required.", { status: 500 });
    }

    if (path.startsWith('/image/')) return await this.handleImageProxy(path, request);
    if (path === "/" || path === "") return await this.handleUnifiedFeed(request);
    
    if (path.startsWith('/article/')) {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + path, { method: "GET" });
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;
      
      return await this.handleArticle(path, request, apiKey, cache, cacheKey, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  // --- RSS ENGINE ---
  async handleUnifiedFeed(request) {
    const sources = [
      { name: "RFI", url: "https://www.rfi.fr/cn/rss", color: "text-red-600", domain: "www.rfi.fr" },
      { name: "BBC", url: "https://feeds.bbci.co.uk/zhongwen/trad/rss.xml", color: "text-orange-700", domain: "feeds.bbci.co.uk" },
      { name: "大纪元", url: "https://feed.epochtimes.com/feed", color: "text-blue-600", domain: "feed.epochtimes.com" },
      { name: "VOA", url: "https://www.voachinese.com/api/zm_yql-vomx-tpeybti", color: "text-sky-800", domain: "www.voachinese.com" }
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
    return items.map(item => {
      const title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/))?.[1] || "No Title";
      const link = (item.match(/<link>([\s\S]*?)<\/link>/))?.[1] || "";
      const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1] || "";
      
      const mediaMatch = item.match(/<media:thumbnail[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<media:content[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<enclosure[^>]*url="([\s\S]*?)"/) || 
                         item.match(/<img[^>]*src="([\s\S]*?)"/);
      
      let articlePath = "#";
      if (link) {
        try {
          const u = new URL(link.trim());
          articlePath = `/article/${u.hostname}${u.pathname}${u.search}`;
        } catch(e) {}
      }
      return { 
        title, 
        link: articlePath, 
        image: mediaMatch ? `/image/${mediaMatch[1].replace(/^https?:\/\//, '')}` : "", 
        source: source.name, 
        color: source.color, 
        timestamp: pubDate ? new Date(pubDate).getTime() : 0 
      };
    });
  },

  // --- HYBRID ARTICLE ENGINE ---
  async handleArticle(path, request, apiKey, cache, cacheKey, ctx) {
    const fullPath = path.replace('/article/', '');
    const targetUrl = `https://${fullPath}`;
    
    let pageTitle = "";
    let socialImg = "";
    let firstBodyImg = "";
    let paragraphs = [];
    let currentPrompt = "";
    let rawAIResponse = "";

    const resolveUrl = (src) => {
      try { return new URL(src, targetUrl).href.replace(/^http:/, 'https:'); } catch (e) { return null; }
    };

    try {
      const res = await fetch(targetUrl, { headers: this.getStealthHeaders(request, fullPath.split('/')[0]) });
      
      await new HTMLRewriter()
        .on("title", { text(t) { pageTitle += t.text; } })
        .on("meta", { element(el) {
          const prop = el.getAttribute("property") || el.getAttribute("name");
          const content = el.getAttribute("content");
          if (content && (prop === "og:image" || prop === "twitter:image")) socialImg = resolveUrl(content);
        }})
        .on("img", { element(el) {
          const src = el.getAttribute("src") || el.getAttribute("data-src");
          if (!firstBodyImg && src && !src.startsWith('data:')) firstBodyImg = resolveUrl(src);
        }})
        .on("p", { text(t) { 
          const txt = t.text.trim();
          if (txt.length > 15) paragraphs.push(txt); 
        }})
        .transform(res).arrayBuffer();

      const finalImg = socialImg || firstBodyImg;
      const cleanTitle = pageTitle.trim() || "News Article";

      // AI Strategy: Data-Last
      currentPrompt = `[SYSTEM]: You are a news analyst. Summarize the text provided below into 3-5 concise bullet points in Chinese. 
FORMAT: Return RAW JSON only: {"summary": ["point 1", "point 2"]}

[TITLE]: ${cleanTitle}

[DATA_BLOCK]:
${paragraphs.join("\n").substring(0, 15000)}`;

      rawAIResponse = await this.callAI(currentPrompt, apiKey);
      const aiJson = JSON.parse(this.cleanJson(rawAIResponse));

      const finalData = {
        title: cleanTitle,
        image_url: finalImg ? `/image/${finalImg.replace(/^https?:\/\//, '')}` : "",
        summary_points: aiJson.summary || [],
        paragraphs: paragraphs
      };

      const html = this.renderArticle(finalData);
      const finalRes = new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=3600, public" } });
      ctx.waitUntil(cache.put(cacheKey, finalRes.clone()));
      return finalRes;
    } catch (err) {
      return this.renderDebugPage(err, currentPrompt, rawAIResponse);
    }
  },

  async callAI(prompt, apiKey) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemma-3-4b-it:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } })
    });
    const json = await res.json();
    if (!json.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("AI Empty Response: " + JSON.stringify(json));
    return json.candidates[0].content.parts[0].text;
  },

  // --- UTILS ---
  async handleImageProxy(path, request) {
    const targetUrl = "https://" + path.replace('/image/', '');
    try {
      const imgRes = await fetch(targetUrl, { headers: this.getStealthHeaders(request, new URL(targetUrl).hostname) });
      const newHeaders = new Headers(imgRes.headers);
      if (imgRes.status === 200) newHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      newHeaders.delete("Set-Cookie");
      return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
    } catch(e) { return new Response(null, { status: 404 }); }
  },

  cleanJson(t) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    return start !== -1 ? t.substring(start, end + 1) : t;
  },

  getStealthHeaders(req, host) {
    const h = new Headers(req.headers);
    h.set("Host", host);
    h.set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    h.set("Referer", `https://${host}/`);
    ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-real-ip"].forEach(x => h.delete(x));
    return h;
  },

  timeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + "m前";
    if (diff < 84000) return Math.floor(diff / 3600) + "h前";
    return Math.floor(diff / 86400) + "d前";
  },

  // --- VIEWS ---
  renderHome(news) {
    const tw = "https://cdn.tailwindcss.com";
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="${tw}"></script></head>
    <body class="bg-slate-50 min-h-screen font-sans">
      <header class="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b p-4 flex justify-between items-center shadow-sm">
        <h1 class="font-black text-xl text-slate-900 tracking-tighter uppercase">SmartNews</h1>
        <div class="font-mono text-[10px] text-slate-500 font-bold tracking-widest uppercase">LIVE</div>
      </header>
      <main class="max-w-md mx-auto divide-y bg-white">
        ${news.map(i => `<a href="${i.link}" class="flex gap-4 p-5 hover:bg-slate-50 transition-colors">
          <div class="w-24 h-16 shrink-0 rounded overflow-hidden bg-slate-100">${i.image ? `<img src="${i.image}" class="w-full h-full object-cover" loading="lazy">` : ''}</div>
          <div class="flex flex-col justify-between py-0.5">
            <h2 class="text-xs font-bold leading-snug text-slate-800 line-clamp-2">${i.title}</h2>
            <div class="flex items-center gap-2 mt-2">
              <span class="text-[8px] font-black uppercase px-1.5 py-0.5 border rounded ${i.color}">${i.source}</span>
              <span class="text-[8px] text-slate-400 font-medium">${this.timeAgo(i.timestamp)}</span>
            </div>
          </div>
        </a>`).join('')}
      </main></body></html>`;
  },

  renderArticle(data) {
    const tw = "https://cdn.tailwindcss.com";
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="${tw}"></script></head>
    <body class="bg-white"><div class="max-w-xl mx-auto">
      ${data.image_url ? `<img src="${data.image_url}" class="w-full aspect-video object-cover">` : ''}
      <div class="p-6">
        <h1 class="text-2xl font-black mb-6 leading-tight text-slate-900">${data.title}</h1>
        <div class="bg-red-50 border-l-4 border-red-600 p-5 mb-8 rounded-r-xl shadow-sm">
          <ul class="space-y-2 text-sm font-medium text-red-900 list-disc list-inside">
            ${data.summary_points.map(p => `<li>${p}</li>`).join('')}
          </ul>
        </div>
        <div class="space-y-6 text-slate-800 leading-relaxed text-lg">
          ${data.paragraphs.map(p => `<p>${p}</p>`).join('')}
        </div>
      </div>
      <footer class="p-10 border-t mt-10 text-center bg-slate-50">
        <a href="/" class="bg-black text-white px-10 py-4 rounded-full text-[10px] font-black tracking-widest uppercase hover:bg-slate-800 shadow-lg">← Back to Feed</a>
      </footer>
    </div></body></html>`;
  },

  renderDebugPage(err, prompt, response) {
    const tw = "https://cdn.tailwindcss.com";
    const escape = (str) => str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="${tw}"></script></head>
    <body class="bg-slate-950 text-slate-300 p-6 font-mono text-[10px] whitespace-pre-wrap break-all">
      <div class="max-w-4xl mx-auto space-y-6">
        <h1 class="text-red-500 text-lg font-black uppercase tracking-tighter italic">EXCEPTION // ${err.message}</h1>
        <div class="space-y-2">
          <h2 class="text-blue-500 font-bold uppercase tracking-widest">[Original Prompt]</h2>
          <div class="bg-slate-900 p-4 rounded border border-slate-800 select-all">${escape(prompt) || 'NONE'}</div>
        </div>
        <div class="space-y-2">
          <h2 class="text-green-500 font-bold uppercase tracking-widest">[Raw AI Response]</h2>
          <div class="bg-slate-900 p-4 rounded border border-slate-800 select-all">${escape(response) || 'NONE'}</div>
        </div>
        <a href="/" class="inline-block bg-slate-800 text-white px-8 py-3 rounded-full font-black uppercase text-[10px] tracking-widest hover:bg-slate-700">Return</a>
      </div>
    </body></html>`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }
};
