import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, '.env');
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}
const dataDir = path.join(root, 'data'); if (!existsSync(dataDir)) mkdirSync(dataDir);
const db = new DatabaseSync(process.env.HOMEFLOW_DB_PATH || path.join(dataDir, 'homeflow.sqlite'));
const IST = 'Asia/Kolkata';
const members = ['Akshay', 'Arjun', 'Vinit', 'Dhruv', 'Vaishnav'];
const waterRotation = ['Akshay', 'Vinit', 'Dhruv', 'Arjun', 'Vaishnav'];
const sixWeek = [
  ['Akshay','Arjun','Vinit','Dhruv','Vaishnav'], ['Vinit','Vaishnav','Dhruv','Akshay','Arjun'],
  ['Dhruv','Arjun','Vaishnav','Vinit','Akshay'], ['Akshay','Vaishnav','Arjun','Dhruv','Vinit'],
  ['Vinit','Arjun','Akshay','Vaishnav','Dhruv'], ['Dhruv','Vaishnav','Vinit','Arjun','Akshay']
];
const dutyNames = ['Hall', 'Bedroom', 'Kitchen', 'Toilet + 2 basins', 'Bathroom + garbage'];
const now = () => new Date(process.env.HOMEFLOW_TEST_NOW || Date.now());
const isoDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
const today = () => isoDate(now());
const dayOfWeek = d => new Date(`${d}T12:00:00+05:30`).getDay();
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00+05:30`); x.setDate(x.getDate()+n); return isoDate(x); };
const sundayFor = d => addDays(d, -dayOfWeek(d));
const unix = d => Math.floor(new Date(`${d}T00:00:00+05:30`).getTime()/86400000);
const initialAccounts = { Arjun: ['Administrator', process.env.ARJUN_INITIAL_PASSWORD], Akshay: ['Member', process.env.AKSHAY_INITIAL_PASSWORD], Vinit: ['Member', process.env.VINIT_INITIAL_PASSWORD], Dhruv: ['Member', process.env.DHRUV_INITIAL_PASSWORD], Vaishnav: ['Member', process.env.VAISHNAV_INITIAL_PASSWORD] };
const hash = password => { const salt=randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [scheme,salt,value]=(stored||'').split('$'); if(scheme!=='scrypt'||!salt||!value)return false; const actual=scryptSync(password,salt,64); const expected=Buffer.from(value,'hex'); return expected.length===actual.length && timingSafeEqual(expected,actual); };
const validPassword = password => typeof password==='string' && password.length>=8 && password.length<=128;

db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS duties (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scheduled_date TEXT NOT NULL, task_name TEXT NOT NULL, original_member TEXT NOT NULL, assigned_member TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Upcoming', due_at TEXT NOT NULL, completed_at TEXT, completion_entered_at TEXT, completion_known INTEGER DEFAULT 1, cancelled_reason TEXT, version INTEGER DEFAULT 1, UNIQUE(kind, scheduled_date, task_name));
CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, duty_id TEXT NOT NULL, action TEXT NOT NULL, previous_value TEXT, new_value TEXT, reason TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(duty_id) REFERENCES duties(id));
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, duty_id TEXT NOT NULL, submitted_by TEXT NOT NULL, submitted_at TEXT NOT NULL, status TEXT NOT NULL, decision_by TEXT, decision_at TEXT, rejection_reason TEXT, FOREIGN KEY(duty_id) REFERENCES duties(id));
CREATE TABLE IF NOT EXISTS water_completions (id TEXT PRIMARY KEY, sequence INTEGER UNIQUE NOT NULL, member_id INTEGER NOT NULL, member_name TEXT NOT NULL, completed_at TEXT NOT NULL, FOREIGN KEY(member_id) REFERENCES members(id));
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, member TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL, duty_id TEXT);
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);`);
db.exec("DROP INDEX IF EXISTS one_pending_claim_per_duty; CREATE UNIQUE INDEX one_pending_claim_per_duty ON claims(duty_id) WHERE status IN ('Awaiting Head Approval','Awaiting Admin Review');");
function ensureColumn(table, column, definition) { if(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
ensureColumn('duties','claim_submitted_at','TEXT'); ensureColumn('duties','claim_submitted_by','TEXT'); ensureColumn('duties','approval_at','TEXT'); ensureColumn('duties','approval_by','TEXT'); ensureColumn('duties','rejection_reason','TEXT');
ensureColumn('duties','current_claim_id','TEXT'); ensureColumn('duties','weekly_head','TEXT'); ensureColumn('duties','window_opens','TEXT'); ensureColumn('duties','window_closes','TEXT'); ensureColumn('duties','created_at','TEXT'); ensureColumn('duties','updated_at','TEXT');
ensureColumn('claims','auto_approved','INTEGER NOT NULL DEFAULT 0');
ensureColumn('duties','failed_at','TEXT');
ensureColumn('notifications','duty_id','TEXT');
const getSetting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const setSetting = (key,value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('cleaning_anchor')) {
  setSetting('household_name','HomeFlow Household'); setSetting('timezone',IST); setSetting('cleaning_anchor','2026-09-27'); setSetting('water_anchor','2026-09-27'); setSetting('deadline_time','23:59');
  for (const [name,[role,password]] of Object.entries(initialAccounts)) db.prepare('INSERT INTO members(name,role,password_hash) VALUES (?,?,?)').run(name,role,hash(password));
}
if (!getSetting('auth_migration_v2','')) {
  db.exec('BEGIN IMMEDIATE'); try {
    for (const [name,[role,password]] of Object.entries(initialAccounts)) {
      const existing=db.prepare('SELECT id FROM members WHERE name=?').get(name);
      if(existing) db.prepare('UPDATE members SET role=?,password_hash=?,active=1 WHERE name=?').run(role,hash(password),name);
      else db.prepare('INSERT INTO members(name,role,password_hash,active) VALUES (?,?,?,1)').run(name,role,hash(password));
    }
    setSetting('auth_migration_v2','done'); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
if (!getSetting('cleaning_anchor_2026_v1','')) {
  db.exec('BEGIN IMMEDIATE'); try {
    setSetting('cleaning_anchor','2026-09-27');
    for(const row of db.prepare("SELECT id,scheduled_date,task_name,original_member,assigned_member FROM duties WHERE kind='cleaning' AND scheduled_date>='2026-09-27'").all()) {
      if(row.original_member===row.assigned_member) { const assigned=cleaningAssignments(row.scheduled_date)[dutyNames.indexOf(row.task_name)]; db.prepare('UPDATE duties SET original_member=?,assigned_member=? WHERE id=?').run(assigned,assigned,row.id); }
    }
    setSetting('cleaning_anchor_2026_v1','done'); db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
if (!getSetting('claims_migration_v1','')) {
  db.exec('BEGIN IMMEDIATE'); try {
    for (const row of db.prepare("SELECT * FROM duties WHERE kind='cleaning' AND claim_submitted_at IS NOT NULL AND current_claim_id IS NULL").all()) {
      const claimStatus=row.status==='Awaiting Head Approval'?'Awaiting Head Approval':row.status==='Rejected'?'Rejected':row.status==='Completed'&&row.approval_by?'Completed':'Rejected';
      const claimId=randomUUID();
      db.prepare('INSERT INTO claims(id,duty_id,submitted_by,submitted_at,status,decision_by,decision_at,rejection_reason) VALUES (?,?,?,?,?,?,?,?)').run(claimId,row.id,row.claim_submitted_by||row.assigned_member,row.claim_submitted_at,claimStatus,row.approval_by||null,row.approval_at||null,row.rejection_reason||null);
      db.prepare('UPDATE duties SET current_claim_id=? WHERE id=?').run(claimId,row.id);
    }
    setSetting('claims_migration_v1','done'); db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
if (!getSetting('cleaning_reset_2026_09_27_v1','')) {
  db.exec('BEGIN IMMEDIATE'); try {
    const oldCleaning=db.prepare("SELECT id FROM duties WHERE kind='cleaning'").all();
    for(const row of oldCleaning) {
      db.prepare('DELETE FROM claims WHERE duty_id=?').run(row.id);
      db.prepare('DELETE FROM changes WHERE duty_id=?').run(row.id);
      db.prepare("DELETE FROM audit_log WHERE detail LIKE ?").run(`${row.id}:%`);
    }
    db.prepare("DELETE FROM duties WHERE kind='cleaning'").run();
    db.prepare("DELETE FROM notifications WHERE kind IN ('claim','claim_review','head_change')").run();
    setSetting('cleaning_anchor','2026-09-27');
    setSetting('cleaning_reset_2026_09_27_v1','done');
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
if (!getSetting('water_current_member','')) {
  const legacyCurrent=db.prepare("SELECT assigned_member FROM duties WHERE kind='water' AND scheduled_date<=? ORDER BY scheduled_date DESC LIMIT 1").get(today())?.assigned_member;
  setSetting('water_current_member',waterRotation.includes(legacyCurrent)?legacyCurrent:waterRotation[0]);
}
const sessions = new Map();
function cleaningAssignments(date) { const anchor=getSetting('cleaning_anchor','2026-09-27'); const week=Math.floor((unix(date)-unix(anchor))/7); return sixWeek[((week%6)+6)%6]; }
function completionWindow(date) { const opens=addDays(date,-2), closes=addDays(date,1); return { opens, closes, opensAt:`${opens}T00:00:00+05:30`, closesAt:`${closes}T23:59:59.999+05:30` }; }
function claimWindowOpen(date,at=now()) { const window=completionWindow(date); return at>=new Date(window.opensAt)&&at<=new Date(window.closesAt); }
function weeklyHead(date) { return db.prepare("SELECT assigned_member FROM duties WHERE kind='cleaning' AND scheduled_date=? AND task_name='Bathroom + garbage'").get(date)?.assigned_member || null; }
function syncWeeklyHead(date) { const head=weeklyHead(date); if(!head)throw Error(`Bathroom + garbage assignment is missing for ${date}.`); db.prepare("UPDATE duties SET weekly_head=?,updated_at=? WHERE kind='cleaning' AND scheduled_date=? AND COALESCE(weekly_head,'')<>?").run(head,now().toISOString(),date,head); return head; }
function cleaningStatusFor(date) { const w=completionWindow(date), t=now(); return t<new Date(w.opensAt)?'Upcoming':t>new Date(w.closesAt)?'Failed to Complete':'Pending'; }
function ensureCleaning(date) { const anchor=getSetting('cleaning_anchor','2026-09-27'); if (dayOfWeek(date)!==0 || date<anchor) return; const window=completionWindow(date), a=cleaningAssignments(date), stamp=now().toISOString(); for(let i=0;i<5;i++) db.prepare('INSERT OR IGNORE INTO duties(id,kind,scheduled_date,task_name,original_member,assigned_member,status,due_at,weekly_head,window_opens,window_closes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'cleaning',date,dutyNames[i],a[i],a[i],cleaningStatusFor(date),window.closesAt,null,window.opensAt,window.closesAt,stamp,stamp); db.prepare("UPDATE duties SET due_at=?,window_opens=?,window_closes=?,created_at=COALESCE(created_at,?),updated_at=? WHERE kind='cleaning' AND scheduled_date=?").run(window.closesAt,window.opensAt,window.closesAt,stamp,stamp,date); syncWeeklyHead(date); }
function hydrate() { const d=today(); for(let i=-364;i<=70;i++) ensureCleaning(addDays(d,i)); reconcileCleaningDeadlines(); }
function reconcileCleaningDeadlines(){
  const current=now(),stamp=current.toISOString();
  transaction(()=>{
    for(const row of db.prepare("SELECT id,scheduled_date,status,current_claim_id FROM duties WHERE kind='cleaning' AND scheduled_date>=?").all(getSetting('cleaning_anchor','2026-09-27'))){
      if(['Completed','Cancelled','Failed to Complete'].includes(row.status))continue;
      const window=completionWindow(row.scheduled_date),opens=new Date(window.opensAt),closes=new Date(window.closesAt);
      const claim=row.current_claim_id?db.prepare("SELECT submitted_at,status FROM claims WHERE id=?").get(row.current_claim_id):null;
      const timelyAwaiting=['Awaiting Head Approval','Awaiting Admin Review'].includes(claim?.status)&&new Date(claim.submitted_at)<=closes;
      if(timelyAwaiting){if(row.status!==claim.status)db.prepare('UPDATE duties SET status=?,updated_at=?,version=version+1 WHERE id=?').run(claim.status,stamp,row.id);continue;}
      if(current>closes){const failed=db.prepare("UPDATE duties SET status='Failed to Complete',failed_at=COALESCE(failed_at,?),updated_at=?,version=version+1 WHERE id=? AND status NOT IN ('Completed','Cancelled','Failed to Complete')").run(stamp,stamp,row.id);if(failed.changes===1)log(row.id,'failed_to_complete',row.status,'Failed to Complete','No timely completion request remained awaiting approval after the Monday deadline.','System');continue;}
      if(current<opens){if(row.status!=='Upcoming')db.prepare("UPDATE duties SET status='Upcoming',updated_at=?,version=version+1 WHERE id=?").run(stamp,row.id);continue;}
      if(row.status==='Upcoming'||row.status==='In Progress')db.prepare("UPDATE duties SET status='Pending',updated_at=?,version=version+1 WHERE id=?").run(stamp,row.id);
    }
  });
}
function currentWater(){
  const member=db.prepare('SELECT id,name FROM members WHERE name=? AND active=1').get(getSetting('water_current_member',waterRotation[0]));
  if(!member)throw Error('Current water-duty member is not active.');
  return {...member,completedCount:db.prepare('SELECT COUNT(*) count FROM water_completions').get().count};
}
function completeWater(user){
  return transaction(()=>{
    const currentName=getSetting('water_current_member',waterRotation[0]);
    if(user.name!==currentName)throw Error(`Only ${currentName} can complete the current water duty.`);
    const member=db.prepare('SELECT id,name FROM members WHERE name=? AND active=1').get(currentName);
    if(!member)throw Error('Current water-duty member is not active.');
    const sequence=db.prepare('SELECT COALESCE(MAX(sequence),0)+1 next FROM water_completions').get().next;
    const completedAt=now().toISOString(),record={id:randomUUID(),sequence,member_id:member.id,member_name:member.name,completed_at:completedAt};
    db.prepare('INSERT INTO water_completions(id,sequence,member_id,member_name,completed_at) VALUES (?,?,?,?,?)').run(record.id,sequence,member.id,member.name,completedAt);
    const nextIndex=(waterRotation.indexOf(currentName)+1)%waterRotation.length,nextMember=waterRotation[nextIndex];
    setSetting('water_current_member',nextMember);
    db.prepare('INSERT INTO audit_log(id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),user.name,'water_completed',`${record.id}: ${member.name} completed water duty; next=${nextMember}`,completedAt);
    return {completion:record,current:currentWater()};
  });
}
function duty(d){ const cleaning=d.kind==='cleaning', window=cleaning?completionWindow(d.scheduled_date):null; const claimHistory=cleaning?db.prepare('SELECT id,submitted_by,submitted_at,status,decision_by,decision_at,rejection_reason,auto_approved FROM claims WHERE duty_id=? ORDER BY submitted_at').all(d.id):[]; const currentClaim=cleaning&&d.current_claim_id?db.prepare('SELECT auto_approved FROM claims WHERE id=?').get(d.current_claim_id):null; const head=cleaning?weeklyHead(d.scheduled_date):null; return {...d, claimHistory, auto_approved:!!currentClaim?.auto_approved, review_type:d.status==='Awaiting Admin Review'?'admin':d.status==='Awaiting Head Approval'?'head':null, completedLate: !!d.completed_at && d.completed_at > d.due_at, reassigned:d.original_member!==d.assigned_member, weekly_head:head, weekly_head_changed:cleaning&&d.weekly_head!==head, window_opens:window?.opens,window_closes:window?.closes, window_opens_at:window?.opensAt, window_closes_at:window?.closesAt, can_submit:cleaning&&claimWindowOpen(d.scheduled_date)&&['Pending','Rejected'].includes(d.status)}; }
function reviewQueue(user){
  const requests=allDuties("WHERE kind='cleaning' AND status IN ('Awaiting Head Approval','Awaiting Admin Review')").map(item=>{
    const isAdminReview=item.status==='Awaiting Admin Review';
    return {...item,review_type:isAdminReview?'admin':'head',can_review:isAdminReview?user.name==='Arjun':item.weekly_head===user.name&&item.claim_submitted_by!==user.name};
  });
  return {requests,pendingCount:requests.filter(item=>item.can_review).length};
}
function notify(member,message,kind,dutyId=null){ db.prepare('INSERT INTO notifications(id,member,message,kind,created_at,duty_id) VALUES (?,?,?,?,?,?)').run(randomUUID(),member,message,kind,now().toISOString(),dutyId); }
function transaction(callback){ db.exec('BEGIN IMMEDIATE'); try { const result=callback(); db.exec('COMMIT'); return result; } catch(error) { db.exec('ROLLBACK'); throw error; } }
function log(dutyId,action,prev,next,reason,actor){ const t=now().toISOString(); if(db.prepare('SELECT 1 FROM duties WHERE id=?').get(dutyId)) db.prepare('INSERT INTO changes VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),dutyId,action,prev,next,reason||null,actor,t); db.prepare('INSERT INTO audit_log VALUES (?,?,?,?,?)').run(randomUUID(),actor,action,`${dutyId}: ${reason||''}`,t); }
function allDuties(where='',params=[]){hydrate();return db.prepare(`SELECT * FROM duties ${where} ORDER BY scheduled_date DESC, task_name`).all(...params).map(duty);}
function auth(req){ const token=(req.headers.authorization||'').replace('Bearer ',''); return sessions.get(token); }
function requireUser(req,res,admin=false){ const u=auth(req); if(!u || (admin&&u.role!=='Administrator')){json(res,401,{error:admin?'Administrator access required':'Please sign in'});return null;}return u; }
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const c of req)s+=c;if(!s)return{};try{return JSON.parse(s)}catch{throw Error('Invalid JSON');}}
function dashboard(user){
  hydrate();
  const d=today(),anchor=getSetting('cleaning_anchor','2026-09-27'),sunday=sundayFor(d)<anchor?anchor:sundayFor(d),nextSunday=addDays(sunday,7),tasks=allDuties();
  const current=tasks.filter(x=>x.scheduled_date===sunday&&x.kind==='cleaning');
  const active=tasks.filter(x=>x.kind==='cleaning'&&!['Completed','Cancelled','Missed','Failed to Complete'].includes(x.status));
  const completed=tasks.filter(x=>x.kind==='cleaning'&&x.status==='Completed');
  const outstanding=tasks.filter(x=>x.kind==='cleaning'&&(x.scheduled_date<sunday||x.status==='Failed to Complete')&&!['Completed','Cancelled'].includes(x.status));
  const notifications=db.prepare('SELECT id,message,kind,created_at,duty_id FROM notifications WHERE member=? ORDER BY created_at DESC LIMIT 10').all(user.name);
  const queue=reviewQueue(user);
  return {today:d,sunday,nextSunday,currentCleaning:current,pending:active.filter(x=>x.status!=='Overdue').slice(0,12),outstanding,notifications,completed:completed.slice(0,12),upcoming:tasks.filter(x=>x.kind==='cleaning'&&x.status==='Upcoming').slice(0,12),reviewPending:queue.pendingCount,summary:{completed:current.filter(x=>x.status==='Completed').length,pending:current.filter(x=>['Pending','Upcoming','Rejected'].includes(x.status)).length,awaiting:current.filter(x=>['Awaiting Head Approval','Awaiting Admin Review'].includes(x.status)).length,overdue:current.filter(x=>x.status==='Failed to Complete').length,total:current.length,progress:current.length?Math.round(100*current.filter(x=>x.status==='Completed').length/current.length):0},water:{current:{assigned_member:currentWater().name}},nextCleaning:allDuties('WHERE kind=? AND scheduled_date=?',['cleaning',nextSunday])};
}
function updateDuty(id,action,p,u){
  reconcileCleaningDeadlines();
  const x=db.prepare('SELECT * FROM duties WHERE id=?').get(id); if(!x)throw Error('Duty not found');
  const own = x.assigned_member===u.name; const isAdmin=u.role==='Administrator';
  if(action==='claim') {
    transaction(()=>{
      const current=db.prepare('SELECT * FROM duties WHERE id=?').get(id); if(current.kind!=='cleaning') throw Error('Water duty uses its own completion workflow.');
      if(current.assigned_member!==u.name) throw Error('You can submit a claim only for your own assigned task.');
      const window=completionWindow(current.scheduled_date); if(!claimWindowOpen(current.scheduled_date)) throw Error(`Completion requests are allowed only from ${window.opens} through ${window.closes} in Asia/Kolkata.`);
      if(!['Pending','Rejected'].includes(current.status)) throw Error('This task is not eligible for a new completion claim.');
      const submittedAt=now().toISOString(),claimId=randomUUID(),head=weeklyHead(current.scheduled_date),autoApprove=u.name==='Arjun'&&head==='Arjun'&&current.assigned_member==='Arjun'&&current.task_name==='Bathroom + garbage',adminReview=u.name===head&&u.name!=='Arjun';
      const pendingStatus=adminReview?'Awaiting Admin Review':'Awaiting Head Approval';
      db.prepare('INSERT INTO claims(id,duty_id,submitted_by,submitted_at,status,decision_by,decision_at,auto_approved) VALUES (?,?,?,?,?,?,?,?)').run(claimId,id,u.name,submittedAt,autoApprove?'Completed':pendingStatus,autoApprove?'Arjun':null,autoApprove?submittedAt:null,autoApprove?1:0);
      const nextStatus=autoApprove?'Completed':pendingStatus;
      const r=db.prepare('UPDATE duties SET status=?,claim_submitted_at=?,claim_submitted_by=?,current_claim_id=?,rejection_reason=NULL,approval_at=?,approval_by=?,completed_at=?,completion_entered_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(nextStatus,submittedAt,u.name,claimId,autoApprove?submittedAt:null,autoApprove?'Arjun':null,autoApprove?submittedAt:null,autoApprove?submittedAt:null,submittedAt,id,current.version);
      if(r.changes!==1) throw Error('This task changed. Refresh and try again.');
      log(id,'claim_submitted',current.status,nextStatus,null,u.name);
      if(autoApprove){log(id,'claim_auto_approved','Awaiting Head Approval','Completed','Arjun is both the assigned member and weekly head.',u.name);notify(u.name,`Automatically Approved — Arjun: ${current.task_name} (${current.scheduled_date}).`,'claim_review');}
      else { const recipient=adminReview?'Arjun':head; notify(recipient,`${u.name} submitted a completion request for ${current.task_name} (${current.scheduled_date}).`,'claim',id); }
    });
  } else if(['approve','reject','adminReviewApprove','adminReviewReject'].includes(action)) {
    transaction(()=>{
      const current=db.prepare('SELECT * FROM duties WHERE id=?').get(id), head=weeklyHead(current.scheduled_date), adminReview=['adminReviewApprove','adminReviewReject'].includes(action), approving=['approve','adminReviewApprove'].includes(action);
      if(current.kind!=='cleaning') throw Error('Only cleaning claims use this review workflow.');
      const requiredStatus=adminReview?'Awaiting Admin Review':'Awaiting Head Approval';
      if(adminReview) {
        if(u.name!=='Arjun'||u.role!=='Administrator'||current.claim_submitted_by!==head||head==='Arjun') throw Error('Only Arjun as Administrator can review another weekly head’s own claim.');
        if(!p.reason?.trim()) throw Error('An administrator review reason is required.');
      } else {
        if(head!==u.name) throw Error('Only the designated weekly head can approve or reject this claim.');
        if(current.claim_submitted_by===u.name) throw Error('The weekly head cannot approve or reject their own claim. Arjun must use Admin Review.');
        if(action==='reject'&&!p.reason?.trim()) throw Error('A rejection reason is required.');
      }
      if(current.status!==requiredStatus||!current.current_claim_id) throw Error(adminReview?'Only a request awaiting Admin Review can be reviewed.':'Only a request awaiting head approval can be reviewed.');
      const decidedAt=now().toISOString(),next=approving?'Completed':'Rejected', reason=!approving||adminReview?p.reason.trim():null;
      const claim=db.prepare('UPDATE claims SET status=?,decision_by=?,decision_at=?,rejection_reason=? WHERE id=? AND status=?').run(next,u.name,decidedAt,reason,current.current_claim_id,requiredStatus);
      if(claim.changes!==1) throw Error('This claim has already been reviewed.');
      const r=db.prepare('UPDATE duties SET status=?,approval_at=?,approval_by=?,rejection_reason=?,completed_at=?,completion_entered_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(next,decidedAt,u.name,reason,approving?decidedAt:null,approving?decidedAt:null,decidedAt,id,current.version);
      if(r.changes!==1) throw Error('This claim changed. Refresh and try again.');
      log(id,adminReview?approving?'admin_claim_approved':'admin_claim_rejected':approving?'claim_approved':'claim_rejected',current.status,next,reason,u.name);
      notify(current.assigned_member,approving?`Your completion claim for ${current.task_name} was approved by ${u.name}.`:`Your completion claim for ${current.task_name} was rejected by ${u.name}: ${reason}`,'claim_review',id);
    });
  } else if(action==='complete') {
    if(!own) throw Error('You can complete only your own assigned task.');
    if(x.kind==='cleaning') throw Error('Submit a completion claim for cleaning tasks.');
    if(x.kind==='water') throw Error('Water duty advances through the current-member completion workflow.');
    if(['Completed','Cancelled'].includes(x.status)) throw Error('This task cannot be completed in its current status.');
    const r=db.prepare("UPDATE duties SET status='Completed',completed_at=?,completion_entered_at=?,completion_known=1,version=version+1 WHERE id=? AND version=?").run(now().toISOString(),now().toISOString(),id,x.version);
    if(r.changes!==1) throw Error('This task changed. Refresh and try again.'); log(id,'completed',x.status,'Completed',null,u.name);
  } else if(action==='start') {
    if(!own) throw Error('You can start only your own assigned task.'); if(['Completed','Cancelled'].includes(x.status)) throw Error('This task cannot be started.');
    db.prepare("UPDATE duties SET status='In Progress',version=version+1 WHERE id=?").run(id); log(id,'status',x.status,'In Progress',null,u.name);
  } else {
    if(!isAdmin) throw Error('Administrator permission required.'); if(!p.reason?.trim()) throw Error('A reason is required for administrative corrections.');
    if(action==='adminComplete') { if(['Completed','Cancelled'].includes(x.status)) throw Error('This task cannot be corrected to completed.'); db.prepare("UPDATE duties SET status='Completed',completed_at=?,completion_entered_at=?,completion_known=?,version=version+1 WHERE id=?").run(p.actualCompletion||null,now().toISOString(),p.actualCompletion?1:0,id); log(id,'admin_completed',x.status,'Completed',p.reason,u.name); }
    else if(action==='reassign') {
      if(!p.member||!members.includes(p.member))throw Error('Choose a valid replacement member.');
      transaction(()=>{
        const current=db.prepare('SELECT * FROM duties WHERE id=?').get(id); if(current.version!==x.version)throw Error('This task changed. Refresh and try again.');
        const changesHead=current.kind==='cleaning'&&current.task_name==='Bathroom + garbage',previousHead=changesHead?weeklyHead(current.scheduled_date):null,stamp=now().toISOString();
        const updated=db.prepare('UPDATE duties SET assigned_member=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(p.member,stamp,id,current.version); if(updated.changes!==1)throw Error('This task changed. Refresh and try again.');
        const nextHead=changesHead?syncWeeklyHead(current.scheduled_date):null;
        log(id,'reassigned',current.assigned_member,p.member,p.reason,u.name);
        if(previousHead&&previousHead!==nextHead){
          log(id,'weekly_head_changed',previousHead,nextHead,`Bathroom + garbage reassignment: ${p.reason}`,u.name);
          notify(previousHead,`You are no longer the weekly head for ${current.scheduled_date}; Bathroom + garbage was reassigned to ${nextHead}.`,'head_change',id);
          notify(nextHead,`You are now the weekly head for ${current.scheduled_date}; Bathroom + garbage was assigned to you.`,'head_change',id);
          for(const pending of db.prepare("SELECT id,task_name,assigned_member FROM duties WHERE kind='cleaning' AND scheduled_date=? AND status='Awaiting Head Approval'").all(current.scheduled_date)) notify(nextHead,`${pending.assigned_member} has a completion request for ${pending.task_name} (${current.scheduled_date}) awaiting your review.`,'claim',pending.id);
        }
      });
    }
    else if(action==='miss') { db.prepare("UPDATE duties SET status='Missed',version=version+1 WHERE id=?").run(id); log(id,'missed',x.status,'Missed',p.reason,u.name); }
    else if(action==='reopen') { db.prepare("UPDATE duties SET status='Pending',completed_at=NULL,completion_entered_at=NULL,version=version+1 WHERE id=?").run(id); log(id,'reopened',x.status,'Pending',p.reason,u.name); }
    else if(action==='cancel') { db.prepare("UPDATE duties SET status='Cancelled',cancelled_reason=?,version=version+1 WHERE id=?").run(p.reason,id); log(id,'cancelled',x.status,'Cancelled',p.reason,u.name); }
    else throw Error('Unknown action');
  } reconcileCleaningDeadlines(); return duty(db.prepare('SELECT * FROM duties WHERE id=?').get(id));
}
function cleaningWeek(date) { const anchor=getSetting('cleaning_anchor','2026-09-27'); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||dayOfWeek(date)!==0) throw Error('A Sunday date is required.'); if(date<anchor) throw Error('Cleaning schedules begin on Sunday, 27 September 2026.'); ensureCleaning(date); reconcileCleaningDeadlines(); const tasks=db.prepare("SELECT * FROM duties WHERE kind='cleaning' AND scheduled_date=? ORDER BY CASE task_name WHEN 'Hall' THEN 1 WHEN 'Bedroom' THEN 2 WHEN 'Kitchen' THEN 3 WHEN 'Toilet + 2 basins' THEN 4 ELSE 5 END").all(date).map(duty); const complete=tasks.filter(x=>x.status==='Completed').length, failed=tasks.filter(x=>x.status==='Failed to Complete').length, awaiting=tasks.filter(x=>x.status==='Awaiting Head Approval').length, rejected=tasks.filter(x=>x.status==='Rejected').length; const number=((Math.floor((unix(date)-unix(anchor))/7)%6+6)%6)+1; const window=completionWindow(date); return {date,weekNumber:number,weeklyHead:weeklyHead(date),window,tasks,completed:complete,pending:tasks.filter(x=>['Pending','Upcoming'].includes(x.status)).length,awaiting,rejected,failed,overdue:failed,progress:Math.round(complete/5*100),canPrevious:date>anchor}; }
async function geminiAnswer(question, liveData, user) {
  const asksHowToClean = /\bhow\b[\s\S]*\b(clean|wash|sweep|mop|scrub|organize|tidy)\b/i.test(String(question || '')) || /\bhow\s+to\s+clean\b/i.test(String(question || ''));
  const fallback = asksHowToClean
    ? `General household guidance (not a database record):

1. What it involves: Remove clutter and waste, clean from higher surfaces down, then finish with the floor.
2. Supplies: Gloves, rubbish bag, microfiber cloths, a suitable cleaner, bucket, mop, and disinfectant when appropriate.
3. Steps:
   1. Open a window if safe, remove clutter, and put waste in the correct bag.
   2. Dust or wipe high surfaces first.
   3. Clean surfaces and fixtures with the appropriate product.
   4. Scrub visible dirt, rinse where needed, and dry handles and other touch points.
   5. Sweep, then mop from the farthest area toward the exit.
4. Safety: Never mix bleach with acids or ammonia, wear gloves, follow product labels, keep chemicals away from children, and use a stable step ladder.
5. Checklist: Surfaces are clean, waste is removed, floors are dry, supplies are stored safely, and the room is ready to use.`
    : 'Gemini is temporarily unavailable. The schedule and task-management features remain available.';
  if (!process.env.GEMINI_API_KEY) return { answer: fallback, source: asksHowToClean ? 'General household guidance (Gemini not configured)' : 'Live database records (Gemini not configured)' };
  const context = JSON.stringify({
    authenticatedMember: user.name,
    today: liveData.today, sunday: liveData.sunday, nextSunday: liveData.nextSunday,
    pending: liveData.pending, overdue: liveData.overdue, outstanding: liveData.outstanding,
    currentCleaning: liveData.currentCleaning, nextCleaning: liveData.nextCleaning,
    allDuties: allDuties(),
    water: { current: currentWater(), rotation: waterRotation, history: db.prepare('SELECT sequence,member_name,completed_at FROM water_completions ORDER BY sequence DESC LIMIT 100').all() }
  });
  const instruction = `You are the intelligent household assistant for HomeFlow. Be friendly, clear, practical, accurate, and concise.

AUTHORITY AND PRIVACY:
- Use LIVE_DATABASE_JSON as the source of truth for household-specific facts: members, assignments, statuses, dates, cleaning schedules, claims, notifications, and water duty.
- Never invent assignments, completion statuses, dates, member names, task records, or actions. If the records do not contain enough information, say that you cannot verify it.
- Use Asia/Kolkata for household dates and schedules.
- For questions about "my work", use authenticatedMember from the records. Never infer identity from the question.
- Do not reveal passwords, password hashes, session tokens, API keys, or other private credentials.
- You are read-only. Never create, edit, delete, assign, reassign, complete, claim, or approve anything. For requested changes, direct the member to the appropriate HomeFlow task action and mention that permissions may be required.

HOUSEHOLD QUESTIONS:
- Answer questions about pending, overdue, completed, missed, completed-late, reassigned, cancelled, cleaning schedules, assigned duties, claims, and water duty using the records.
- Include task name, assigned member, due date, status, and other useful recorded details when relevant.
- For "what should I do next", use recorded status and due dates. Do not invent priority.
- For water duty, state the current responsible member and next member only when the supplied rotation/history supports it. Never claim completion unless the records confirm it.

PRACTICAL GUIDANCE:
- You may provide general household advice, but clearly label it as general guidance rather than a database fact.
- When asked how to complete a task, provide: what it involves; supplies/tools; numbered steps; hygiene and safety precautions; and a completion checklist.
- Cover sweeping/mopping, bathrooms/toilets, kitchens/counters/sinks, dishes, dust/cobwebs, fans/windows/common areas, waste, organization, and water duty.
- When a HomeFlow task is known, adapt the instructions to that recorded task.
- If asked for assigned work and instructions, answer the recorded assignment first, then give the practical guidance.

REPORT FORMAT:
- If the member asks for a multi-question household assistant report, begin with the title "HomeFlow Household Assistant Report".
- Answer every requested question in order under "Section A — Household-Specific Information" and "Section B — General Knowledge and Cleaning Guidance".
- Give each question its own heading, answer directly below it, and use Markdown headings, bold text, tables, numbered steps, bullet lists, and checklists when useful. The HomeFlow interface renders this formatting.
- State clearly when a field such as claim amount, instructions, history, or status is not available in the records. Never fill missing fields with guesses.
- Finish with a short summary of the household facts retrieved and the general guidance provided.

LIVE_DATABASE_JSON:
${context}

QUESTION:
${String(question || '').slice(0, 12000)}`;
  try {
    const models=[process.env.GEMINI_MODEL||'gemini-2.5-flash',process.env.GEMINI_FALLBACK_MODEL||'gemini-3.5-flash-lite'].filter((model,index,list)=>list.indexOf(model)===index);
    let response,payload;
    for(const model of models){
      response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: instruction }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4000 } }), signal: AbortSignal.timeout(15000)
      });
      if(response.ok){payload=await response.json();break;}
      if(response.status!==404)throw Error(`Gemini returned ${response.status}`);
    }
    if (!response?.ok) throw Error(`Gemini returned ${response?.status||'no response'}`);
    const answer = payload?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('').trim();
    if (!answer) throw Error('Gemini returned no text'); return { answer, source: 'Gemini + live database records' };
  } catch (error) { console.warn('Gemini request unavailable:', error.message); return { answer: fallback, source: asksHowToClean ? 'General household guidance (Gemini unavailable)' : 'Live database records (Gemini unavailable)' }; }
}

if(!getSetting('admin_review_routing_v1','')){
  transaction(()=>{
    for(const row of db.prepare("SELECT id,scheduled_date,task_name,current_claim_id,claim_submitted_by FROM duties WHERE kind='cleaning' AND status='Awaiting Head Approval'").all()){
      const head=weeklyHead(row.scheduled_date);
      if(head&&head!=='Arjun'&&row.claim_submitted_by===head){
        db.prepare("UPDATE duties SET status='Awaiting Admin Review',updated_at=? WHERE id=?").run(now().toISOString(),row.id);
        if(row.current_claim_id)db.prepare("UPDATE claims SET status='Awaiting Admin Review' WHERE id=? AND status='Awaiting Head Approval'").run(row.current_claim_id);
        const notification=db.prepare("SELECT id FROM notifications WHERE member='Arjun' AND kind='claim' AND (duty_id=? OR (duty_id IS NULL AND message LIKE ?)) ORDER BY created_at DESC LIMIT 1").get(row.id,`%${row.task_name} (${row.scheduled_date})%`);
        if(notification)db.prepare('UPDATE notifications SET duty_id=? WHERE id=?').run(row.id,notification.id);
        else notify('Arjun',`${head} submitted a completion request for ${row.task_name} (${row.scheduled_date}) requiring Admin Review.`,'claim',row.id);
      }
    }
    setSetting('admin_review_routing_v1','done');
  });
}

const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'); if(url.pathname.startsWith('/api/')){
 if(req.method==='POST'&&url.pathname==='/api/login'){const p=await body(req),m=db.prepare('SELECT name,role,password_hash FROM members WHERE name=? AND active=1').get(p.name);if(!m||!verifyPassword(p.password||'',m.password_hash))return json(res,401,{error:'Invalid name or password'});const token=randomUUID();sessions.set(token,{name:m.name,role:m.role});return json(res,200,{token,user:{name:m.name,role:m.role}});}
 if(req.method==='GET'&&url.pathname==='/api/me'){const u=requireUser(req,res);if(u)json(res,200,{user:u});return;}
 const u=requireUser(req,res);if(!u)return;
 if(req.method==='POST'&&url.pathname==='/api/logout'){sessions.delete((req.headers.authorization||'').replace('Bearer ',''));return json(res,200,{ok:true});}
 if(req.method==='GET'&&url.pathname==='/api/water'){return json(res,200,{current:currentWater()});}
 if(req.method==='GET'&&url.pathname==='/api/water/history'){return json(res,200,{completions:db.prepare('SELECT sequence,member_id,member_name,completed_at FROM water_completions ORDER BY sequence DESC LIMIT 100').all()});}
 if(req.method==='POST'&&url.pathname==='/api/water/complete'){const result=completeWater(u);return json(res,200,result);}
 if(req.method==='GET'&&url.pathname==='/api/review-queue')return json(res,200,reviewQueue(u));
 if(req.method==='GET'&&url.pathname==='/api/dashboard')return json(res,200,dashboard(u));
 if(req.method==='GET'&&url.pathname==='/api/cleaning-week')return json(res,200,cleaningWeek(url.searchParams.get('date')||sundayFor(today())));
 if(req.method==='GET'&&url.pathname==='/api/duties'){let r=allDuties();for(const key of ['kind','status','member','date']){const v=url.searchParams.get(key);if(v)r=r.filter(x=>key==='member'?(x.assigned_member===v||x.original_member===v):key==='date'?x.scheduled_date===v:x[key]===v);}return json(res,200,{duties:r});}
 if(req.method==='GET'&&url.pathname==='/api/members'){const rows=db.prepare("SELECT name,role,active FROM members ORDER BY CASE name WHEN 'Akshay' THEN 1 WHEN 'Arjun' THEN 2 WHEN 'Vinit' THEN 3 WHEN 'Dhruv' THEN 4 ELSE 5 END").all();return json(res,200,{members:rows,history:db.prepare("SELECT assigned_member, COUNT(*) count, SUM(status='Completed') completed FROM duties GROUP BY assigned_member").all()});}
 if(req.method==='GET'&&url.pathname==='/api/export'){const rows=allDuties();const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const csv=['id,kind,date,task,original,assigned,status,due,completed,late',...rows.map(x=>[x.id,x.kind,x.scheduled_date,x.task_name,x.original_member,x.assigned_member,x.status,x.due_at,x.completed_at,x.completedLate].map(esc).join(','))].join('\n');res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="homeflow-history.csv"'});return res.end(csv);
 }
 if(req.method==='GET'&&url.pathname==='/api/settings')return json(res,200,{settings:Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value]))});
 if(req.method==='POST'&&url.pathname==='/api/duties/action'){const p=await body(req);return json(res,200,{duty:updateDuty(p.id,p.action,p,u)});}
 if(req.method==='POST'&&url.pathname==='/api/password/change'){const p=await body(req);const row=db.prepare('SELECT password_hash FROM members WHERE name=?').get(u.name);if(!verifyPassword(p.currentPassword||'',row?.password_hash))throw Error('Current password is incorrect.');if(!validPassword(p.newPassword)||p.newPassword!==p.confirmPassword)throw Error('Choose a matching password of at least 8 characters.');db.prepare('UPDATE members SET password_hash=? WHERE name=?').run(hash(p.newPassword),u.name);log('members','password_changed',null,u.name,'Member changed their password',u.name);return json(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/password/reset'){if(u.role!=='Administrator')return json(res,403,{error:'Administrator permission required'});const p=await body(req);if(!members.includes(p.member)||!validPassword(p.newPassword))throw Error('Choose a member and a password of at least 8 characters.');db.prepare('UPDATE members SET password_hash=? WHERE name=?').run(hash(p.newPassword),p.member);for(const [token,session] of sessions)if(session.name===p.member)sessions.delete(token);log('members','password_reset',null,p.member,'Password reset by administrator',u.name);return json(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/settings'){if(u.role!=='Administrator')return json(res,403,{error:'Administrator permission required'});const p=await body(req);for(const k of ['household_name','deadline_time'])if(p[k])setSetting(k,p[k]);if(p.cleaning_anchor&&p.cleaning_anchor!=='2026-09-27')throw Error('The official cleaning start date is fixed at 27 September 2026.');return json(res,200,{ok:true});}
 if(req.method==='POST'&&url.pathname==='/api/ai'){const p=await body(req);return json(res,200,await geminiAnswer(p.question,dashboard(u),u));}
 return json(res,404,{error:'Not found'});
 } const spaRoutes=['/water','/water-duty','/completion-requests'];const filename=url.pathname==='/'||spaRoutes.includes(url.pathname)?'/public/index.html':url.pathname;const file=path.join(root,filename);if(!file.startsWith(root)||!existsSync(file))return json(res,404,{error:'Not found'});const content=await readFile(file);const ext=path.extname(file);res.writeHead(200,{'Content-Type':ext==='.html'?'text/html':ext==='.css'?'text/css':'application/javascript','Cache-Control':'no-store'});res.end(content);
}catch(e){console.error(e);json(res,400,{error:e.message||'Request failed'});}});
server.listen(process.env.PORT||3000,()=>{hydrate();const deadlineWorker=setInterval(()=>{try{hydrate();}catch(error){console.error('Cleaning deadline reconciliation failed:',error)}} ,30_000);deadlineWorker.unref();console.log(`HomeFlow running on http://localhost:${process.env.PORT||3000}`)});
