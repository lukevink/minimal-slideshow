/* Minimal Photo Slideshow v1.3.0 — Home Assistant photo card. Photos stay in this browser's memory.
 * Source: individual photos through Home Assistant or a user-provided URL list.
 * Original implementation; not Apple's screensaver code.
 */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
// Normalized photograph arrangements; each covers the screen exactly once.
const layouts = [
  [[0,0,1,1]],
  [[0,0,.5,1],[.5,0,.5,1]],
  [[0,0,1/3,.5],[0,.5,1/3,.5],[1/3,0,2/3,1]],
  [[0,0,1/3,.5],[1/3,0,2/3,.5],[0,.5,2/3,.5],[2/3,.5,1/3,.5]],
  [[0,0,2/3,1],[2/3,0,1/3,.5],[2/3,.5,1/3,.5]],
  [[0,0,1,.5],[0,.5,1,.5]],
  [[0,0,.5,.5],[.5,0,.5,.5],[0,.5,.5,.5],[.5,.5,.5,.5]],
  [[0,0,1/3,1/3],[0,1/3,1/3,1/3],[0,2/3,1/3,1/3],[1/3,0,2/3,1]],
  [[0,0,2/3,.5],[2/3,0,1/3,.5],[0,.5,1/3,.5],[1/3,.5,2/3,.5]],
  [[0,0,2/3,1],[2/3,0,1/3,1/3],[2/3,1/3,1/3,1/3],[2/3,2/3,1/3,1/3]],
  [[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]],
  [[0,0,.5,.5],[0,.5,.5,.5],[.5,0,.5,1]],
  [[0,0,1/3,1],[1/3,0,1/3,1],[2/3,0,1/3,1]]
];
const sameRect=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<.00001);
// Older configurations are converted once; all execution uses HA's action dispatcher.
export function normalizeActions(config){
  const {home_path,slideshow_minutes,...result}=config;
  if(result.tap_action==='none')result.tap_action={action:'none'};
  else if(result.tap_action===undefined&&typeof home_path==='string'&&home_path.startsWith('/')&&!home_path.startsWith('//'))result.tap_action={action:'navigate',navigation_path:home_path};
  for(const key of ['tap_action','hold_action','double_tap_action']){
    result[key]=result[key]??{action:'none'};
    if(typeof result[key]!=='object'||Array.isArray(result[key])||typeof result[key].action!=='string')throw new Error(`${key} must be a Home Assistant action object.`);
  }
  return result;
}
// Private photos remain in tab memory. Cap the shared return-to-card buffer.
const photoBuffers=new Map(),BUFFER_BYTES=48*1024*1024,BUFFER_TTL=10*60*1000;
function trimPhotoBuffers(){
  for(const [key,value] of photoBuffers)if(Date.now()-value.savedAt>BUFFER_TTL){clearTimeout(value.expiry);photoBuffers.delete(key);}
  let bytes=[...photoBuffers.values()].reduce((sum,value)=>sum+value.bytes,0);
  for(const [key,value] of photoBuffers){if(bytes<=BUFFER_BYTES&&photoBuffers.size<=2)break;bytes-=value.bytes;clearTimeout(value.expiry);photoBuffers.delete(key);}
}
let nativeCardPromise;
async function nativeButtonCard(){
  if(customElements.get('hui-button-card'))return customElements.get('hui-button-card');
  if(!window.loadCardHelpers)return null;
  if(!nativeCardPromise)nativeCardPromise=window.loadCardHelpers().then(async helpers=>{
    helpers.createCardElement({type:'button'});
    await customElements.whenDefined('hui-button-card');
    return customElements.get('hui-button-card');
  }).catch(error=>{nativeCardPromise=null;throw error;});
  return nativeCardPromise;
}

const style = `
 :host{display:block;height:100%;min-height:0}
 ha-card{position:relative;display:block;overflow:hidden;height:var(--origami-height,calc(100dvh - var(--header-height,0px)));background:#080808;border:0;border-radius:0;box-shadow:none;touch-action:manipulation;isolation:isolate}
 .stage{position:absolute;inset:0;overflow:hidden;outline:none;perspective:var(--fold-perspective,2400px);perspective-origin:50% 50%;cursor:pointer}
 .scene,.composition{position:absolute;inset:0;overflow:hidden}
 .photo{position:absolute;overflow:hidden;background:#101010}
 .photo img{width:100%;height:100%;display:block;object-fit:cover;object-position:50% 45%;pointer-events:none}
 .folds{position:absolute;inset:0;transform-style:preserve-3d;pointer-events:none}
 .leaf{position:absolute;transform-style:preserve-3d;will-change:transform}.face{position:absolute;inset:0;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#080808}.reveal{position:absolute;overflow:hidden}.reveal .composition{right:auto;bottom:auto}
 .leaf .composition{right:auto;bottom:auto}
 .shade{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;will-change:opacity}
 .leaf:after{content:'';position:absolute;inset:0;box-shadow:inset 0 0 1px #0005;pointer-events:none}
 .status{position:absolute;inset:0;display:grid;place-content:center;padding:24px;color:#eee;text-align:center;font:400 16px system-ui}
 .status[hidden]{display:none}
 .status small{display:block;color:#aaa;margin-top:8px;font-size:13px}
 @media(prefers-reduced-motion:reduce){.leaf{will-change:auto}}
`;

