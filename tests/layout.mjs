import assert from 'node:assert/strict';
globalThis.HTMLElement=class {};
globalThis.customElements={get:()=>true};
globalThis.window={customCards:[]};
const {OrigamiAlbumCard}=await import('../minimal-slideshow.js');
const photo=(id,ratio,lastShown)=>({id,url:id,width:ratio*1000,height:1000,lastShown});
function model(photos){const m=Object.create(OrigamiAlbumCard.prototype);Object.assign(m,{_photos:photos,_stage:{clientWidth:1600,clientHeight:1000},_turn:1,_current:[]});return m;}
let m=model([photo('p1',.8),photo('p2',.8)]);
let c=m._chooseLayout();assert.equal(c.length,2);assert.ok(c.every(p=>p.rect[3]===1));
m=model([photo('w1',3.2),photo('w2',3.2)]);c=m._chooseLayout();assert.equal(c.length,2);assert.ok(c.every(p=>p.rect[2]===1));
m=model([photo('portrait',.8),photo('wide1',1.6),photo('wide2',1.6)]);c=m._chooseLayout();assert.equal(c.length,3);assert.equal(c.find(p=>p.photo.id==='portrait').rect[3],1);
m=model([photo('old1',.8,0),photo('old2',.8,0),photo('new1',.8),photo('new2',.8)]);m._current=[{rect:[0,0,.5,1],photo:m._photos[0]},{rect:[.5,0,.5,1],photo:m._photos[1]}];c=m._compose([[0,0,.5,1],[.5,0,.5,1]]);assert.deepEqual(c.map(p=>p.photo.id).sort(),['new1','new2']);
console.log('PASS: portrait layout, panoramic layout, mixed portrait/landscape placement, fresh-photo priority.');

for(const effect of ['origami','sliding_panels','shifting_tiles']){
 m=model([photo('portrait',.67)]);m._config={effect};m._catalog=new Map([['a',1],['b',2]]);
 assert.equal(m._initialComposition(),null);
 m._photos.push(photo('landscape',1.6));
 assert.equal(m._assignment([[0,0,1,1]]).composition[0].photo.id,'landscape');
 m._stage={clientWidth:900,clientHeight:1600};
 assert.equal(m._assignment([[0,0,1,1]]).composition[0].photo.id,'portrait');
 m._photos=[photo('landscape',1.6)];assert.equal(m._initialComposition(),null);
 m._catalog=new Map([['a',1]]);assert.equal(m._initialComposition().length,1);
}
console.log('PASS: all mosaic effects respect screen orientation, startup waits for a pair, and one-photo albums retain a cover fallback.');

const {MinimalPhotoSlideshow}=await import('../minimal-slideshow.js');
const tile=Object.create(MinimalPhotoSlideshow.prototype);
Object.assign(tile,{_photos:Array.from({length:18},(_,i)=>photo('photo'+i,[.7,1.7,1,2][i%4])),_stage:{clientWidth:1600,clientHeight:1000},_turn:4,_config:{effect:'shifting_tiles'},_current:[]});
tile._current=tile._tileComposition();
assert.equal(tile._current.length,9);
for(let turn=1;turn<=3;turn++){
 tile._turn=turn;const next=tile._panelComposition('shifting_tiles');
 const changed=next.filter((p,i)=>p.photo!==tile._current[i].photo).length;
 assert.ok(changed>=1&&changed<=2,'Most beats change only one or two photos');
}
tile._current=tile._gridTiles();
const chains=tile._tileChains();assert.ok(chains.length>0);
for(const {chain,axis,sign} of chains){
 assert.ok(chain.length>=2);assert.equal(new Set(chain).size,chain.length);
 const end=tile._current[chain.at(-1)].rect;
 assert.ok(Math.abs((sign<0?end[axis]:end[axis]+end[axis+2])-(sign<0?0:1))<1e-5);
 for(let i=1;i<chain.length;i++){
  const a=tile._current[chain[i-1]].rect,b=tile._current[chain[i]].rect;
  assert.ok(Math.abs(a[axis]+sign*a[axis+2]-b[axis])<1e-5);
  assert.equal(a[2],b[2]);assert.equal(a[3],b[3]);
 }
}
console.log('PASS: one/two-photo refreshes and contiguous equal-size slide paths terminating at a screen edge.');
