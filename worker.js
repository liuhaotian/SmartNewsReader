/**
 * SmartNewsReader
 * Fixed Encoding, Added Epoch Times, Updated BBC RSS.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const apiKey = await env.GEMINI_API_KEY.get();
    
    if (path.startsWith('/image/')) return await this.handleImageProxy(path, request);

    const cache = caches.default;
    const cacheKey = new Request(url.origin + path, { method: "GET" });
    
    if (path !== "/" && path !== "") {
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;
    }

    try {
      if (path === "/" || path === "") return this.renderPortal();
      else if (path.startsWith('/visit/')) return await this.handleNewsFeed(path, request, apiKey, cache, cacheKey, ctx);
      else if (path.startsWith('/article/')) return await this.handleArticle(path, request, apiKey, cache, cacheKey, ctx);
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(`System Error: ${err.message}`, { 
        status: 500, 
        headers: { "Content-Type": "text/plain; charset=UTF-8" } 
      });
    }
  },

  async handleImageProxy(path, request) {
    const targetUrlRaw = path.replace('/image/', '');
    const targetUrl = "https://" + targetUrlRaw;
    const domain = targetUrlRaw.split('/')[0];
    const headers = this.getStealthHeaders(request, domain);
    
    const imgRes = await fetch(targetUrl, { headers });
    const newHeaders = new Headers(imgRes.headers);
    if (imgRes.status === 200) {
      newHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      newHeaders.set("Cache-Control", "no-store");
    }
    newHeaders.delete("Set-Cookie");
    return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
  },

  async handleNewsFeed(path, request, apiKey, cache, cacheKey, ctx) {
    const fullTarget = path.replace('/visit/', '');
    const targetDomain = fullTarget.split('/')[0];
    const targetUrl = `https://${fullTarget}`;
    
    const res = await fetch(targetUrl, { headers: this.getStealthHeaders(request, targetDomain) });
    const contentType = res.headers.get("Content-Type") || "";

    // A. DIRECT RSS PARSING
    if (contentType.includes("xml") || targetUrl.includes("rss") || targetUrl.includes("feed")) {
      const xml = await res.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      
      const news = items.map(item => {
        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/);
        const title = titleMatch ? titleMatch[1] : "";
        
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
        const link = linkMatch ? linkMatch[1] : "";
        
        const mediaMatch = item.match(/<media:content[^>]*url="([\s\S]*?)"/) || item.match(/<enclosure[^>]*url="([\s\S]*?)"/) || item.match(/<img[^>]*src="([\s\S]*?)"/);
        const media = mediaMatch ? mediaMatch[1] : "";
        
        const articlePath = link ? `/article/${new URL(link).hostname}${new URL(link).pathname}${new URL(link).search}` : "#";
        const imageProxy = media ? `/image/${new URL(media).href.replace('https://', '')}` : "";

        return { title, link: articlePath, image: imageProxy };
      });

      const html = this.renderHome({ news });
      return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=600, public" } });
    }

    // B. HTML FALLBACK
    const urlMap = new Map();
    let linkCounter = 1, imgCounter = 1, output = [];
    const rewriter = new HTMLRewriter()
      .on("a[href]", { element(el) {
          const href = el.getAttribute("href");
          if (href && href.length > 1) {
            const id = `L${linkCounter++}`;
            urlMap.set(id, `/article/${new URL(href, targetUrl).hostname}${new URL(href, targetUrl).pathname}`);
            output.push(`[LINK]: ${id}`);
          }
      }})
      .on("img", { element(el) {
          const src = el.getAttribute("src");
          if (src) {
            const id = `I${imgCounter++}`;
            urlMap.set(id, `/image/${new URL(src, targetUrl).href.replace('https://', '')}`);
            output.push(`[IMG]: ${id}`);
          }
      }})
      .on("h1, h2, h3, p", { text(t) { if (t.text.trim().length > 8) output.push(`[TEXT]: ${t.text.trim()}`); } });

    await rewriter.transform(res).arrayBuffer();
    const prompt = `Task: News JSON. Schema: {"news": [{"title": "str", "link": "ID", "image": "ID"}]} Data: ${output.join("\n").substring(0, 60000)}`;
    
    let aiRes = "";
    try {
      aiRes = await this.callAI(prompt, apiKey);
      const data = JSON.parse(this.cleanJson(aiRes));
      const html = this.renderHome(this.mapBack(data, urlMap));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=600, public" } });
    } catch (err) {
      return this.renderDebugPage("HTML Feed AI Failure", err, prompt, aiRes);
    }
  },

  async handleArticle(path, request, apiKey, cache, cacheKey, ctx) {
    const fullPath = path.replace('/article/', '');
    const targetDomain = fullPath.split('/')[0];
    const targetUrl = `https://${fullPath}`;
    const urlMap = new Map();
    let imgCounter = 1, output = [];

    const res = await fetch(targetUrl, { headers: this.getStealthHeaders(request, targetDomain) });
    const rewriter = new HTMLRewriter()
      .on("img", { element(el) {
          const src = el.getAttribute("src") || el.getAttribute("data-src");
          if (src) {
            const id = `I${imgCounter++}`;
            urlMap.set(id, `/image/${new URL(src, targetUrl).href.replace('https://', '')}`);
            output.push(`[IMG]: ${id}`);
          }
      }})
      .on("h1, p", { text(t) { if (t.text.trim().length > 15) output.push(`[TEXT]: ${t.text.trim()}`); } });

    await rewriter.transform(res).arrayBuffer();
    const prompt = `Extract article to JSON. Schema: {"image_url": "ID", "title": "str", "summary_points": ["str"], "paragraphs": ["str"], "metadata": {"reading_time_mins": 5, "sentiment": "str"}} Data: ${output.join("\n").substring(0, 45000)}`;

    let aiRes = "";
    try {
      aiRes = await this.callAI(prompt, apiKey);
      const data = JSON.parse(this.cleanJson(aiRes));
      const html = this.renderArticle(this.mapBack(data, urlMap));
      const finalRes = new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "s-maxage=3600, public" } });
      ctx.waitUntil(cache.put(cacheKey, finalRes.clone()));
      return finalRes;
    } catch (err) {
      return this.renderDebugPage("Article AI Failure", err, prompt, aiRes);
    }
  },

  async callAI(prompt, key) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    });
    const json = await res.json();
    if (!json.candidates?.[0]) throw new Error("AI_REJECTION");
    return json.candidates[0].content.parts[0].text;
  },

  mapBack(obj, urlMap) {
    if (typeof obj === 'string' && urlMap.has(obj)) return urlMap.get(obj);
    if (Array.isArray(obj)) return obj.map(o => this.mapBack(o, urlMap));
    if (typeof obj === 'object' && obj !== null) { for (let k in obj) obj[k] = this.mapBack(obj[k], urlMap); }
    return obj;
  },

  cleanJson(t) {
    const m = t.match(/\{[\s\S]*\}/);
    return m ? m[0] : t;
  },

  getStealthHeaders(req, host) {
    const h = new Headers(req.headers);
    h.set("Host", host);
    h.set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-real-ip"].forEach(x => h.delete(x));
    return h;
  },

  renderPortal() {
    const sites = [
      { name: "RFI 华语", url: "/visit/www.rfi.fr/cn/rss" },
      { name: "BBC 中文", url: "/visit/feeds.bbci.co.uk/zhongwen/trad/rss.xml" },
      { name: "大纪元", url: "/visit/feed.epochtimes.com/feed" }
    ];
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-50 min-h-screen flex flex-col justify-center p-6 italic font-serif">
      <h1 class="text-5xl font-black mb-12 text-center text-slate-900 tracking-tighter uppercase">SmartReader</h1>
      <div class="max-w-xs mx-auto w-full space-y-6">
        ${sites.map(s => `<a href="${s.url}" class="block p-8 bg-white border-4 border-slate-900 rounded-2xl font-black text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:translate-y-1 hover:shadow-none transition-all">${s.name}</a>`).join('')}
      </div>
    </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
  },

  renderHome(data) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-gray-50"><nav class="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b flex gap-2 p-3">
      <a href="/" class="text-[10px] font-black px-4 py-1.5 bg-black text-white rounded-full uppercase">Home</a>
    </nav><main class="max-w-md mx-auto divide-y divide-slate-200">
      ${(data.news || []).map(i => `<a href="${i.link}" class="flex gap-4 p-5 bg-white active:bg-slate-50">
        <div class="w-32 h-24 shrink-0 rounded-lg overflow-hidden bg-slate-100">${i.image ? `<img src="${i.image}" class="w-full h-full object-cover">` : ''}</div>
        <h2 class="text-sm font-bold leading-snug text-slate-800">${i.title}</h2></a>`).join('')}
    </main></body></html>`;
  },

  renderArticle(data) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-white"><div class="max-w-xl mx-auto">
      ${data.image_url ? `<img src="${data.image_url}" class="w-full aspect-video object-cover">` : ''}
      <div class="p-6">
        <h1 class="text-3xl font-black mb-6 leading-tight tracking-tight text-slate-900">${data.title}</h1>
        <div class="bg-red-50 border-l-4 border-red-600 p-6 mb-8 rounded-r-2xl">
          <ul class="space-y-2 text-sm font-medium text-red-900 list-disc list-inside">
            ${(data.summary_points || []).map(p => `<li>${p}</li>`).join('')}
          </ul>
        </div>
        <div class="space-y-6 text-slate-800 leading-relaxed text-lg">
          ${(data.paragraphs || []).map(p => `<p>${p}</p>`).join('')}
        </div>
      </div>
      <footer class="p-12 text-center border-t mt-12"><a href="javascript:history.back()" class="bg-black text-white font-black px-10 py-4 rounded-full uppercase tracking-widest text-xs">← Back</a></footer>
    </div></body></html>`;
  },

  renderDebugPage(title, error, prompt, aiResponse) {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-400 p-6 font-mono text-[10px]">
      <div class="max-w-4xl mx-auto">
        <h1 class="text-red-500 text-xl font-bold mb-6 italic tracking-tighter uppercase">Error // ${title}</h1>
        <div class="border border-red-900 bg-red-950/20 p-4 mb-6 rounded text-red-400 break-all">${error.message}</div>
        <p class="mb-2 text-blue-400 font-bold uppercase tracking-widest text-[8px]">AI Response:</p>
        <pre class="bg-black p-4 rounded mb-6 border border-slate-800 text-green-500 whitespace-pre-wrap">${aiResponse || 'No Response'}</pre>
        <p class="mb-2 text-blue-400 font-bold uppercase tracking-widest text-[8px]">Prompt Data:</p>
        <pre class="bg-black p-4 rounded h-64 overflow-y-scroll border border-slate-800 text-slate-600 whitespace-pre-wrap">${prompt}</pre>
        <div class="mt-8"><a href="/" class="bg-slate-800 text-white px-8 py-3 rounded-full font-bold">Portal Return</a></div>
      </div>
    </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }
};