export class OrigamiAlbumCard extends HTMLElement {
  constructor(){
    super(); this.attachShadow({mode:'open'}); this._photos=[]; this._serial=0; this._turn=0; this._layoutStep=0;
    this._animations=[]; this._visible=true;this._history=[];this._historyIndex=-1;this._commandQueue=Promise.resolve();
    this._visibility=()=>{this._finish();this._schedule();this._load();};
    this.shadowRoot.innerHTML=`<style>${style}</style><ha-card><div class="stage" role="button" tabindex="0" aria-label="Slideshow actions"><div class="scene"></div><div class="folds"></div><div class="status">Connecting to your album…</div></div></ha-card>`;
    this._stage=this.shadowRoot.querySelector('.stage');
    this._scene=this.shadowRoot.querySelector('.scene');
    this._folds=this.shadowRoot.querySelector('.folds');
    this._status=this.shadowRoot.querySelector('.status');
    this._stage.addEventListener('action',event=>{event.stopPropagation();this._handleAction(event.detail?.action);});
  }
  setConfig(config){
    config=normalizeActions(config);
    if(config.source&&!['minimal_slideshow','origami_photos'].includes(config.source)) throw new Error('Unknown photo source.');
    if(this._config?.source!==config.source||this._config?.album_id!==config.album_id||JSON.stringify(this._config?.images)!==JSON.stringify(config.images)) this._clear();
    this._config={...config,interval:clamp(config.interval||8,2,120),duration:clamp(config.duration||1800,250,6000)};
    this.shadowRoot.querySelector('ha-card').style.setProperty('--origami-height', config.height || 'calc(100dvh - var(--header-height,0px))');
    this._bindActions();this._load(); this._schedule();
  }
  set hass(hass){if(this._hass&&this._hass.user?.id!==hass.user?.id)this._clear();this._hass=hass;this._subscribeControls();this._load();}
  get hass(){return this._hass;}
  connectedCallback(){
    document.addEventListener('visibilitychange',this._visibility);this._bindActions();this._subscribeControls();
    this._observer=new IntersectionObserver(entries=>{this._visible=entries[0].isIntersecting;if(!this._visible)this._finish();this._schedule();if(this._visible)this._load();});
    this._observer.observe(this);this._resize=new ResizeObserver(()=>{if(this._mosaicMode()&&this._current?.length===1&&!this._screenMatch(this._current[0].photo)&&this._photos.length>=2){this._finish();const next=this._chooseLayout();if(next){this._current=next;this._scene.replaceChildren(this._render(next));}}});this._resize.observe(this._stage);this._load();this._schedule();
  }
  disconnectedCallback(){this._actionHandler?.bind(this._stage,{disabled:true});this._controlGeneration=(this._controlGeneration||0)+1;this._unsubscribeControls?.();this._unsubscribeControls=null;this._controlConnection=null;document.removeEventListener('visibilitychange',this._visibility);this._observer?.disconnect();this._resize?.disconnect();this._clear();}
  _clear(){
    clearTimeout(this._timer);clearTimeout(this._retry);clearTimeout(this._prefetch);this._request?.abort();for(const request of this._requests||[])request.abort();this._requests=new Set();this._serial++;this._finish();this._saveBuffer();
    for(const p of this._photos)URL.revokeObjectURL(p.url);
    this._photos=[];this._history=[];this._historyIndex=-1;this._resolvedAlbum=null;this._current=null;this._frame=null;this._loading=null;this._catalog=null;this._bufferChecked=false;this._nextLoad=0;this._failedPhotos=new Map();this._scene?.replaceChildren();this._message("Connecting to your album…");
  }
  _message(text){this._status.textContent=text;this._status.hidden=false;}
  _queueKey(){return 'minimal-slideshow-queue:'+(this._hass?.user?.id||'preview')+':'+ (this._config.source||'minimal_slideshow')+':'+(this._config.album_id||'default')+':'+JSON.stringify(this._config.images||[]);}
  _api(){return this._config?.source==='origami_photos'?'origami_photos':'minimal_slideshow';}
  _saveQueue(){
    try{sessionStorage.setItem(this._queueKey(),JSON.stringify({ids:this._queue,cursor:this._cursor}));}catch{}
  }
  _shuffle(ids){
    const result=ids.slice();for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;
  }
  _bufferKey(){return `${this._hass?.user?.id||'preview'}:${this._queueKey()}:${this._config.effect||'origami'}`;}
  _saveBuffer(){
    if(!this._config||!this._current?.length||!this._photos.length)return;
    const current=this._current.map(tile=>({id:tile.photo.id,rect:tile.rect.slice()}));
    const ordered=[...new Set([...this._current.map(tile=>tile.photo),...this._photos])];
    let bytes=0;const photos=[];
    for(const photo of ordered){
      if(!photo.blob||bytes+photo.blob.size>BUFFER_BYTES)continue;
      const {url,...copy}=photo;photos.push(copy);bytes+=photo.blob.size;
    }
    if(current.some(tile=>!photos.some(photo=>photo.id===tile.id)))return;
    const key=this._bufferKey();clearTimeout(photoBuffers.get(key)?.expiry);photoBuffers.delete(key);
    const entry={photos,current,catalog:this._catalog?new Map(this._catalog):null,catalogTime:this._catalogTime,queue:this._queue?.slice(),cursor:this._cursor,resolvedAlbum:this._resolvedAlbum,turn:this._turn,bytes,savedAt:Date.now()};
    entry.expiry=setTimeout(()=>{if(photoBuffers.get(key)===entry)photoBuffers.delete(key);},BUFFER_TTL);
    photoBuffers.set(key,entry);trimPhotoBuffers();
  }
  _restoreBuffer(){
    if(this._bufferChecked)return;this._bufferChecked=true;trimPhotoBuffers();
    const saved=photoBuffers.get(this._bufferKey());if(!saved)return;
    this._photos=saved.photos.map(photo=>({...photo,url:URL.createObjectURL(photo.blob)}));
    this._catalog=saved.catalog?new Map(saved.catalog):null;this._catalogTime=saved.catalogTime;
    this._queue=saved.queue?.slice();this._cursor=saved.cursor;this._resolvedAlbum=saved.resolvedAlbum;this._turn=saved.turn;
    this._current=saved.current.map(tile=>({rect:tile.rect.slice(),photo:this._photos.find(photo=>photo.id===tile.id)}));
    // Recompute square cells and orientation-dependent layouts after rotation.
    if(this._config.effect==='shifting_tiles')this._current=this._gridTiles();
    else if(this._mosaicMode()&&this._current.length===1&&!this._screenMatch(this._current[0].photo)&&this._photos.length>1)this._current=this._chooseLayout();
    this._scene.replaceChildren(this._render(this._current));this._status.hidden=true;this._remember();
  }
  async _fetchPhoto(id,serial){
    const request=new AbortController();this._requests??=new Set();this._requests.add(request);
    const timeout=setTimeout(()=>request.abort(),15000);let objectURL;
    try{
      const direct=this._catalog.get(id)?.url;let response;
      if(direct){const url=new URL(direct,location.origin);if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP image URL');response=await fetch(url,{signal:request.signal,credentials:url.origin===location.origin?'same-origin':'omit'});}
      else response=await this._hass.fetchWithAuth(`/api/${this._api()}/image/${encodeURIComponent(id)}${this._config.album_id?'?entry_id='+encodeURIComponent(this._config.album_id):''}`,{signal:request.signal});
      if(!response.ok)throw new Error('Photo temporarily unavailable');
      const blob=await response.blob();objectURL=URL.createObjectURL(blob);const img=new Image();img.src=objectURL;await img.decode();
      if(serial!==this._serial||!this.isConnected)return;
      const photo={id,blob,url:objectURL,width:img.naturalWidth,height:img.naturalHeight};this._photos.push(photo);objectURL=null;this._failedPhotos?.delete(id);
      if(!this._current){const first=this._initialComposition();if(first){this._current=first;for(const tile of first)tile.photo.lastShown=this._turn;this._scene.replaceChildren(this._render(first));this._status.hidden=true;this._remember();}}
    }catch{
      if(serial===this._serial){this._failedPhotos??=new Map();this._failedPhotos.set(id,Date.now()+30000);}
    }finally{clearTimeout(timeout);this._requests.delete(request);if(objectURL)URL.revokeObjectURL(objectURL);}
  }
  async _load(){
    if(!this.isConnected||!this._visible||document.hidden||!this._config||!this._hass||this._loading)return;
    this._restoreBuffer();
    if(Date.now()<(this._nextLoad||0)){clearTimeout(this._prefetch);this._prefetch=setTimeout(()=>this._load(),this._nextLoad-Date.now());return;}
    this._loading=true;const serial=this._serial;let retry=4000;
    try{
      if(!this._catalog||Date.now()-(this._catalogTime||0)>7200000){
        const result=this._config.images?.length?{photos:this._config.images.map((item,i)=>({id:String(i),url:typeof item==='string'?item:item.url}))}:await this._hass.callApi('GET',this._api()+'/catalog'+(this._config.album_id?'?entry_id='+encodeURIComponent(this._config.album_id):''));
        if(serial!==this._serial)return;
        const catalog=new Map(result.photos.map(photo=>[photo.id,photo]));if(!catalog.size)throw new Error('Empty album');
        this._catalog=catalog;this._catalogTime=Date.now();this._resolvedAlbum=result.entry_id||this._config.album_id;
        let saved;try{saved=JSON.parse(sessionStorage.getItem(this._queueKey()));}catch{}
        if(saved?.ids?.length&&Number.isInteger(saved.cursor)&&saved.cursor>=0){
          this._queue=saved.ids.filter(id=>catalog.has(id));this._cursor=Math.min(saved.cursor,this._queue.length);
          const known=new Set(this._queue);this._queue.push(...this._shuffle([...catalog.keys()].filter(id=>!known.has(id))));
        }else{this._queue=this._shuffle([...catalog.keys()]);this._cursor=0;}
      }
      const target=this._config.effect==='shifting_tiles'?10:6;
      // Three simultaneous downloads keep a slow photo from blocking the buffer.
      for(let batch=0;batch<4&&this.isConnected&&this._visible&&!document.hidden&&serial===this._serial;batch++){
        this._prune();const missing=target-this._photos.filter(photo=>photo.lastShown===undefined).length;if(missing<=0)break;
        const ids=[];let scanned=0;
        while(ids.length<Math.min(3,missing)&&scanned++<this._queue.length){
          if(this._cursor>=this._queue.length){this._queue=this._shuffle([...this._catalog.keys()]);this._cursor=0;}
          const id=this._queue[this._cursor++];
          if(!ids.includes(id)&&!this._photos.some(photo=>photo.id===id)&&Date.now()>=(this._failedPhotos?.get(id)||0))ids.push(id);
        }
        this._saveQueue();if(!ids.length)break;
        await Promise.all(ids.map(id=>this._fetchPhoto(id,serial)));
      }
      if(serial!==this._serial)return;
      if(!this._current)this._message(this._photos.length?'Preparing your photo layout…':'Loading photos from your source…');
      this._prune();
    }catch{
      retry=15000;
      if(serial===this._serial&&!this._current)this._message('Connecting to your photo source…');
    }finally{
      if(serial===this._serial){
        this._loading=null;this._nextLoad=Date.now()+retry;
        this._stage.dataset.buffer=String(this._photos.length);this._stage.dataset.catalog=String(this._catalog?.size||0);
        clearTimeout(this._prefetch);if(this.isConnected&&this._visible&&!document.hidden)this._prefetch=setTimeout(()=>this._load(),retry);
      }
    }
  }
  _prune(){
    const used=new Set([...(this._current||[]),...(this._next||[])].map(p=>p.photo.url));
    // Discard photographs already shown before dropping any unseen photographs.
    const removable=this._photos.filter(p=>!used.has(p.url)).sort((a,b)=>(a.lastShown??Infinity)-(b.lastShown??Infinity));
    while(this._photos.length>(this._config?.effect==='shifting_tiles'?18:12)&&removable.length){const photo=removable.shift();this._photos.splice(this._photos.indexOf(photo),1);URL.revokeObjectURL(photo.url);}
  }
  _mosaicMode(){return ['origami','sliding_panels','shifting_tiles'].includes(this._config?.effect||'origami');}
  _screenMatch(photo){
    const screen=this._stage.clientWidth/Math.max(1,this._stage.clientHeight),image=photo.width/photo.height;
    return screen>1.1?image>1.1:screen<.9?image<.9:true;
  }
  _initialComposition(){
    if(!this._photos.length)return null;
    if(this._config?.effect==='shifting_tiles'&&this._catalog?.size>=4){if(this._photos.length<Math.min(6,this._catalog.size))return null;return this._gridTiles();}
    if(!this._mosaicMode())return [{rect:[0,0,1,1],photo:this._photos[0]}];
    // Wait for a compatible photo or a pair, instead of flashing a lone portrait.
    if(this._photos.length>=2)return this._chooseLayout();
    if(this._screenMatch(this._photos[0])||this._catalog?.size===1)return [{rect:[0,0,1,1],photo:this._photos[0]}];
    return null;
  }
  _assignment(rectangles,keep=[]){
    const ratio=this._stage.clientWidth/Math.max(1,this._stage.clientHeight);
    const kept=new Set(keep.map(p=>p.photo.url));
    const current=new Set((this._current||[]).map(p=>p.photo.url));
    const single=this._mosaicMode()&&rectangles.length===1;
    const available=this._photos.filter(p=>!kept.has(p.url)&&(!single||this._screenMatch(p))).slice(-12);
    const changing=rectangles.filter(r=>!keep.some(p=>sameRect(p.rect,r)));
    if(available.length<changing.length)return null;
    const memo=new Map();
    const score=(photo,rect)=>{
      const target=ratio*rect[2]/rect[3],aspect=photo.width/photo.height;
      const crop=1-Math.min(aspect/target,target/aspect);
      const recent=photo.lastShown===undefined?0:Math.max(.5,3-(this._turn-photo.lastShown)*.4);
      return crop*7+recent+(current.has(photo.url)?4:0);
    };
    const solve=(index,mask)=>{
      if(index===changing.length)return {cost:0,choices:[]};
      const key=index+':'+mask;if(memo.has(key))return memo.get(key);
      let best={cost:Infinity,choices:[]};
      for(let i=0;i<available.length;i++)if(!(mask&(1<<i))){
        const rest=solve(index+1,mask|(1<<i)),cost=score(available[i],changing[index])+rest.cost;
        if(cost<best.cost)best={cost,choices:[i,...rest.choices]};
      }
      memo.set(key,best);return best;
    };
    const best=solve(0,0);let index=0;
    const composition=rectangles.map(rect=>keep.find(p=>sameRect(p.rect,rect))||{rect,photo:available[best.choices[index++]]});
    return {composition,cost:best.cost/Math.max(1,changing.length)};
  }
  _compose(rectangles=layouts[0],keep=[]){return this._assignment(rectangles,keep)?.composition||this._current;}
  _chooseLayout(){
    let best;
    const desired=[3,4,2,4,1][this._turn%5];
    for(let i=0;i<layouts.length;i++){
      const rectangles=layouts[i];if(rectangles.length>this._photos.length)continue;
      const keep=this._current?.length>1&&rectangles.length>1?this._current.filter(p=>rectangles.some(r=>sameRect(r,p.rect))).slice(0,rectangles.length-1):[];
      const result=this._assignment(rectangles,keep);if(!result)continue;
      const same=i===this._layoutIndex;
      const score=result.cost+(same?.65:0)+Math.abs(rectangles.length-desired)*.14;
      if(!best||score<best.score)best={...result,score,index:i};
    }
    if(!best)return null;this._layoutIndex=best.index;return best.composition;
  }
  _render(composition){
    const el=document.createElement('div');el.className='composition';
    for(const {rect:[x,y,w,h],photo} of composition){
      const tile=document.createElement('div');tile.className='photo';
      Object.assign(tile.style,{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`});
      const img=document.createElement('img');img.src=photo.url;if(photo.position)img.style.objectPosition=photo.position;if(composition.length===1)img.style.objectFit=this._mosaicMode()?'cover':(photo.height>photo.width?'contain':'cover');img.alt='';img.draggable=false;tile.append(img);el.append(tile);
    }return el;
  }
  _schedule(){clearTimeout(this._timer);if(this.isConnected&&this._visible&&!document.hidden&&this._config)this._timer=setTimeout(()=>this._transition(),this._config.interval*1000);}
  _finish(){
    this._motionId=(this._motionId||0)+1;
    if(this._next){this._current=this._next;this._next=null;for(const p of this._current)p.photo.lastShown=this._turn;this._scene.replaceChildren(this._render(this._current));this._remember();}
    for(const a of this._animations)a.cancel();this._animations=[];this._folds?.replaceChildren();if(this._scene)this._scene.style.opacity='1';
  }
  _crop(composition,x,y,width,height){
    const el=this._render(composition);
    Object.assign(el.style,{width:`${width}px`,height:`${height}px`,left:`${-x*width}px`,top:`${-y*height}px`});
    return el;
  }
  _flip(region,horizontal,reverse,delay,duration){
    const [x,y,w,h]=region;
    const {width,height}=this._stage.getBoundingClientRect();
    const sw=horizontal?w:w/2,sh=horizontal?h/2:h;
    const sx=x+(reverse&&!horizontal?w/2:0),sy=y+(reverse&&horizontal?h/2:0);
    const tx=x+(!reverse&&!horizontal?w/2:0),ty=y+(!reverse&&horizontal?h/2:0);
    const size={left:`${sx*100}%`,top:`${sy*100}%`,width:`${sw*100}%`,height:`${sh*100}%`};
    const reveal=document.createElement('div');reveal.className='reveal';Object.assign(reveal.style,size);
    reveal.append(this._crop(this._next,sx,sy,width,height));this._folds.append(reveal);
    const leaf=document.createElement('div');leaf.className='leaf';Object.assign(leaf.style,size);
    leaf.style.transformOrigin=horizontal?`50% ${reverse?'0%':'100%'}`:`${reverse?'0%':'100%'} 50%`;
    const axis=horizontal?'X':'Y';const angle=(horizontal?-1:1)*(reverse?-1:1)*180;
    const front=document.createElement('div');front.className='face';front.append(this._crop(this._current,sx,sy,width,height));
    const back=document.createElement('div');back.className='face';back.style.transform=`rotate${axis}(180deg)`;back.append(this._crop(this._next,tx,ty,width,height));
    const frontShade=document.createElement('div'),backShade=document.createElement('div');frontShade.className=backShade.className='shade';front.append(frontShade);back.append(backShade);leaf.append(front,back);this._folds.append(leaf);
    const options={duration,delay,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'};
    const rotation=leaf.animate([{transform:`rotate${axis}(0deg)`},{transform:`rotate${axis}(${angle}deg)`}],options);
    this._animations.push(rotation,frontShade.animate([{opacity:0},{opacity:.28,offset:.5},{opacity:0}],options),backShade.animate([{opacity:0},{opacity:.22,offset:.5},{opacity:0}],options));
    return rotation.finished;
  }
  async _transition(){
    if(!this._current||this._photos.length<2||document.hidden||!this._visible){this._schedule();return;}
    clearTimeout(this._timer);this._finish();const motionId=this._motionId;this._turn++;
    const detail=this._turn%3!==0&&this._current.length>1;
    let regions;
    if(detail){
      // Occasionally turn only one photograph while the rest of the mosaic stays still.
      const tile=this._current[Math.floor((this._turn-1)/3)%this._current.length];
      this._next=this._compose(this._current.map(p=>p.rect),this._current.filter(p=>p!==tile));
      regions=[tile.rect];
    }else{
      this._next=this._chooseLayout();
      const keep=this._current.filter(p=>this._next.some(n=>sameRect(n.rect,p.rect)&&n.photo===p.photo));
      const changed=this._current.filter(p=>!keep.includes(p));
      const added=this._next.filter(p=>!keep.includes(p));
      if(!changed.length){
        regions=[[0,0,1,1]];
      }else{
        const all=[...changed,...added].map(p=>p.rect);
        const x=Math.min(...all.map(r=>r[0])),y=Math.min(...all.map(r=>r[1]));
        const w=Math.max(...all.map(r=>r[0]+r[2]))-x,h=Math.max(...all.map(r=>r[1]+r[3]))-y;
        regions=[[x,y,w,h]];
        // Two hinged leaves can turn independently when both layouts share a seam.
        // Never split a photograph merely to manufacture a checkerboard animation.
        const full=sameRect(regions[0],[0,0,1,1]);
        const clearCut=(axis)=>[...this._current,...this._next].every(p=>p.rect[axis]+p.rect[axis+2]<=.50001||p.rect[axis]>=.49999);
        if(full&&clearCut(1))regions=[[0,0,1,.5],[0,.5,1,.5]];
        else if(full&&clearCut(0))regions=[[0,0,.5,1],[.5,0,.5,1]];
      }
    }
    this._stage.dataset.source='individual-icloud-photos';
    this._stage.dataset.layout=String(this._layoutIndex??0);
    this._stage.dataset.transition=detail?'single-photo':regions.length>1?'staggered-fold':'layout-fold';
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){this._finish();this._schedule();return;}
    const width=this._stage.clientWidth;
    this._stage.style.setProperty('--fold-perspective',`${Math.max(1600,width*2.2)}px`);
    const duration=this._config.duration, stagger=regions.length>1?duration*.14:0;
    try{
      await Promise.all(regions.map((r,i)=>{
        const horizontal=regions.length>1?(r[2]<r[3]):((this._turn%4)<2);
        const reverse=(this._turn+i)%2===0;
        return this._flip(r,horizontal,reverse,i*stagger,duration-i*stagger);
      }));
    }catch{return;}
    if(motionId!==this._motionId)return;
    this._finish();this._prune();this._load();this._schedule();
  }
  _subscribeControls(){
    const connection=this._hass?.connection;
    if(!this.isConnected||!connection?.subscribeEvents||this._controlConnection===connection)return;
    this._unsubscribeControls?.();this._unsubscribeControls=null;this._controlConnection=connection;
    const generation=this._controlGeneration=(this._controlGeneration||0)+1;
    connection.subscribeEvents(event=>{
      const data=event.data;
      if(this._api()!=='minimal_slideshow'||this._config?.images?.length||data?.entry_id!==(this._config?.album_id||this._resolvedAlbum))return;
      if(!['next','previous','restart'].includes(data.command))return;
      this._commandQueue=this._commandQueue.catch(()=>{}).then(()=>this._command(data.command)).catch(()=>{this._schedule();});
    },'minimal_slideshow_command').then(unsubscribe=>{
      if(generation!==this._controlGeneration||!this.isConnected){unsubscribe();return;}this._unsubscribeControls=unsubscribe;
    }).catch(()=>{if(generation===this._controlGeneration)this._controlConnection=null;});
  }
  _remember(){
    if(!this._current?.length||this._restoringHistory)return;
    const current=this._config.effect==='floating'?[this._current.at(-1)]:this._current;
    const frame=current.map(p=>({id:p.photo.id,rect:p.rect.slice()}));
    if(JSON.stringify(frame)===JSON.stringify(this._history[this._historyIndex]))return;
    this._history.splice(this._historyIndex+1);this._history.push(frame);
    if(this._history.length>30)this._history.shift();this._historyIndex=this._history.length-1;
  }
  async _historyPhoto(id){
    const cached=this._photos.find(p=>p.id===id);if(cached)return cached;
    const serial=this._serial;let url;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
    try{
      const direct=this._catalog?.get(id)?.url;
      const response=direct?await fetch(new URL(direct,location.origin),{signal:controller.signal,credentials:'same-origin'}):await this._hass.fetchWithAuth(`/api/${this._api()}/image/${encodeURIComponent(id)}${this._config.album_id?'?entry_id='+encodeURIComponent(this._config.album_id):''}`,{signal:controller.signal});
      if(!response.ok)throw new Error('Photo unavailable');
      const blob=await response.blob();url=URL.createObjectURL(blob);const img=new Image();img.src=url;await img.decode();
      if(serial!==this._serial||!this.isConnected)throw new Error('Cancelled');
      const photo={id,blob,url,width:img.naturalWidth,height:img.naturalHeight,lastShown:this._turn};this._photos.push(photo);url=null;return photo;
    }finally{clearTimeout(timeout);if(url)URL.revokeObjectURL(url);}
  }
  async _restoreHistory(index){
    const frame=this._history[index];if(!frame)return;
    const serial=this._serial;const photos=[];
    for(const tile of frame)photos.push({rect:tile.rect.slice(),photo:await this._historyPhoto(tile.id)});
    if(serial!==this._serial)return;
    this._stopAmbient?.();this._historyIndex=index;this._current=photos;
    this._scene.replaceChildren(this._render(photos));this._prune();this._schedule();
  }
  async _command(command){
    if(!this.isConnected||!this._config)return;
    this._finish();clearTimeout(this._timer);
    if(command==='restart'){
      this._cursor=0;this._saveQueue();this._stopAmbient?.();this._turn=0;this._history=[];this._historyIndex=-1;
      const firstId=this._queue?.[0];
      try{if(firstId){const photo=await this._historyPhoto(firstId);this._photos=[photo,...this._photos.filter(item=>item!==photo)];for(const item of this._photos)delete item.lastShown;const first=this._initialComposition();if(first){this._current=first;for(const tile of first)tile.photo.lastShown=0;this._scene.replaceChildren(this._render(first));this._status.hidden=true;}}}finally{this._remember();this._schedule();this._load();}return;
    }
    if(command==='previous'){await this._restoreHistory(Math.max(0,this._historyIndex-1));return;}
    if(this._historyIndex<this._history.length-1){await this._restoreHistory(this._historyIndex+1);return;}
    await this._transition();
  }
  _hasAction(gesture){return !!this._config?.[`${gesture}_action`]&&this._config[`${gesture}_action`].action!=='none';}
  async _bindActions(){
    const active=['tap','hold','double_tap'].some(gesture=>this._hasAction(gesture));
    this._stage.tabIndex=active?0:-1;this._stage.style.cursor=active?'pointer':'default';
    if(active)this._stage.setAttribute('role','button');else this._stage.removeAttribute('role');
    if(!this.isConnected)return;
    try{
      if(!customElements.get('action-handler'))await nativeButtonCard();
      if(!this.isConnected||!customElements.get('action-handler'))return;
      let handler=document.body.querySelector('action-handler');
      if(!handler){handler=document.createElement('action-handler');document.body.append(handler);}
      this._actionHandler=handler;
      handler.bind(this._stage,{hasHold:this._hasAction('hold'),hasDoubleClick:this._hasAction('double_tap'),disabled:!['tap','hold','double_tap'].some(gesture=>this._hasAction(gesture))});
    }catch(error){console.warn('Minimal Photo Slideshow: unable to load Home Assistant action controls.',error);}
  }
  _handleAction(gesture){
    if(!this.isConnected||this.editMode||new URLSearchParams(location.search).has('edit')||!['tap','hold','double_tap'].includes(gesture)||!this._hasAction(gesture))return;
    this.dispatchEvent(new CustomEvent('hass-action',{detail:{config:this._config,action:gesture},bubbles:true,composed:true}));
  }

  getCardSize(){return 8;}
  static getStubConfig(){return {source:'origami_photos',interval:8,duration:1800};}
}

// Minimal Photo Slideshow. Independent browser renderers inspired by Apple Photos.
const EFFECTS={origami:'Origami',sliding_panels:'Sliding Panels',shifting_tiles:'Shifting Tiles',floating:'Floating',ken_burns:'Ken Burns',fade:'Standard Fade'};
const FONTS={system:'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',sans:'Arial, Helvetica, sans-serif',rounded:'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif',serif:'Georgia, "Times New Roman", serif',mono:'ui-monospace, "Courier New", monospace'};
export class MinimalPhotoSlideshow extends OrigamiAlbumCard {
  constructor(){
    super();this._ambient=[];this._floating=[];
    const css=document.createElement('style');css.textContent=`
      ha-card{background:#050505}.stage{background:#050505}
      .clock{display:flex;flex-direction:column;position:absolute;z-index:10;pointer-events:none;color:white;padding:clamp(20px,3.2vw,54px);line-height:1;text-shadow:0 2px 22px #0009;max-width:90%;box-sizing:border-box}
      .clock[hidden]{display:none}.clock time{display:block;width:max-content;max-width:100%;text-align:inherit;letter-spacing:-.055em;font-weight:200;font-variant-numeric:tabular-nums;white-space:nowrap}
      .clock .date{width:max-content;max-width:100%;text-align:inherit;font-size:clamp(14px,1.7vw,26px);font-weight:400;letter-spacing:0;margin-top:12px;line-height:1.3}
      .float-photo{position:absolute;object-fit:contain;box-shadow:0 10px 38px #0008;will-change:transform;pointer-events:none}
      .stage[data-effect="sliding_panels"] .photo,.stage[data-effect="shifting_tiles"] .photo{box-sizing:border-box;outline:2px solid #050505;outline-offset:-2px}
      .stage[data-effect="ken_burns"] .photo img{object-fit:cover!important;will-change:transform}
      .masked-panel{position:absolute;overflow:hidden;contain:paint;background:#050505;box-sizing:border-box;outline:2px solid #050505;outline-offset:-2px;will-change:clip-path}
      .masked-panel img{width:100%;height:100%;object-fit:cover;object-position:50% 45%}
    `;this.shadowRoot.append(css);
    this._clock=document.createElement('div');this._clock.className='clock';this._clock.innerHTML='<time></time><div class="date"></div>';this.shadowRoot.querySelector('ha-card').append(this._clock);
  }
  setConfig(config){
    const effect=EFFECTS[config.effect]?config.effect:'origami';
    const changed=this._config?.effect!==effect;
    if(changed){this._stopAmbient();this._finish();this._current=null;this._scene.replaceChildren();}
    super.setConfig({...config,effect,clock:!!config.clock,clock_position:config.clock_position||'bottom-left',clock_font:config.clock_font||'system',clock_size:clamp(config.clock_size||112,40,240),show_date:!!config.show_date});
    this._stage.dataset.effect=effect;this._updateClock();this._clockTimer();
    if(!this._current&&this._photos.length){this._current=this._initialComposition();if(this._current){this._scene.replaceChildren(this._render(this._current));this._remember();}}
    this._beginAmbient();
  }
  set hass(hass){super.hass=hass;this._beginAmbient();}
  get hass(){return this._hass;}
  connectedCallback(){super.connectedCallback();this._clockTimer();this._beginAmbient();}
  disconnectedCallback(){clearInterval(this._clockTick);this._stopAmbient();super.disconnectedCallback();}
  _clockTimer(){clearInterval(this._clockTick);if(this.isConnected&&this._config?.clock)this._clockTick=setInterval(()=>this._updateClock(),1000);}
  _updateClock(){
    if(!this._clock||!this._config)return;const c=this._config;
    this._clock.hidden=!c.clock;if(!c.clock)return;
    const position=['bottom-left','top-left','bottom-right','top-right'].includes(c.clock_position)?c.clock_position:'bottom-left';
    Object.assign(this._clock.style,{top:position.startsWith('top')?'0':'auto',bottom:position.startsWith('bottom')?'0':'auto',left:position.endsWith('left')?'0':'auto',right:position.endsWith('right')?'0':'auto',textAlign:position.endsWith('right')?'right':'left',alignItems:position.endsWith('right')?'flex-end':'flex-start',fontFamily:c.clock_font==='custom'?(c.custom_font||FONTS.system):(FONTS[c.clock_font]||FONTS.system)});
    const now=new Date(),locale=this._hass?.locale?.language||navigator.language;
    const zone=this._hass?.config?.time_zone;const options={hour:'numeric',minute:'2-digit',...(zone?{timeZone:zone}:{})};if(c.time_format==='12')options.hour12=true;if(c.time_format==='24')options.hour12=false;
    const time=this._clock.querySelector('time');time.style.fontSize=`clamp(40px,${c.clock_size/10}vw,${c.clock_size}px)`;time.textContent=new Intl.DateTimeFormat(locale,options).format(now);time.dateTime=now.toISOString();
    const date=this._clock.querySelector('.date');date.hidden=!c.show_date;date.textContent=new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long',...(zone?{timeZone:zone}:{})}).format(now);
  }
  _stopAmbient(){
    for(const a of this._ambient||[])a.cancel();this._ambient=[];
    for(const item of this._floating||[]){item.animation?.cancel();item.el.remove();}this._floating=[];
    this._ambientNode=null;
  }
  _beginAmbient(){
    if(!this.isConnected||!this._visible||document.hidden||!this._current||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    if(this._config.effect==='floating'&&!this._floating.length&&this._photos.length>=4){this._float();return;}
    if(this._config.effect==='ken_burns'){
      const node=this._scene.firstElementChild;if(!node||this._ambientNode===node)return;
      for(const a of this._ambient)a.cancel();this._ambient=[];this._ambientNode=node;
      const img=node.querySelector('img');if(!img)return;
      const reverse=this._turn%2===0;const a='scale(1.04) translate(-1%, -1%)',b='scale(1.20) translate(2%, 1.5%)';
      this._ambient.push(img.animate([{transform:reverse?a:b},{transform:reverse?b:a}],{duration:this._config.interval*1000+this._config.duration*2,easing:'linear',fill:'both'}));
    }
  }
  async _load(){await super._load();this._beginAmbient();}
  _finish(){super._finish();if(this._floating?.length){this._stopAmbient();}this._beginAmbient?.();}
  async _transition(){
    const effect=this._config?.effect||'origami';
    if(effect==='origami')return super._transition();
    if(!this._current||this._photos.length<2||document.hidden||!this._visible){this._schedule();return;}
    if(effect==='shifting_tiles'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)return this._shiftTiles();
    if(effect==='floating'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){this._float();this._prune();this._load();this._schedule();return;}
    clearTimeout(this._timer);this._finish();const motionId=this._motionId;this._turn++;
    if(effect==='fade'||effect==='ken_burns'||effect==='floating')this._next=this._compose(layouts[0]);
    else this._next=this._panelComposition(effect);
    this._stage.dataset.transition=effect;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){this._finish();this._schedule();return;}
    try{
      if(effect==='sliding_panels'||effect==='shifting_tiles')await this._morph(effect);
      else{
        const incoming=this._render(this._next);this._scene.append(incoming);
        if(effect==='ken_burns'){
          const img=incoming.querySelector('img');const a=img.animate([{transform:'scale(1.04) translate(1%,0)'},{transform:'scale(1.20) translate(-1%,-1%)'}],{duration:this._config.interval*1000+this._config.duration*2,fill:'both',easing:'linear'});this._ambient.push(a);
        }
        const a=incoming.animate([{opacity:0},{opacity:1}],{duration:this._config.duration,easing:'ease-in-out',fill:'both'});this._animations.push(a);await a.finished;
        // Keep this exact node so Ken Burns movement continues through the dissolve.
        if(motionId!==this._motionId)return;
        this._scene.firstElementChild!==incoming&&this._scene.firstElementChild.remove();
        this._current=this._next;this._next=null;for(const p of this._current)p.photo.lastShown=this._turn;this._remember();
        for(const a of this._animations)a.cancel();this._animations=[];this._ambientNode=incoming;
        this._prune();this._load();this._schedule();return;
      }
    }catch{return;}
    if(motionId!==this._motionId)return;this._finish();this._prune();this._load();this._schedule();
  }
  _panelComposition(effect){
    const current=this._current;
    // Most beats refresh one masked cell; some refresh two. Keep the rest still.
    if(current.length>1&&this._turn%4!==0){
      const count=this._turn%4===3?Math.min(2,current.length-1):1;
      const start=Math.floor(this._turn/2)%current.length;
      const changing=new Set(Array.from({length:count},(_,i)=>(start+i)%current.length));
      const keep=current.filter((_,i)=>!changing.has(i));
      return this._compose(current.map(p=>p.rect),keep);
    }
    if(effect==='shifting_tiles'&&this._photos.length>=4)return this._tileComposition();
    const sequence=[10,11,5,3,12,6,4,2];
    const rectangles=layouts[sequence[Math.floor(this._turn/4)%sequence.length]];
    if(rectangles.length>this._photos.length)return this._chooseLayout();
    const keep=current.filter(p=>rectangles.some(r=>sameRect(r,p.rect))).slice(0,rectangles.length-1);
    return this._compose(rectangles,keep);
  }
  _tileComposition(){return this._gridTiles();}
  _maskPlan(){
    const stable=this._current.filter(old=>this._next.some(n=>n.photo===old.photo&&sameRect(n.rect,old.rect)));
    const old=this._current.filter(p=>!stable.includes(p));
    const next=this._next.filter(p=>!stable.some(o=>o.photo===p.photo&&sameRect(o.rect,p.rect)));
    const sameCells=old.length===next.length&&old.every(o=>next.some(n=>sameRect(o.rect,n.rect)));
    return {stable,old,next,sameCells};
  }
  async _morph(effect){
    // Images never translate between cells and never receive non-uniform scale.
    // Every moving edge is a clip on a stationary, aspect-preserving photograph.
    const {stable,old,next,sameCells}=this._maskPlan(),d=this._config.duration;
    this._stage.dataset.transition=sameCells?(next.length===1?'single-photo':'photo-group'):'masked-layout';
    const full='inset(0% 0% 0% 0%)';
    const shut=i=>['inset(0% 100% 0% 0%)','inset(100% 0% 0% 0%)','inset(0% 0% 0% 100%)','inset(0% 0% 100% 0%)'][(this._turn+i)%4];
    const make=({photo,rect:r})=>{
      const node=document.createElement('div');node.className='masked-panel';
      const img=document.createElement('img');img.src=photo.url;img.alt='';node.append(img);
      Object.assign(node.style,{left:`${r[0]*100}%`,top:`${r[1]*100}%`,width:`${r[2]*100}%`,height:`${r[3]*100}%`});
      this._folds.append(node);return node;
    };
    const animate=(node,frames,duration,delay=0)=>{const a=node.animate(frames,{duration,delay,easing:'cubic-bezier(.45,0,.2,1)',fill:'both'});this._animations.push(a);return a.finished;};
    if(sameCells){
      // A wipe stays inside its own cell, on top of that cell's previous image.
      await Promise.all(next.map((tile,i)=>animate(make(tile),[{clipPath:shut(i)},{clipPath:full}],d)));
      return;
    }
    // Different partitions cannot be linearly morphed without intersecting.
    // Close the changed masks, then open their new partition; common cells stay.
    this._scene.replaceChildren(this._render(stable));
    const outgoing=old.map(make),incoming=next.map(make);
    incoming.forEach((node,i)=>node.style.clipPath=shut(i));
    const close=outgoing.map((node,i)=>animate(node,[{clipPath:full},{clipPath:shut(i)}],d*.48));
    const open=incoming.map((node,i)=>animate(node,[{clipPath:shut(i)},{clipPath:full}],d*.52,d*.48));
    await Promise.all([...close,...open]);
  }
  _tileLayouts(){
    const W=Math.max(1,this._stage.clientWidth),H=Math.max(1,this._stage.clientHeight);
    const portrait=H>W,ratio=portrait?H/W:W/H;
    // Square cells are sized in screen pixels, with the remaining area assigned
    // to larger photographs. Transpose the compositions for portrait screens.
    const square=rows=>1/(ratio*rows),s3=square(3),s4=square(4);
    const column=(x,rows)=>Array.from({length:rows},(_,y)=>[x,y/rows,square(rows),1/rows]);
    const strip=(y,rows)=>{
      const w=square(rows),cols=Math.max(2,Math.floor(1/w));
      return Array.from({length:cols},(_,x)=>[x*w,y,w+(x===cols-1?1-cols*w:0),1/rows]);
    };
    const twoColumns=[...column(0,3),...column(s3,3)];
    const largeWidth=1-2*s3;
    const choices=[
      [[0,0,(1-s3)/2,1],[(1-s3)/2,0,(1-s3)/2,1],...column(1-s3,3)],
      [...twoColumns,[2*s3,0,largeWidth,1]],
      [[0,0,largeWidth,2/3],[largeWidth,0,s3,1/3],[largeWidth+s3,0,s3,1/3],[largeWidth,1/3,s3,1/3],[largeWidth+s3,1/3,s3,1/3],...strip(2/3,3)],
      [[0,0,1-s4,1],...column(1-s4,4)],
      [...strip(0,2),...strip(.5,2)],
      [[0,0,.4,2/3],[.4,0,.6,2/3],...strip(2/3,3)]
    ];
    return choices.filter(rects=>rects.length<=Math.min(12,this._photos.length)&&rects.every(r=>r[2]>.01)).map(rects=>rects.map(([x,y,w,h])=>portrait?[y,x,h,w]:[x,y,w,h]));
  }
  _gridTiles(){
    const choices=this._tileLayouts();
    if(!choices.length)return this._compose(layouts[6]);
    return this._compose(choices[Math.floor(this._turn/6)%choices.length]);
  }
  async _shiftTileLayout(motionId){
    this._next=this._gridTiles();this._stage.dataset.transition='tile-layout-slide-bounce';
    const group=this._render(this._current);this._scene.replaceChildren(group);
    const d=this._config.duration;
    const animate=(node,frames,options)=>{const a=node.animate(frames,{...options,fill:'both'});this._animations.push(a);return a.finished;};
    try{
      await Promise.all([...group.children].map(node=>animate(node,[{transform:'scale(1)',opacity:1},{transform:'scale(.02)',opacity:0}],{duration:d*.28,easing:'ease-in'})));
      if(motionId!==this._motionId)return;
      const incoming=this._render(this._next);this._scene.replaceChildren(incoming);
      const axis=Math.floor(this._turn/6)%2,sign=Math.floor(this._turn/12)%2?1:-1;
      const distance=(axis?this._stage.clientHeight:this._stage.clientWidth)*sign;
      const transform=n=>axis?`translate(0,${n}px)`:`translate(${n}px,0)`;
      await animate(incoming,[{transform:transform(distance),offset:0},{transform:transform(distance*.04),offset:.68},{transform:transform(0),offset:.8},{transform:transform(distance*.025),offset:.9},{transform:transform(0),offset:1}],{duration:d*.72,easing:'ease-out'});
    }catch{return;}
    if(motionId!==this._motionId)return;
    this._finish();this._prune();this._load();this._schedule();
  }
  _tileRepartitionPlan(){
    const tiles=this._current,eps=.00001,candidates=[];
    const edge=rect=>rect[0]<eps?[0,-1]:rect[0]+rect[2]>1-eps?[0,1]:rect[1]<eps?[1,-1]:rect[1]+rect[3]>1-eps?[1,1]:null;
    const make=(removed,rectangles,region,kind)=>{
      const direction=edge(region);if(!direction||tiles.length-removed.length+rectangles.length>Math.min(12,this._photos.length))return;
      const stable=tiles.filter(tile=>!removed.includes(tile));
      const result=this._assignment([...stable.map(tile=>tile.rect),...rectangles],stable);
      if(result)candidates.push({stable,removed,added:result.composition.slice(stable.length),next:result.composition,region,direction,kind});
    };
    const splitTurn=Math.floor(this._turn/3)%2===1;
    if(splitTurn){
      const minArea=Math.min(...tiles.map(tile=>tile.rect[2]*tile.rect[3]));
      for(const tile of tiles){
        const [x,y,w,h]=tile.rect;if(tiles.length>1&&w*h<minArea*1.4)continue;
        const width=w*this._stage.clientWidth,height=h*this._stage.clientHeight;
        if(Math.floor(this._turn/3)%4===3&&w*h>.18&&Math.max(width/height,height/width)<2.2){
          make([tile],[[x,y,w/2,h/2],[x+w/2,y,w/2,h/2],[x,y+h/2,w/2,h/2],[x+w/2,y+h/2,w/2,h/2]],tile.rect,'one-to-four');
        }
        make([tile],width>=height?[[x,y,w/2,h],[x+w/2,y,w/2,h]]:[[x,y,w,h/2],[x,y+h/2,w,h/2]],tile.rect,'one-to-two');
      }
    }else{
      for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++){
        const a=tiles[i].rect,b=tiles[j].rect;
        for(const axis of [0,1]){
          const other=1-axis;
          if(Math.abs(a[other]-b[other])>eps||Math.abs(a[other+2]-b[other+2])>eps)continue;
          if(Math.abs(a[axis]+a[axis+2]-b[axis])>eps&&Math.abs(b[axis]+b[axis+2]-a[axis])>eps)continue;
          const merged=a.slice();merged[axis]=Math.min(a[axis],b[axis]);merged[axis+2]=a[axis+2]+b[axis+2];
          make([tiles[i],tiles[j]],[merged],merged,'two-to-one');
        }
      }
    }
    // Favor four-cell splits on their turn; otherwise alternate eligible regions.
    const preferred=candidates.filter(plan=>plan.kind==='one-to-four');
    const pool=preferred.length?preferred:candidates;
    return pool.length?pool[Math.floor(this._turn/3)%pool.length]:null;
  }
  async _repartitionTiles(plan,motionId){
    this._next=plan.next;this._stage.dataset.transition=plan.kind;
    const group=this._render(this._current);this._scene.replaceChildren(group);
    const d=this._config.duration;
    const animate=(node,frames,options)=>{const a=node.animate(frames,{...options,fill:'both'});this._animations.push(a);return a.finished;};
    try{
      const outgoing=plan.removed.map(tile=>group.children[this._current.indexOf(tile)]);
      await Promise.all(outgoing.map(node=>animate(node,[{transform:'scale(1)',opacity:1},{transform:'scale(.02)',opacity:0}],{duration:d*.28,easing:'ease-in'})));
      if(motionId!==this._motionId)return;
      outgoing.forEach(node=>node.style.visibility='hidden');
      const incoming=this._render(plan.added);this._scene.append(incoming);
      const [axis,sign]=plan.direction,distance=plan.region[axis+2]*(axis?this._stage.clientHeight:this._stage.clientWidth)*sign;
      const transform=n=>axis?`translate(0,${n}px)`:`translate(${n}px,0)`;
      await animate(incoming,[{transform:transform(distance),offset:0},{transform:transform(distance*.04),offset:.68},{transform:transform(0),offset:.8},{transform:transform(distance*.025),offset:.9},{transform:transform(0),offset:1}],{duration:d*.72,easing:'ease-out'});
    }catch{return;}
    if(motionId!==this._motionId)return;
    this._finish();this._prune();this._load();this._schedule();
  }
  _tileChains(){
    const candidates=[],eps=.00001,tiles=this._current;
    for(let first=0;first<tiles.length;first++)for(const [axis,sign] of [[0,-1],[0,1],[1,-1],[1,1]]){
      const chain=[first];let index=first;
      while(chain.length<=tiles.length){
        const r=tiles[index].rect,edge=sign<0?r[axis]:r[axis]+r[axis+2];
        if(Math.abs(edge-(sign<0?0:1))<eps){candidates.push({chain,axis,sign});break;}
        const next=tiles.findIndex((p,j)=>!chain.includes(j)&&Math.abs(p.rect[axis]-(r[axis]+sign*r[axis+2]))<eps&&Math.abs(p.rect[1-axis]-r[1-axis])<eps&&Math.abs(p.rect[2]-r[2])<eps&&Math.abs(p.rect[3]-r[3])<eps);
        if(next<0)break;chain.push(next);index=next;
      }
    }return candidates;
  }
  async _shiftTiles(){
    clearTimeout(this._timer);this._finish();const motionId=this._motionId;this._turn++;
    const candidates=this._tileChains();
    if(!candidates.length)return this._shiftTileLayout(motionId);
    const repartition=this._turn%3===0?this._tileRepartitionPlan():null;
    if(repartition)return this._repartitionTiles(repartition,motionId);
    const areas=this._current.map(tile=>tile.rect[2]*tile.rect[3]),largest=Math.max(...areas),smallest=Math.min(...areas);
    const heroes=candidates.filter(path=>path.chain.length===1&&areas[path.chain[0]]>=largest-.00001);
    const chains=candidates.filter(path=>path.chain.length>1);
    const pool=this._turn%3===1&&largest>smallest*1.4&&heroes.length?heroes:chains.length?chains:candidates;
    const first=pool[this._turn%pool.length],paths=[first];
    if(this._turn%3===0){const second=candidates.find(p=>p.axis===first.axis&&p.sign===first.sign&&!p.chain.some(i=>first.chain.includes(i)));if(second)paths.push(second);}
    const before=this._current,thisNext=before.map(p=>({photo:p.photo,rect:p.rect.slice()}));
    const fresh=this._photos.filter(p=>!before.some(t=>t.photo===p)).sort((a,b)=>(a.lastShown??-999)-(b.lastShown??-999));
    this._next=thisNext;this._stage.dataset.transition='scale-away-slide-bounce';
    const group=this._render(before);this._scene.replaceChildren(group);const nodes=[...group.children];
    const d=this._config.duration;
    const animate=(node,frames,options)=>{const a=node.animate(frames,{...options,fill:'both'});this._animations.push(a);return a.finished;};
    try{
      // Only the departing tiles shrink. Every remaining photograph stays rigid.
      await Promise.all(paths.map(p=>animate(nodes[p.chain[0]],[{transform:'scale(1)',opacity:1},{transform:'scale(.02)',opacity:0}],{duration:d*.28,easing:'cubic-bezier(.6,0,.9,.5)'})));
      if(motionId!==this._motionId)return;
      const moving=[];
      for(const path of paths){
        const {chain,axis,sign}=path;
        nodes[chain[0]].style.visibility='hidden';
        const edge=before[chain.at(-1)],replacement=fresh.shift()||before[chain[0]].photo;
        for(let i=0;i<chain.length-1;i++)thisNext[chain[i]].photo=before[chain[i+1]].photo;
        thisNext[chain.at(-1)].photo=replacement;
        const one=this._render([{rect:edge.rect,photo:replacement}]).firstElementChild;
        group.append(one);
        const pitch=edge.rect[axis+2]*(axis===0?this._stage.clientWidth:this._stage.clientHeight)*sign;
        const vector=n=>axis===0?`translate(${n}px,0)`:`translate(0,${n}px)`;
        // One shared travel curve keeps neighbors joined; a bounded rebound
        // avoids crossing the stationary row/column beyond the empty cell.
        const move=(node,from,to)=>animate(node,[{transform:vector(from),offset:0},{transform:vector(from+(to-from)*.96),offset:.68},{transform:vector(to),offset:.8},{transform:vector(from+(to-from)*.975),offset:.9},{transform:vector(to),offset:1}],{duration:d*.72,easing:'ease-out'});
        for(let i=1;i<chain.length;i++)moving.push(move(nodes[chain[i]],0,-pitch));
        moving.push(move(one,pitch,0));
      }
      await Promise.all(moving);
    }catch{return;}
    if(motionId!==this._motionId)return;
    this._finish();this._prune();this._load();this._schedule();
    // Pan the crop inside one settled tile while its external edges stay fixed.
    const index=this._turn%this._current.length,img=this._scene.children[0]?.children[index]?.querySelector('img');
    if(img){const photo=this._current[index].photo,from=photo.position||'50% 45%',to=this._turn%2?'58% 50%':'42% 45%';photo.position=to;
      img.style.objectPosition=to;this._ambient.push(img.animate([{objectPosition:from},{objectPosition:to}],{duration:this._config.interval*900,easing:'ease-in-out',fill:'both'}));}
  }
  _float(){
    if(!this._floating.length){this._scene.replaceChildren();this._current=[];for(let i=0;i<3;i++)this._spawnFloat(i,true);}
    else this._spawnFloat(this._turn%3,false);
    this._turn++;this._stage.dataset.transition='floating';this._remember();
  }
  _spawnFloat(lane,initial){
    const inUse=new Set(this._floating.map(i=>i.photo));const photo=this._photos.filter(p=>!inUse.has(p)).sort((a,b)=>(a.lastShown??-999)-(b.lastShown??-999))[0];if(!photo)return;
    photo.lastShown=this._turn;
    const W=this._stage.clientWidth,H=this._stage.clientHeight;
    let w=W*(.31+lane*.035),h=w*photo.height/photo.width;if(h>H*.72){h=H*.72;w=h*photo.width/photo.height;}
    const x=Math.max(0,Math.min(W-w,(lane+.5)*W/3-w/2));const drift=(lane-1)*W*.055;
    const el=document.createElement('img');el.className='float-photo';el.src=photo.url;el.alt='';Object.assign(el.style,{left:`${x}px`,top:'0',width:`${w}px`,height:`${h}px`,zIndex:String(lane)});this._scene.append(el);
    const duration=this._config.interval*1000*3.6;
    const animation=el.animate([{transform:`translate(0,${H+20}px) scale(.9)`,opacity:0},{opacity:1,offset:.08},{opacity:1,offset:.92},{transform:`translate(${drift}px,${-h-30}px) scale(1.08)`,opacity:0}],{duration,easing:'linear',fill:'both'});
    if(initial)animation.currentTime=duration*(.2+lane*.24);
    const item={photo,el,animation};this._floating.push(item);this._current=this._floating.map(i=>({rect:[0,0,1,1],photo:i.photo}));
    animation.finished.then(()=>{el.remove();this._floating=this._floating.filter(i=>i!==item);this._current=this._floating.map(i=>({rect:[0,0,1,1],photo:i.photo}));this._prune();}).catch(()=>{});
  }
  static getConfigElement(){return document.createElement('minimal-photo-slideshow-editor');}
  static getStubConfig(){return {source:'minimal_slideshow',effect:'origami',interval:8,duration:1800,clock:false,clock_position:'bottom-left',clock_font:'system',clock_size:112,show_date:false,time_format:'auto'};}
}

export class MinimalPhotoSlideshowEditor extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});}
  setConfig(config){this._config={...MinimalPhotoSlideshow.getStubConfig(),...normalizeActions(config)};this._render();}
  set hass(hass){
    this._hass=hass;if(this._form)this._form.hass=hass;if(this._sourceForm)this._sourceForm.hass=hass;
    if(!this._albumRequest){this._albumRequest=true;hass.callApi('GET','minimal_slideshow/albums').then(result=>{this._albums=result.albums||[];this._render();}).catch(()=>{this._albums=[];this._render();});}
    this._render();
  }
  connectedCallback(){this._render();}
  async _render(){
    if(!this._config||!this.isConnected)return;
    if(!customElements.get('ha-form')){
      if(this._formLoading)return;
      this._formLoading=true;
      try{const Card=await nativeButtonCard();await Card?.getConfigElement?.();}
      catch(error){console.warn('Minimal Photo Slideshow: unable to load Home Assistant form controls.',error);}
      finally{this._formLoading=false;}
      if(!this.isConnected||!customElements.get('ha-form'))return;
    }
    if(!this._form){
      this.shadowRoot.innerHTML='<style>:host{display:block}ha-form{display:block}p{font-size:var(--ha-font-size-s,14px);color:var(--secondary-text-color);margin:8px 0 20px}a{color:var(--primary-color)}</style>';
      this._sourceForm=document.createElement('ha-form');this._sourceHelp=document.createElement('p');
      this._form=document.createElement('ha-form');this.shadowRoot.append(this._sourceForm,this._sourceHelp,this._form);
      const changed=event=>{
        event.stopPropagation();
        // Preserve object-style image entries and unrelated YAML keys.
        const {image_urls,...data}=event.detail.value;
        if(image_urls!==undefined&&image_urls!==this._imageText)data.images=image_urls.split('\n').map(url=>url.trim()).filter(Boolean);
        this._config=normalizeActions({...this._config,...data});
        this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:{...this._config}},bubbles:true,composed:true}));
        this._render();
      };
      this._sourceForm.addEventListener('value-changed',changed);this._form.addEventListener('value-changed',changed);
    }
    const c=this._config;
    this._imageText=(c.images||[]).map(photo=>typeof photo==='string'?photo:photo.url).join('\n');
    const select=options=>({select:{mode:'dropdown',options:Object.entries(options).map(([value,label])=>({value,label}))}});
    const number=(min,max,step=1)=>({number:{min,max,step,mode:'box'}});
    const field=(name,selector)=>({name,selector});
    const action= name=>({name,selector:{ui_action:{default_action:'none'}},context:{entity_id:'entity'}});
    const albums=Object.fromEntries((this._albums||[]).map(album=>[album.entry_id,album.title]));
    if(c.album_id&&!albums[c.album_id])albums[c.album_id]='Unavailable source — choose another';
    this._sourceForm.schema=c.source==='origami_photos'?[field('source',select({minimal_slideshow:'Minimal Slideshow integration',origami_photos:'Legacy Origami integration'}))]:[field('album_id',select(albums))];
    this._sourceForm.data=c;this._sourceForm.hass=this._hass;this._sourceForm.computeLabel=()=> 'Photo source';
    this._sourceHelp.replaceChildren();
    if(this._albums?.length===0)this._sourceHelp.append('Please install and set up the Minimal Slideshow integration. ');
    const link=document.createElement('a');link.href='https://github.com/lukevink/minimal-slideshow-integration#install-with-hacs';link.target='_blank';link.rel='noopener noreferrer';link.textContent='Install and set up the integration';this._sourceHelp.append(link);
    this._form.schema=[
      field('image_urls',{text:{multiline:true}}),field('height',{text:{}}),field('effect',select(EFFECTS)),
      {type:'grid',name:'',schema:[field('interval',number(2,120)),field('duration',number(250,6000,50))]},
      {type:'expandable',name:'interactions',flatten:true,schema:[field('entity',{entity:{}}),action('tap_action'),action('hold_action'),action('double_tap_action')]},
      field('clock',{boolean:{}}),
      ...(c.clock?[
        {type:'grid',name:'',schema:[field('clock_position',select({'bottom-left':'Bottom left','top-left':'Top left','bottom-right':'Bottom right','top-right':'Top right'})),field('clock_font',select({system:'System · light',sans:'Sans serif',rounded:'Rounded',serif:'Serif',mono:'Monospace',custom:'Custom font'}))]},
        ...(c.clock_font==='custom'?[field('custom_font',{text:{}})]:[]),
        {type:'grid',name:'',schema:[field('clock_size',number(40,240,4)),field('time_format',select({auto:'Automatic','24':'24-hour','12':'12-hour'}))]},field('show_date',{boolean:{}})
      ]:[])
    ];
    const labels={source:'Photo source',album_id:'Photo source',image_urls:'Image URLs (optional, one per line)',height:'Card height',effect:'Slideshow style',interval:'Photo hold / movement pace (seconds)',duration:'Transition duration (milliseconds)',interactions:'Interactions',entity:'Entity (optional, for Toggle or More info)',tap_action:'Tap action',hold_action:'Hold action',double_tap_action:'Double-tap action',clock:'Show clock',clock_position:'Clock position',clock_font:'Clock font',custom_font:'Installed font family',clock_size:'Clock size (pixels)',time_format:'Time format',show_date:'Show date underneath'};
    this._form.computeLabel=schema=>labels[schema.name]||schema.name;
    this._form.computeHelper=schema=>({height:'Use 100% for a container with a defined height, 100dvh for full screen, or a fixed value such as 500px.',image_urls:'Overrides the integration photo source.'}[schema.name]);
    this._form.hass=this._hass;this._form.data={...c,image_urls:this._imageText};
  }
}
if(!customElements.get('minimal-photo-slideshow-editor'))customElements.define('minimal-photo-slideshow-editor',MinimalPhotoSlideshowEditor);
if(!customElements.get('minimal-photo-slideshow'))customElements.define('minimal-photo-slideshow',MinimalPhotoSlideshow);
// Compatibility for dashboards still using the old type during migration.
if(!customElements.get('origami-album-card'))customElements.define('origami-album-card',class extends MinimalPhotoSlideshow{});
window.customCards=window.customCards||[];
window.customCards.push({type:'minimal-photo-slideshow',name:'Minimal Photo Slideshow',description:'iCloud photos, six motion styles, and an optional clock. Configure visually.',preview:true});
