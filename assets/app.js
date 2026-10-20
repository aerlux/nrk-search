import {fold,tokens,seconds,loadInfo,searchPublished,searchLocal,parseSubtitleFile} from './search.js';
const $ = id => document.getElementById(id);
const state = {published:[], local:[], demo:[], hits:[], shown:0, savedOnly:false, query:'', info:null};
const DEMO = [
  {id:'DEMO-1',title:'Eksempel: Samtale om virkelighet',url:'',demo:true,segments:[[84000,92000,'Hva om den største utfordringen ikke er å skille ekte fra falskt, men å våge å være ekte selv?'],[107000,115000,'Kunstig intelligens kan etterligne en stemme. Den kan ikke leve livet for deg.']]},
  {id:'DEMO-2',title:'Eksempel: Historier om fellesskap',url:'',demo:true,segments:[[258000,268000,'Ensomhet handler ikke bare om å være alene. Det handler om å ikke bli sett.'],[301000,310000,'Tro er mer enn ord. Det er hvordan vi møter mennesker vi ellers ville gått forbi.']]},
  {id:'DEMO-3',title:'Eksempel: En samtale om teknologi',url:'',demo:true,segments:[[91000,102000,'Hva er ekte når alt kan fremstilles som sannhet? Det spørsmålet er viktigere enn noensinne.'],[540000,549000,'Med kunstig intelligens kan vi lage utrolige bilder, men hvordan bevarer vi tilliten?']]}
];
const FAV_KEY = 'klippfinner.saved.v1';
let favorites = new Map();
try { for(const item of JSON.parse(localStorage.getItem(FAV_KEY)||'[]'))favorites.set(item.id,item); } catch(_) {}
function saveFavorites(){try{localStorage.setItem(FAV_KEY,JSON.stringify([...favorites.values()]));}catch(e){notice('Lagring i nettleseren er utilgjengelig: '+e.message);}}
function persistCount(){ $('saveCount').textContent=String(favorites.size); $('exportSaved').disabled=!favorites.size; }
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function dbOpen(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open('nrk-klippfinner',1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('programs'))req.result.createObjectStore('programs',{keyPath:'id'});};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
async function dbList(){const db=await dbOpen();return new Promise((resolve,reject)=>{
  const tr=db.transaction('programs','readonly'),r=tr.objectStore('programs').getAll();
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tr.oncomplete=()=>db.close();});}
async function dbPut(program){const db=await dbOpen();return new Promise((resolve,reject)=>{
  const tr=db.transaction('programs','readwrite');tr.objectStore('programs').put(program);
  tr.oncomplete=()=>{db.close();resolve();};tr.onerror=()=>reject(tr.error);});}
