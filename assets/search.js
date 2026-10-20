// Search over a static, prebuilt, sharded index. No third-party JS dependencies.
const base = new URL('../data/', import.meta.url);
const cache = new Map();
const BLOCK_SIZE_DEFAULT = 240;
export function fold(s) {
  return String(s ?? '').toLowerCase().replaceAll('æ', 'ae').replaceAll('ø', 'o').replaceAll('å', 'a')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
export function tokens(s) { return [...new Set(fold(s).match(/[a-z0-9]+/g) || [])]; }
export function seconds(ms) {
  const n = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60].map(x => String(x).padStart(2,'0')).join(':');
}
async function load(path) {
  if (!cache.has(path)) {
    const promise = fetch(new URL(path, base), {cache:'no-cache'}).then(r => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }).catch(e => { cache.delete(path); throw e; });
    cache.set(path, promise);
  }
  return cache.get(path);
}
export async function loadInfo() {
  const [manifest, programs] = await Promise.all([load('manifest.json'), load('programs.json')]);
  return {manifest, programs};
}
function collectPosts(bucket, term) {
  const exact = bucket[term] || [];
  const candidates = new Set(exact);
  // Prefix matching means "tro" also finds "troen" and "troende".
  for (const [word, ids] of Object.entries(bucket)) {
    if (word !== term && word.startsWith(term)) for (const id of ids) candidates.add(id);
  }
  return candidates;
}
export async function searchPublished(raw, opts={}, max=350) {
  const qs = tokens(raw);
  if (!qs.length || qs.some(q => q.length < 2)) return [];
  const {manifest, programs} = await loadInfo();
  if (!manifest.segments) return [];
  const sets = await Promise.all(qs.map(async t => {
    try { return collectPosts(await load(`index/${t.slice(0, 2)}.json`), t); }
    catch(e) { if (/HTTP 404/.test(e.message)) return new Set(); throw e; }
  }));
  if (sets.some(s => !s.size)) return [];
  const [short, ...rest] = sets.sort((a, b) => a.size - b.size);
  let candidates = [...short].filter(id => rest.every(s => s.has(id)));
  if (!candidates.length) return [];
  // Avoid loading thousands of remote chunks for broad words.
  const batchSize = manifest.blockSize || BLOCK_SIZE_DEFAULT;
  candidates = candidates.slice(0, Math.max(max * 8, 1800));
  const chunkIDs = [...new Set(candidates.map(id => Math.floor(id / batchSize)))];
  const chunks = new Map();
  // Requests limited to batches of 12 to avoid overloading GitHub Pages/browser.
  for (let i = 0; i < chunkIDs.length; i += 12) {
    const batch = chunkIDs.slice(i, i + 12);
    const got = await Promise.all(batch.map(async n => [n, await load(`chunks/${n}.json`)]));
    for (const [n, val] of got) chunks.set(n, val);
  }
  const desired = fold(raw).trim().replace(/^"|"$/g, '');
  const results = [];
  for (const id of candidates) {
    const chunk = chunks.get(Math.floor(id / batchSize));
    const doc = chunk?.[id % batchSize];
    if (!doc || doc[0] !== id) continue;
    const [_, p, start, end, text] = doc;
    const program = programs[p];
    if (!program) continue;
    const hay = fold(text);
    if (opts.exact && !hay.includes(desired)) continue;
    if (opts.program && !fold(program.title).includes(fold(opts.program))) continue;
    const score = hay.includes(desired) ? 10 : 0;
    results.push({id: `${program.id}|${start}`, programId: program.id, title: program.title,
      url: program.url, start, end, text, score, origin:'published'});
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'nb') || a.start - b.start);
  return results.slice(0, max);
}

export function searchLocal(programs, raw, opts={}) {
  const terms = tokens(raw);
  if (!terms.length || terms.some(t => t.length < 2)) return [];
  const phrase = fold(raw).trim().replace(/^"|"$/g,'');
  const results=[];
  for (const item of programs) {
    if (opts.program && !fold(item.title).includes(fold(opts.program))) continue;
    for (const [start, end, text] of item.segments) {
      const hay=fold(text);
      if (!terms.every(term => tokens(text).some(t => t.startsWith(term)))) continue;
      if (opts.exact && !hay.includes(phrase)) continue;
      results.push({id:`${item.id}|${start}`,programId:item.id,title:item.title,url:item.url,
        start,end,text,score:hay.includes(phrase)?10:0,origin:item.demo?'demo':'local'});
    }
  }
  return results;
}

export function parseSubtitleFile(text) {
  text=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const rows=[];
  const timeRegex=/((?:\d{1,3}:)?\d\d:\d\d[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d\d:\d\d[.,]\d{1,3})/;
  function parseTime(input) {const bits=input.replace(',','.').split(':').map(Number);
    return Math.round(bits.reduce((a,b)=>a*60+b,0)*1000);}
  for(const block of text.split(/\n\s*\n/)) {
    const lines=block.trim().split('\n');
    const ix=lines.findIndex(x=>x.includes('-->'));
    if(ix<0) continue;
    const match=lines[ix].match(timeRegex); if(!match) continue;
    const s=parseTime(match[1]),e=parseTime(match[2]); if(e<=s)continue;
    const caption=lines.slice(ix+1).join(' ').replace(/<[^>]*>/g,'').replace(/\{\\[^}]+\}/g,'')
      .replace(/&(?:amp|lt|gt|quot|apos);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[v])
      .replace(/\s+/g,' ').trim();
    if(caption) rows.push([s,e,caption]);
  }
  rows.sort((a,b)=>a[0]-b[0]);
  const combined=[];let group=[];
  function flush(){if(group.length){combined.push([group[0][0],Math.max(...group.map(x=>x[1])),group.map(x=>x[2]).filter((x,i,a)=>i===0||x!==a[i-1]).join(' ')]);group=[];}}
  for(const r of rows){
    if(group.length && (r[1]-group[0][0]>11000||group.reduce((n,x)=>n+x[2].length,0)+r[2].length>240||r[0]-group[group.length-1][1]>4500))flush();
    group.push(r);
  }
  flush();return combined;
}
