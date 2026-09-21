const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root,'data','test-policy-'));
const password=randomUUID(),bootstrap=randomUUID();
let child;
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function main(){
  const {AdminAccountStore}=require('../dist/admin-accounts'),{can}=require('../dist/admin-policy');
  const migrationPath=path.join(testRoot,'legacy-accounts.sqlite');
  const old=new DatabaseSync(migrationPath);
  old.exec("CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,instance_limit INTEGER NOT NULL,disabled INTEGER NOT NULL,created TEXT NOT NULL,can_review INTEGER NOT NULL,can_manage_instances INTEGER NOT NULL)");
  for(const [id,role,review,manage]of[[1,'admin',0,0],[2,'user',1,0],[3,'user',0,1],[4,'user',0,0]])old.prepare('INSERT INTO admin_users VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'legacy-'+id,'unused','unused',role,7,0,'2026-01-01',review,manage);
  old.close();
  const migrated=new AdminAccountStore(migrationPath),legacyReviewer=migrated.get(2),legacyMaintainer=migrated.get(3),legacyOwner=migrated.get(4);
  assert.equal(migrated.get(1).level,'super');assert.equal(legacyReviewer.level,'manager');assert.equal(legacyReviewer.instanceLimit,7);assert.equal(can(legacyReviewer,'application.read'),true);assert.equal(can(legacyReviewer,'user.suspend'),false);assert.equal(can(legacyReviewer,'instance.read',{id:'legacy',ownerId:4},legacyOwner),false);
  assert.equal(legacyMaintainer.level,'senior');assert.equal(can(legacyMaintainer,'application.read'),false);assert.equal(can(legacyMaintainer,'instance.delete',{id:'legacy',ownerId:4},legacyOwner),true);assert.equal(can(legacyReviewer,'instance.read',{id:'own',ownerId:2},legacyReviewer),true);migrated.close();
  const publicPort=await port(),adminPort=await port();
  const env={...process.env,HOST:'127.0.0.1',PORT:String(publicPort),ADMIN_PORT:String(adminPort),MULTIPLAYER_ENABLED:'false',ADMIN_TOKEN:bootstrap,INSTANCE_REGISTRY_PATH:path.join(testRoot,'instances.json'),PRIVATE_CHARTS_PATH:path.join(testRoot,'charts'),PRIVATE_RECORDS_DB_PATH:path.join(testRoot,'records.sqlite'),PRIVATE_RECORDS_PATH:path.join(testRoot,'records.json'),PRIVATE_TOKEN_CAPTURE_PATH:'',LOG_TO_FILE:'false',DEBUG_BODY:'false',UPSTREAM_BASE_URL:'https://127.0.0.1:1'};
  const start=()=>{child=spawn(process.execPath,[path.join(root,'dist','index.js')],{cwd:root,env,windowsHide:true,stdio:'ignore'})};start();
  function request(route,method='GET',body,actor,headers={}){return new Promise((resolve,reject)=>{const data=body===undefined?'':JSON.stringify(body);const req=https.request({hostname:'127.0.0.1',port:publicPort,path:route,method,rejectUnauthorized:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Admin-Request':'1',...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let payload;try{payload=JSON.parse(text)}catch{}resolve({status:res.statusCode,data:payload,cookies:res.headers['set-cookie']||[]})})});req.on('error',reject);req.end(data)})}
  async function wait(){for(let i=0;i<60;i++){try{if((await request('/health')).status===200)return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error('Test Gateway startup failed')}
  await wait();
  const mutation={'X-Admin-Reason':'Regression policy operation','X-Admin-Confirm':'delete'};
  const api=(route,method='GET',body,actor,headers=mutation)=>request('/api/admin/'+route,method,body,actor,headers);
  async function auth(action,username,extra={}){const r=await api('auth/'+action,'POST',{username,password,...(action==='register'?{application:{reason:'Private rhythm game practice charts.',useType:'personal',socialAccount:'Synthetic fixture account'}}:{}),...extra});assert.ok([200,201].includes(r.status),action);return{user:r.data.user,csrf:r.data.csrf,cookie:r.cookies[0].split(';')[0]}}
  const admin=await auth('setup','policy-owner',{adminToken:bootstrap});
  async function member(name){const u=await auth('register',name);assert.equal((await api('users/'+u.user.id+'/review','POST',{revision:1,decision:'approved'},admin)).status,200);return u}
  const owner=await member('chart-owner'),other=await member('other-owner'),staff=await member('staff-member'),manager=await member('site-manager');
  const allow=(permission,ids=['owner-a'],expiresAt=null)=>({permission,effect:'allow',scope:ids==='all'?'all':'selected',instanceIds:ids==='all'?[]:ids,expiresAt});
  const deny=(permission,ids=['owner-a'])=>({...allow(permission,ids),effect:'deny'});
  async function configure(user,level,assignedInstances=[],grants=[],extra={}){const current=(await api('users','GET',undefined,admin)).data.find(u=>u.id===user.user.id);return api('users/'+user.user.id+'/permissions','PATCH',{level,assignedInstances,grants,revision:current.permissionRevision,reason:'Configure regression member permissions',...extra},admin)}
  for(const [id,actor]of[['owner-a',owner],['other-b',other],['admin-only',admin]])assert.equal((await api('instances','POST',{id,name:id},actor)).status,201);
  const upload=(id,actor=owner)=>api('charts?instance=owner-a','POST',{id,name:'Fixture '+id,packageBase64:Buffer.from('SYNTHETIC-PACKAGE').toString('base64')},actor);
  assert.equal((await upload(-101)).status,201);
  assert.equal((await api('records?instance=owner-a','POST',{player:999,chart:-101,score:900000,accuracy:.9,perfect:9,good:1,bad:0,miss:0,maxCombo:10,fullCombo:true},owner)).status,201);
  assert.equal((await api('dashboard?instance=owner-a','GET',undefined,staff)).status,403);
  assert.equal((await configure(staff,'advanced',['owner-a'])).status,200);
  assert.equal((await api('dashboard?instance=owner-a','GET',undefined,staff)).status,200);
  assert.equal((await api('dashboard?instance=other-b','GET',undefined,staff)).status,403);
  assert.equal((await api('charts/-101?instance=owner-a','PATCH',{name:'Collaborator edit'},staff)).status,200);
  assert.equal((await api('instances/owner-a','PATCH',{visibility:{mode:'all',userIds:[]}},staff)).status,403);
  assert.equal((await api('instances/owner-a','DELETE',{},staff,{'X-Admin-Confirm':'owner-a'})).status,403);
  for(const level of ['ordinary','advanced','senior']){
    assert.equal((await configure(staff,level,['owner-a'])).status,200);
    for(const route of ['users','users/'+other.user.id+'/history'])assert.equal((await api(route,'GET',undefined,staff)).status,403,'Application privacy ceiling');
    assert.equal((await configure(staff,level,[],[allow('application.read','all')])).status,422,'Explicit grants cannot bypass level ceiling');
    assert.equal((await api('users/'+other.user.id+'/review','POST',{revision:1,decision:'approved'},staff)).status,403);
    const audit=await api('audit','GET',undefined,staff);assert.equal(audit.status,200);assert.ok(audit.data.events.every(e=>e.instanceId!==null),'Members must not receive application or permission audit records');
  }
  // Regression: the collection route carries no path-scoped instance, so an id in the body must
  // never select what the audit row snapshots or names as its owner. A rejected creation used to
  // record the named instance with the caller as owner, and auditPage returns a row to its owner,
  // which handed any member another instance's hosts, charts and scores.
  await configure(staff,'ordinary',[]);
  const auditBefore=(await api('audit','GET',undefined,staff)).data.events;
  assert.equal((await api('instances','POST',{id:'owner-a'},staff)).status,409,'An existing instance id must be rejected');
  const auditAfter=(await api('audit','GET',undefined,staff)).data.events;
  assert.equal(auditAfter.length,auditBefore.length,'A rejected collection-path creation must not add a readable audit event');
  assert.ok(auditAfter.every(e=>e.instanceId!=='owner-a'),'A body-supplied instance id must not reach a member audit trail');
  assert.equal((await api('instances','POST',{id:'staff-own',name:'Staff own'},staff)).status,201,'A member may still create their own instance');
  assert.ok((await api('audit','GET',undefined,staff)).data.events.some(e=>e.instanceId==='staff-own'),'A member must still see the audit of the instance they created');
  assert.equal((await configure(staff,'super')).status,422);
  assert.equal((await configure(staff,'constructor')).status,422);
  assert.equal((await configure(staff,'advanced',['missing'])).status,422);
  assert.equal((await configure(staff,'advanced',['owner-a'],[deny('record.read'),deny('chart.publish'),deny('chart.tags')])).status,200);
  const dashboard=await api('dashboard?instance=owner-a','GET',undefined,staff);assert.deepEqual(dashboard.data.records,[]);assert.deepEqual(dashboard.data.players,[]);
  assert.equal((await api('records?instance=owner-a','GET',undefined,staff)).status,403);
  assert.equal((await api('charts/-101?instance=owner-a','PATCH',{name:'Should not change',tags:['blocked']},staff)).status,403);
  assert.equal((await api('charts?instance=owner-a','GET',undefined,owner)).data[0].name,'Collaborator edit','Mixed field request must be atomic');
  const uploaded=await upload(-102,staff);assert.equal(uploaded.status,201);assert.equal(uploaded.data.listed,false,'Upload cannot bypass denied publication');
  assert.equal((await api('charts/-102?instance=owner-a','PATCH',{listed:true},staff)).status,403);
  assert.equal((await api('charts/-102?instance=owner-a','PATCH',{file:'outside'},staff)).status,422);
  assert.equal((await configure(staff,'advanced',['owner-a'],[allow('chart.delete')])).status,200);
  assert.equal((await api('charts/-102?instance=owner-a','DELETE',undefined,staff,{})).status,422,'Foreign deletion requires reason');
  assert.equal((await api('charts/-102?instance=owner-a','DELETE',undefined,staff)).status,200);
  assert.equal((await api('charts/batch-delete?instance=owner-a','POST',{ids:[-101]},staff)).status,403,'Single delete grant cannot use bulk endpoint');
  assert.equal((await configure(staff,'ordinary',[],[allow('instance.read'),allow('chart.read'),deny('chart.download'),allow('chart.download')])).status,200);
  assert.equal((await api('download/-101?instance=owner-a','GET',undefined,staff)).status,403,'Deny wins over overlapping allow');
  const expiry=new Date(Date.now()+1600).toISOString();
  assert.equal((await configure(staff,'ordinary',[],[allow('instance.read',['owner-a'],expiry)])).status,200);
  assert.equal((await api('dashboard?instance=owner-a','GET',undefined,staff)).status,200);
  await new Promise(r=>setTimeout(r,1700));
  assert.equal((await api('dashboard?instance=owner-a','GET',undefined,staff)).status,403,'Expiry applies to existing session');
  assert.equal((await configure(manager,'manager')).status,200);
  const managed=(await api('instances','GET',undefined,manager)).data.map(i=>i.id);assert.ok(managed.includes('owner-a'));assert.ok(!managed.includes('default')&&!managed.includes('admin-only'));
  assert.equal((await api('instances/owner-a','PATCH',{visibility:{mode:'none',userIds:[]}},manager)).status,200);
  assert.equal((await api('instances/owner-a','PATCH',{hosts:['forbidden.example']},manager)).status,403);
  assert.equal((await api('records?instance=owner-a','POST',{player:999,chart:-101},manager)).status,403);
  assert.equal((await api('users/'+owner.user.id,'PATCH',{instanceLimit:100,reason:'Forbidden quota change'},manager)).status,403);
  assert.equal((await api('users/'+staff.user.id+'/permissions','PATCH',{level:'manager'},manager)).status,403);
  for(const target of [manager,admin])assert.equal((await api('users/'+target.user.id,'PATCH',{disabled:true,reason:'Forbidden protected account operation'},manager)).status,403);
  assert.equal((await api('users/'+other.user.id+'/logout','POST',{reason:'End test sessions'},manager)).status,200);
  assert.equal((await api('auth/me','GET',undefined,other)).status,401);
  assert.equal((await api('users/'+other.user.id,'PATCH',{disabled:true,reason:'Suspend test account'},manager)).status,200);
  assert.equal((await api('auth/login','POST',{username:'other-owner',password})).status,401);
  assert.equal((await api('users/'+other.user.id,'PATCH',{disabled:false,reason:'Restore test account'},manager)).status,200);
  assert.equal((await configure(staff,'manager')).status,200);
  assert.equal((await api('users/'+staff.user.id+'/logout','POST',{reason:'Cannot manage peer'},manager)).status,403);
  assert.equal((await configure(staff,'senior',['owner-a'],[allow('instance.delete')])).status,200);
  assert.equal((await api('instances/owner-a','DELETE',undefined,staff)).status,422,'Instance deletion requires matching target confirmation');
  assert.equal((await api('instances/owner-a','DELETE',undefined,staff,{...mutation,'X-Admin-Confirm':'owner-a'})).status,200);
  assert.equal((await api('instances','POST',{id:'owner-a'},owner)).status,201);
  assert.equal((await api('dashboard?instance=owner-a','GET',undefined,staff)).status,403,'Recreated instance must not inherit removed collaboration grants');
  assert.equal((await configure(staff,'advanced',['other-b'],[allow('instance.rename',['other-b'])])).status,200);
  const before=(await api('users','GET',undefined,admin)).data.find(u=>u.id===staff.user.id);
  assert.equal((await api('users/'+staff.user.id+'/permissions','PATCH',{level:'ordinary',revision:before.permissionRevision,reason:'Downgrade with implicit grant removal'},admin)).status,200);
  const after=(await api('users','GET',undefined,admin)).data.find(u=>u.id===staff.user.id);assert.deepEqual(after.grants,[]);assert.deepEqual(after.assignedInstances,[]);assert.equal(after.instanceLimit,2);
  assert.equal((await api('users/'+staff.user.id+'/permissions','PATCH',{level:'manager',revision:before.permissionRevision,reason:'Stale editor'},admin)).status,409);
  const audit=(await api('audit','GET',undefined,admin)).data;assert.ok(audit.events.some(e=>e.action==='permissions.update'&&e.before.level&&e.after.level));assert.ok(audit.events.some(e=>e.action.includes('DELETE')&&e.before&&e.after===null));
  const ownerAudit=(await api('audit','GET',undefined,owner)).data.events;assert.ok(ownerAudit.some(e=>e.instanceId==='owner-a'&&e.action.includes('DELETE')),'Owner can inspect deleted instance history');assert.ok(ownerAudit.every(e=>e.instanceId==='owner-a'));
  await new Promise(r=>{child.once('exit',r);child.kill()});start();await wait();
  assert.equal((await api('auth/me','GET',undefined,staff)).data.user.level,'ordinary','Levels and grants survive restart');
  assert.equal((await api('dashboard?instance=other-b','GET',undefined,staff)).status,403);
  assert.ok((await api('audit','GET',undefined,admin)).data.events.length>0);
  for(const filename of fs.readdirSync(testRoot).filter(f=>f.startsWith('accounts.sqlite'))){const data=fs.readFileSync(path.join(testRoot,filename));for(const secret of [password,bootstrap,owner.cookie.split('=')[1]])assert.equal(data.includes(Buffer.from(secret)),false)}
  console.log('PASS five-level policy: role ceilings, scoped grants, expiry, deny precedence, atomic fields, publication, protected administrators, reasons, destructive confirmation, account controls, audit, downgrade, ID reuse and persistence');
}
main().catch(e=>{console.error(String(e.stack||e).replaceAll(password,'[redacted]').replaceAll(bootstrap,'[redacted]'));process.exitCode=1}).finally(async()=>{if(child&&child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill()});const target=path.resolve(testRoot);if(path.dirname(target)===path.join(root,'data')&&path.basename(target).startsWith('test-policy-'))fs.rmSync(target,{recursive:true,force:true})});