function el(tag,cls='',content=''){const x=document.createElement(tag);if(cls)x.className=cls;if(content)x.textContent=content;return x;}
function makeHighlight(text,query){
  const span=el('span');const textLower=fold(text);const raw=fold(query.trim().replace(/^"|"$/g,''));
  // Unicode folding can change character positions: highlight literal words using a safe DOM regex.
  const wordList=tokens(query).sort((a,b)=>b.length-a.length).filter(t=>t.length>1);
  if(!wordList.length){span.textContent=text;return span;}
  const pattern=wordList.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  let regexp;try{regexp=new RegExp(`(${pattern})`,'gi');}catch(_){span.textContent=text;return span;}
  const bits=text.split(regexp);
  bits.forEach(bit=>{if(wordList.includes(fold(bit)))span.append(el('mark','',bit));else span.append(document.createTextNode(bit));});
  return span;
}
function createCard(hit){
  const card=el('article','result');
  const top=el('div','result-top');
  top.append(el('span','pname',hit.title));
  if(hit.origin==='demo') top.append(el('span','sample','FIKTIVT'));
  top.append(el('span','timestamp',seconds(hit.start)));
  const quote=el('p','quote');quote.append(makeHighlight('«'+hit.text+'»',state.query));
  const acts=el('div','result-actions');
  if(hit.url && /^https:\/\/tv\.nrk\.no\//.test(hit.url)){
    const a=el('a','','Åpne i NRK TV ↗');a.href=hit.url;a.target='_blank';a.rel='noopener noreferrer';a.title='Åpner episode i NRK TV; gå manuelt til angitt tidskode';acts.append(a);
  }else{acts.append(el('span','source',hit.origin==='demo'?'Demonstrasjonsdata':'Ingen NRK-lenke registrert'));}
  const sep=el('span','separator');acts.append(sep);
  const copy=el('button','','Kopier kilde + tid');copy.type='button';copy.addEventListener('click',async()=>{
    const data=`${hit.title}\n${seconds(hit.start)}–${seconds(hit.end)}\n${hit.text}\n${hit.url||'Ingen kilde-URL'}`;
    try{await navigator.clipboard.writeText(data);copy.textContent='✓ Kopiert';setTimeout(()=>copy.textContent='Kopier kilde + tid',1700);}
    catch(_){notice('Kopiering feilet. Marker og kopier teksten manuelt.');}
  });acts.append(copy);
  const star=el('button','save'+(favorites.has(hit.id)?' is-saved':''),favorites.has(hit.id)?'★':'☆');star.type='button';star.setAttribute('aria-label',favorites.has(hit.id)?'Fjern fra lagrede klipp':'Lagre klippet');
  star.addEventListener('click',()=>{
    if(favorites.has(hit.id))favorites.delete(hit.id);else favorites.set(hit.id,hit);
    saveFavorites();persistCount();star.textContent=favorites.has(hit.id)?'★':'☆';star.classList.toggle('is-saved',favorites.has(hit.id));star.setAttribute('aria-label',favorites.has(hit.id)?'Fjern fra lagrede klipp':'Lagre klippet');
    if(state.savedOnly)performSearch();
  });acts.append(star);card.append(top,quote,acts);return card;
}
function render(reset=true){
  if(reset){state.shown=0;$('results').replaceChildren();}
  const count=Math.min(state.shown+24,state.hits.length);
  for(let i=state.shown;i<count;i++)$('results').append(createCard(state.hits[i]));
  state.shown=count;
  $('showMore').hidden=count>=state.hits.length;
  $('empty').hidden=state.hits.length>0;
  if(state.savedOnly){$('resultsHeading').textContent=`${state.hits.length} lagrede klipp`;$('resultsSubheading').textContent='Din personlige klippliste er lagret på denne enheten.';}
  else if(!state.query){$('resultsHeading').textContent='Start med et søk';$('resultsSubheading').textContent='Søk etter ord eller fraser i indekserte undertekster.';}
  else {$('resultsHeading').textContent=`${state.hits.length} treff ${state.hits.length>=350?'(begrenset visning)':''}`;
    $('resultsSubheading').textContent=`Søk etter «${state.query}» · tidspunktene gjelder undertekstene, ikke nødvendigvis start på et ferdig klipp.`;}
  if(!state.hits.length){
    $('empty').querySelector('h3').textContent=state.savedOnly?'Du har ikke lagret noen klipp ennå.':state.query?'Ingen treff i tilgjengelig indeks.':'Det riktige øyeblikket finnes et sted.';
    $('empty').querySelector('p').textContent=state.savedOnly?'Finn klipp og trykk på stjernen for å lagre dem her.':state.query?'Prøv et kortere søkeord, fjern et filter eller importer flere undertekster.':'Databasen er foreløpig tom. Importer undertekstfiler eller prøv en demonstrasjon med oppdiktet innhold.';
  }
}
let searchTick=0;
async function performSearch(){
  const tick=++searchTick;
  state.query=$('query').value.trim();
  const opts={exact:$('exact').checked,program:$('filterProgram').value.trim()};
  if(state.savedOnly){
    const arr=[...favorites.values()].filter(x=>(!opts.program||fold(x.title).includes(fold(opts.program)))&&(!state.query||tokens(state.query).every(t=>tokens(x.text).some(w=>w.startsWith(t)))));
    state.hits=arr;render();return;
  }
  if(!state.query){state.hits=[];render();return;}
  if(tokens(state.query).some(t=>t.length<2)){notice('Bruk søkeord på minst to tegn.');state.hits=[];render();return;}
  notice('Søker i indeksen …');
  try{
    const [pub,local] = await Promise.all([
      searchPublished(state.query,opts),
      Promise.resolve(searchLocal([...state.local,...state.demo],state.query,opts))
    ]);
    if(tick!==searchTick)return;
    const unique=new Map();for(const h of [...pub,...local])unique.set(h.id,h);
    state.hits=[...unique.values()].sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title,'nb')||a.start-b.start);
    notice('');render();
  }catch(e){if(tick!==searchTick)return;state.hits=searchLocal([...state.local,...state.demo],state.query,opts);render();notice('Den publiserte indeksen kunne ikke leses. Lokale filer kan fortsatt søkes. '+e.message);}
}
function triggerSearch(){state.savedOnly=false;$('toggleSaved').textContent='☆ Lagrede '+favorites.size;performSearch();}
$('searchForm').addEventListener('submit',ev=>{ev.preventDefault();triggerSearch();});
$('filterProgram').addEventListener('input',()=>{clearTimeout(window.__filterTimer);window.__filterTimer=setTimeout(performSearch,280);});
$('exact').addEventListener('change',performSearch);
for(const btn of document.querySelectorAll('[data-query]'))btn.addEventListener('click',()=>{$('query').value=btn.dataset.query;triggerSearch();});
$('toggleSaved').addEventListener('click',()=>{state.savedOnly=!state.savedOnly;$('toggleSaved').textContent=(state.savedOnly?'★':'☆')+' Lagrede '+favorites.size;performSearch();});
$('showMore').addEventListener('click',()=>render(false));
$('demoButton').addEventListener('click',()=>{state.demo=DEMO;$('query').value='ekte';updateCounts();triggerSearch();});
function csvEscape(v){const s=String(v??'');const protectedCell=/^[\s]*[=+@\-]/.test(s)?"'"+s:s;return '"'+protectedCell.replace(/"/g,'""')+'"';}
$('exportSaved').addEventListener('click',()=>{
  const rows=[['Program','Fra','Til','Undertekst','URL'], ...[...favorites.values()].map(f=>[f.title,seconds(f.start),seconds(f.end),f.text,f.url])];
  const csv='\ufeff'+rows.map(row=>row.map(csvEscape).join(';')).join('\r\n');
  const object=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=el('a');a.href=object;a.download='klippfinner-klippliste.csv';a.click();setTimeout(()=>URL.revokeObjectURL(object),2000);
});
function updateCounts(){const published=state.info?.manifest||{programs:0,segments:0};$('programCount').textContent=(published.programs+state.local.length).toLocaleString('nb-NO');
  $('segmentCount').textContent=(published.segments+[...state.local,...state.demo].reduce((n,p)=>n+p.segments.length,0)).toLocaleString('nb-NO');
  $('localCount').textContent=state.local.length.toLocaleString('nb-NO');persistCount();}
function openModal(){$('importMessage').textContent='';$('importDialog').showModal();}
$('openImport').addEventListener('click',openModal);$('emptyImport').addEventListener('click',openModal);
function closeModal(){$('importDialog').close();}
$('closeDialog').addEventListener('click',closeModal);$('cancelImport').addEventListener('click',closeModal);
$('importForm').addEventListener('submit',async ev=>{
  ev.preventDefault();const file=$('importFile').files[0], title=$('importTitle').value.trim(),url=$('importUrl').value.trim();
  if(!file||!title)return;
  if(file.size>6_000_000){$('importMessage').textContent='Filen er for stor (maks. 6 MB). Bruk Python-indekseren for større filer.';return;}
  if(url){try{const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='tv.nrk.no'){throw Error();}}catch(_){$('importMessage').textContent='Bruk https://tv.nrk.no/... som programlenke.';return;}}
  try{const segments=parseSubtitleFile(await file.text());if(!segments.length)throw Error('Ingen lesbare tidskoder i filen.');
    const match=url.match(/([A-Za-z]{4}\d{8})(?!\d)/);
    const id=match?match[1].toUpperCase():'LOCAL-'+Date.now();
    const program={id,title,url,segments};await dbPut(program);
    state.local=await dbList();updateCounts();closeModal();$('importForm').reset();
    notice(`Importerte «${title}» med ${segments.length} søkeblokker. Lagret kun lokalt.`);
    $('query').value='';state.hits=[];render();
  }catch(e){$('importMessage').textContent='Import feilet: '+e.message;}
});
async function init(){
  try{state.info=await loadInfo();}catch(e){notice('Ingen publisert indeks funnet. Importer VTT/SRT lokalt eller kjør eksport fra README.');}
  try{state.local=await dbList();}catch(e){notice('Nettleserlagring er utilgjengelig. Prøv uten privat nettlesermodus.');}
  updateCounts();render();
}
init();
