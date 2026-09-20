// Isolated HTTPS integration: no official traffic or production data mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {PrivateChartStore} = require('../dist/private-chart');
const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root, 'data', 'test-visibility-'));
const token = randomUUID();
let child, upstream;
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function main(){
  const cert = require('selfsigned').generate([{name:'commonName',value:'localhost'}],{keySize:2048,days:1,algorithm:'sha256',extensions:[{name:'basicConstraints',cA:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
  const ca = path.join(testRoot,'upstream.crt'); fs.writeFileSync(ca,cert.cert);
  const calls = [];
  upstream=https.createServer({key:cert.private,cert:cert.cert},(req,res)=>{
    const url=new URL(req.url,'https://localhost');
    calls.push({path:url.pathname,conditional:Boolean(req.headers['if-none-match']||req.headers['if-modified-since'])});
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/me'){
      const id={'Bearer viewer-a':111,'Bearer viewer-b':222}[req.headers.authorization];
      if(req.headers.authorization==='Bearer malformed')return res.end('{"id":"111"}');
      res.statusCode=id?200:401;return res.end(JSON.stringify(id?{id}:{error:'invalid'}));
    }
    if(url.pathname==='/chart'){
      res.setHeader('ETag','"official-list"');res.setHeader('Cache-Control','public, max-age=3600');
      return res.end(JSON.stringify({results:[{id:1234,name:'Official'}],count:1}));
    }
    if(url.pathname==='/play/upload'){res.statusCode=418;return res.end('{}')}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const chartsPath=path.join(testRoot,'charts');
  new PrivateChartStore(chartsPath).create({id:-100,name:'Legacy',listed:true},{packageFile:Buffer.from('legacy-test-package')});
  const publicPort=await port(), adminPort=await port();
  child=spawn(process.execPath,[path.join(root,'dist','index.js')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(publicPort),ADMIN_PORT:String(adminPort),MULTIPLAYER_ENABLED:'false',ADMIN_TOKEN:token,INSTANCE_REGISTRY_PATH:path.join(testRoot,'instances.json'),PRIVATE_CHARTS_PATH:chartsPath,PRIVATE_RECORDS_DB_PATH:path.join(testRoot,'records.sqlite'),PRIVATE_RECORDS_PATH:path.join(testRoot,'records.json'),PRIVATE_TOKEN_CAPTURE_PATH:'',PRIVATE_CHART_LISTING:'true',LOG_TO_FILE:'false',DEBUG_BODY:'false',PUBLIC_BASE_URL:'https://charts.test',UPSTREAM_BASE_URL:'https://127.0.0.1:'+upstream.address().port,NODE_EXTRA_CA_CERTS:ca}});
  function request(route,method='GET',body,headers={},admin=false){return new Promise((resolve,reject)=>{
    const data=body===undefined?'':JSON.stringify(body);
    const req=(admin?http:https).request({hostname:'127.0.0.1',port:admin?adminPort:publicPort,path:route,method,rejectUnauthorized:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Admin-Reason':'Regression operation','X-Admin-Confirm':route.includes('/instances/')?route.split('/')[4].split('?')[0]:'delete',...(admin?{Authorization:'Bearer '+token}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks);let value;try{value=JSON.parse(raw)}catch{}resolve({status:res.statusCode,data:value,raw,headers:res.headers})})});req.on('error',reject);req.end(data);
  })}
  const api=(route,method='GET',body)=>request('/api/admin/'+route,method,body,{},true);
  for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error('Isolated gateway exited');try{if((await request('/health')).status===200)break}catch{}await new Promise(r=>setTimeout(r,100))}
  const list=async(auth,query='',headers={})=>{const r=await request('/chart'+query,'GET',undefined,{...(auth?{Authorization:auth}:{}),...headers});assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'private, no-store');assert.match(r.headers.vary,/Authorization/);assert.equal(r.headers.etag,undefined);return r.data};
  const ids=r=>r.results.map(c=>c.id);
  const set=async(mode,userIds=[])=>{assert.equal((await api('instances/group','PATCH',{visibility:{mode,userIds}})).status,200)};
  assert.deepEqual(ids(await list()),[-100,1234]);
  assert.equal((await api('instances','POST',{id:'group',name:'Group'})).status,201);
  assert.equal((await api('charts?instance=group','POST',{id:-200,name:'Targeted',packageBase64:Buffer.from('GROUP-RESOURCE').toString('base64')})).status,201);
  assert.deepEqual((await api('instances')).data.find(i=>i.id==='group').visibility,{mode:'none',userIds:[]});
  assert.deepEqual(ids(await list()),[-100,1234]);
  await set('all');assert.deepEqual(ids(await list()),[-100,-200,1234]);
  await set('users',[111]);assert.deepEqual(ids(await list()),[-100,1234]);
  assert.equal(calls.filter(c=>c.path==='/me').length,0,'Anonymous requests need no identity lookup');
  assert.deepEqual(ids(await list('Bearer viewer-a')),[-100,-200,1234]);
  assert.deepEqual(ids(await list('Bearer viewer-b')),[-100,1234]);
  await set('users',[111,222,111]);assert.deepEqual((await api('instances')).data.find(i=>i.id==='group').visibility.userIds,[111,222]);
  assert.deepEqual(ids(await list('Bearer viewer-b')),[-100,-200,1234]);
  assert.equal(calls.filter(c=>c.path==='/me').length,2,'Verified identity is cached independently of policy');
  for(const auth of [undefined,'Bearer unknown','Bearer malformed'])assert.deepEqual(ids(await list(auth,'?userId=111&instance=group',{'X-User-Id':'111'})),[-100,1234]);
  assert.deepEqual(ids(await list('Bearer viewer-a','?search=Targeted')),[-200,1234]);
  const page2=await list('Bearer viewer-a','?page=2');assert.deepEqual(ids(page2),[1234]);assert.equal(page2.count,3);
  assert.equal((await api('charts/-200?instance=group','PUT',{listed:false})).status,200);
  assert.deepEqual(ids(await list('Bearer viewer-a')),[-100,1234]);
  await api('charts/-200?instance=group','PUT',{listed:true});
  await set('none');assert.deepEqual(ids(await list('Bearer viewer-a','',{'If-None-Match':'"official-list"','If-Modified-Since':'Tue, 01 Jan 2030 00:00:00 GMT'})),[-100,1234]);
  assert.equal(calls.some(c=>c.path==='/chart'&&c.conditional),false);
  const detail=await request('/chart/-200');assert.equal(detail.status,200);assert.equal(detail.data.name,'Targeted');assert.equal(detail.data.file,'https://charts.test/private-charts/-200.pez');
  const resource=await request('/private-charts/-200.pez');assert.equal(resource.status,200);assert.ok(resource.raw.includes(Buffer.from('GROUP-RESOURCE')));
  const score=await request('/play/upload','POST',{chart:-200,token:'invalid'});assert.notEqual(score.status,418);assert.equal(calls.some(c=>c.path==='/play/upload'),false,'Private scores must never reach official upstream');
  const createdRecord=await api('records?instance=group','POST',{player:111,chart:-200,score:987654,accuracy:0.987654,fullCombo:true,perfect:100,good:1,bad:0,miss:0,maxCombo:101,speed:1,mods:0});assert.equal(createdRecord.status,201);
  const recordDetail=await request('/record/'+createdRecord.data.id);assert.equal(recordDetail.status,200);assert.equal(recordDetail.data.id,createdRecord.data.id);assert.equal(recordDetail.data.player,111);assert.equal(recordDetail.data.chart,-200);assert.equal(recordDetail.data.max_combo,101);assert.equal(recordDetail.data.full_combo,true);assert.equal(recordDetail.data.std,0);assert.equal(recordDetail.data.std_score,0);
  const missingRecord=await request('/record/1999999999');assert.equal(missingRecord.status,404);assert.ok(calls.some(c=>c.path==='/record/1999999999'),'Unknown record ids must continue to the official upstream');
  assert.equal((await api('charts?instance=group','POST',{id:-100,packageBase64:Buffer.from('duplicate').toString('base64')})).status,409);
  const autoA=await api('charts','POST',{packageBase64:Buffer.from('auto-a').toString('base64')});const autoB=await api('charts?instance=group','POST',{packageBase64:Buffer.from('auto-b').toString('base64')});assert.equal(autoA.status,201);assert.equal(autoB.status,201);assert.notEqual(autoA.data.id,autoB.data.id);
  for(const visibility of [{mode:'oops'},{mode:'users',userIds:[]},{mode:'users',userIds:['111']},{mode:'users',userIds:[-1]},{mode:'users',userIds:[2147483648]},null])assert.equal((await api('instances/group','PATCH',{visibility})).status,422);
  await set('all');await api('instances/group','PATCH',{enabled:false});assert.equal(ids(await list()).includes(-200),false);assert.equal((await request('/chart/-200')).status,503);
  console.log('PASS instance visibility: all/single/multiple/none, verified UID, spoofing, cache, search, pagination, resources, private score detail and unique IDs');
}
main().catch(error=>{console.error(String(error.stack||error).replaceAll(token,'[redacted]'));process.exitCode=1}).finally(async()=>{
  if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited}
  if(upstream){upstream.closeAllConnections();await new Promise(r=>upstream.close(r))}
  const resolved=path.resolve(testRoot);if(path.dirname(resolved)===path.join(root,'data')&&path.basename(resolved).startsWith('test-visibility-'))fs.rmSync(resolved,{recursive:true,force:true});
});
