import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = path.join(root, 'server.js');
const password = 'workflow-test-password';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(database, date) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      HOMEFLOW_DB_PATH: database,
      HOMEFLOW_TEST_NOW: date.includes('T') ? date : `${date}T12:00:00+05:30`,
      ARJUN_INITIAL_PASSWORD: password,
      AKSHAY_INITIAL_PASSWORD: password,
      VINIT_INITIAL_PASSWORD: password,
      DHRUV_INITIAL_PASSWORD: password,
      VAISHNAV_INITIAL_PASSWORD: password
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(`HomeFlow exited with code ${child.exitCode}`);
    try { if ((await fetch(base)).ok) return { child, base }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw Error('HomeFlow did not start in time');
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.kill();
  });
}

async function request(base, token, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: payload ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  return { ok: response.ok, status: response.status, data: await response.json() };
}

async function login(base, name) {
  const result = await request(base, null, '/api/login', { name, password });
  assert.equal(result.ok, true, result.data.error);
  return result.data.token;
}

test('cleaning claims require the window and assignee, and head decisions persist through the deadline', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-workflow-'));
  const database = path.join(directory, 'test.sqlite');

  let server = await startServer(database, '2026-09-24');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });
  const unauthenticated = await request(server.base, null, '/api/cleaning-week?date=2026-09-27');
  assert.equal(unauthenticated.status, 401);
  let akshay = await login(server.base, 'Akshay');
  let week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.weeklyHead, 'Vaishnav');
  assert.equal(week.tasks.length, 5);
  assert.equal(week.tasks.find(task => task.task_name === 'Bathroom + garbage').assigned_member, week.weeklyHead);
  assert.equal(week.date, '2026-09-27');
  assert.equal(week.weekNumber, 1);
  assert.equal(week.window.opens, '2026-09-25');
  assert.equal(week.window.closes, '2026-09-28');
  assert.equal(week.tasks.find(task => task.task_name === 'Hall').status, 'Upcoming');
  let result = await request(server.base, akshay, '/api/duties/action', { id: week.tasks[0].id, action: 'claim' });
  assert.equal(result.ok, false);
  assert.match(result.data.error, /allowed only from 2026-09-25/);
  const hallId = week.tasks.find(task => task.task_name === 'Hall').id;
  const vinitBeforeOpen = await login(server.base, 'Vinit');
  result = await request(server.base, vinitBeforeOpen, '/api/duties/action', { id: hallId, action: 'claim' });
  assert.equal(result.ok, false);
  assert.match(result.data.error, /own assigned task/);
  await stopServer(server.child);

  server = await startServer(database, '2026-09-25');
  akshay = await login(server.base, 'Akshay');
  const arjun = await login(server.base, 'Arjun');
  const vinit = await login(server.base, 'Vinit');
  const dhruv = await login(server.base, 'Dhruv');
  const vaishnav = await login(server.base, 'Vaishnav');
  week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  const taskId = name => week.tasks.find(task => task.task_name === name).id;

  result = await request(server.base, akshay, '/api/duties/action', { id: taskId('Hall'), action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  assert.equal(result.data.duty.claimHistory.length, 1);
  assert.equal((await request(server.base, akshay, '/api/duties/action', { id: taskId('Hall'), action: 'claim' })).ok, false);
  assert.equal((await request(server.base, akshay, '/api/duties/action', { id: taskId('Hall'), action: 'approve' })).ok, false);
  result = await request(server.base, vaishnav, '/api/duties/action', { id: taskId('Hall'), action: 'approve' });
  assert.equal(result.data.duty.status, 'Completed');
  assert.equal(result.data.duty.approval_by, 'Vaishnav');
  week = (await request(server.base, vaishnav, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.completed, 1);
  assert.equal(week.progress, 20);

  result = await request(server.base, vinit, '/api/duties/action', { id: taskId('Kitchen'), action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  assert.equal((await request(server.base, vinit, '/api/duties/action', { id: taskId('Kitchen'), action: 'approve' })).ok, false);
  assert.equal((await request(server.base, arjun, '/api/duties/action', { id: taskId('Kitchen'), action: 'reject' })).ok, false);
  result = await request(server.base, vaishnav, '/api/duties/action', { id: taskId('Kitchen'), action: 'reject', reason: 'Needs another inspection.' });
  assert.equal(result.data.duty.status, 'Rejected');
  result = await request(server.base, vinit, '/api/duties/action', { id: taskId('Kitchen'), action: 'claim' });
  assert.equal(result.data.duty.claimHistory.length, 2);
  assert.equal(result.data.duty.claimHistory[0].rejection_reason, 'Needs another inspection.');

  result = await request(server.base, dhruv, '/api/duties/action', { id: taskId('Toilet + 2 basins'), action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  assert.equal((await request(server.base, await login(server.base, 'Akshay'), '/api/duties/action', { id: taskId('Toilet + 2 basins'), action: 'approve' })).ok, false);
  result = await request(server.base, vaishnav, '/api/duties/action', { id: taskId('Bathroom + garbage'), action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Admin Review');
  assert.equal((await request(server.base, vaishnav, '/api/duties/action', { id: taskId('Bathroom + garbage'), action: 'approve' })).ok, false);
  result = await request(server.base, arjun, '/api/duties/action', { id: taskId('Bathroom + garbage'), action: 'adminReviewApprove', reason: 'Verified head task.' });
  assert.equal(result.data.duty.status, 'Completed');

  result = await request(server.base, arjun, '/api/duties/action', { id: taskId('Bathroom + garbage'), action: 'reassign', member: 'Akshay', reason: 'Weekly head reassignment test.' });
  assert.equal(result.ok, true, result.data.error);
  assert.equal(result.data.duty.weekly_head, 'Akshay');
  week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.weeklyHead, 'Akshay');
  assert.ok(week.tasks.every(task => task.weekly_head === 'Akshay'));
  const auditDb = new DatabaseSync(database);
  const headChange = auditDb.prepare("SELECT previous_value,new_value,actor FROM changes WHERE duty_id=? AND action='weekly_head_changed'").get(taskId('Bathroom + garbage'));
  assert.equal(headChange.previous_value, 'Vaishnav');
  assert.equal(headChange.new_value, 'Akshay');
  assert.equal(headChange.actor, 'Arjun');
  assert.ok(auditDb.prepare("SELECT 1 FROM notifications WHERE member='Akshay' AND kind='head_change'").get());
  auditDb.close();
  assert.equal((await request(server.base, vaishnav, '/api/duties/action', { id: taskId('Kitchen'), action: 'approve' })).ok, false);
  result = await request(server.base, akshay, '/api/duties/action', { id: taskId('Kitchen'), action: 'reject', reason: 'Recheck after head change.' });
  assert.equal(result.data.duty.status, 'Rejected');
  result = await request(server.base, vinit, '/api/duties/action', { id: taskId('Kitchen'), action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  assert.ok(result.data.duty.claimHistory.some(claim => claim.rejection_reason === 'Recheck after head change.'));

  await stopServer(server.child);
  server = await startServer(database, '2026-09-29');
  const arjunAfterDeadline = await login(server.base, 'Arjun');
  const vaishnavAfterDeadline = await login(server.base, 'Vaishnav');
  week = (await request(server.base, arjunAfterDeadline, '/api/cleaning-week?date=2026-09-27')).data;
  const byName = Object.fromEntries(week.tasks.map(task => [task.task_name, task]));
  assert.equal(byName.Bedroom.status, 'Failed to Complete');
  assert.equal(byName['Bathroom + garbage'].status, 'Completed');
  assert.equal(byName.Kitchen.status, 'Awaiting Head Approval');
  assert.equal(byName['Toilet + 2 basins'].status, 'Awaiting Head Approval');
  assert.equal(week.completed, 2);
  assert.equal(week.progress, 40);
  assert.equal(byName.Kitchen.claimHistory.length, 3);
  assert.equal(byName['Bathroom + garbage'].approval_by, 'Arjun');
  const vinitAfterDeadline = await login(server.base, 'Vinit');
  const dashboard = await request(server.base, vinitAfterDeadline, '/api/dashboard');
  assert.ok(dashboard.data.notifications.some(item => item.message.includes('rejected by Vaishnav')));
});

test('six-week cleaning assignments are exact, unique per member, and repeat in Week 7', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-assignment-audit-'));
  const database = path.join(directory, 'test.sqlite');
  const server = await startServer(database, '2026-09-27');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });
  const token = await login(server.base, 'Arjun');
  const roster=(await request(server.base,token,'/api/members')).data.members.map(member=>member.name);
  assert.deepEqual(roster,['Akshay','Arjun','Vinit','Dhruv','Vaishnav']);
  const expected = [
    ['Akshay','Arjun','Vinit','Dhruv','Vaishnav'],
    ['Vinit','Vaishnav','Dhruv','Akshay','Arjun'],
    ['Dhruv','Arjun','Vaishnav','Vinit','Akshay'],
    ['Akshay','Vaishnav','Arjun','Dhruv','Vinit'],
    ['Vinit','Arjun','Akshay','Vaishnav','Dhruv'],
    ['Dhruv','Vaishnav','Vinit','Arjun','Akshay']
  ];
  const taskNames = ['Hall','Bedroom','Kitchen','Toilet + 2 basins','Bathroom + garbage'];
  for(let weekIndex=0;weekIndex<7;weekIndex++){
    const sunday=new Date(Date.UTC(2026,8,27+weekIndex*7)).toISOString().slice(0,10);
    const result=await request(server.base,token,`/api/cleaning-week?date=${sunday}`);
    assert.equal(result.data.weekNumber,weekIndex%6+1);
    assert.equal(result.data.tasks.length,5);
    const byTask=Object.fromEntries(result.data.tasks.map(task=>[task.task_name,task]));
    const assignments=taskNames.map(name=>byTask[name].assigned_member);
    assert.deepEqual(assignments,expected[weekIndex%6]);
    assert.equal(new Set(assignments).size,5);
    assert.equal(result.data.weeklyHead,byTask['Bathroom + garbage'].assigned_member);
  }
  const db=new DatabaseSync(database);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM duties WHERE kind='cleaning' AND scheduled_date<'2026-09-27'").get().count,0);
  db.close();
});

test('Arjun automatically approves his own Bathroom + garbage request when he is weekly head', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-admin-review-'));
  const database = path.join(directory, 'test.sqlite');
  const server = await startServer(database, '2026-10-02');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });

  const arjun = await login(server.base, 'Arjun');
  const vinit = await login(server.base, 'Vinit');
  let week = (await request(server.base, arjun, '/api/cleaning-week?date=2026-10-04')).data;
  assert.equal(week.weeklyHead, 'Arjun');
  const bathroomId = week.tasks.find(task => task.task_name === 'Bathroom + garbage').id;
  const hallId = week.tasks.find(task => task.task_name === 'Hall').id;
  let result = await request(server.base, arjun, '/api/duties/action', { id: bathroomId, action: 'claim' });
  assert.equal(result.data.duty.status, 'Completed');
  assert.equal(result.data.duty.auto_approved, true);
  assert.equal(result.data.duty.approval_by, 'Arjun');
  assert.equal(result.data.duty.claimHistory[0].auto_approved, 1);
  assert.equal((await request(server.base, arjun, '/api/duties/action', { id: bathroomId, action: 'approve' })).ok, false);
  result = await request(server.base, vinit, '/api/duties/action', { id: hallId, action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  assert.equal((await request(server.base, vinit, '/api/duties/action', { id: hallId, action: 'approve' })).ok, false);
  result = await request(server.base, arjun, '/api/duties/action', { id: hallId, action: 'approve' });
  assert.equal(result.data.duty.status, 'Completed');
  week = (await request(server.base, arjun, '/api/cleaning-week?date=2026-10-04')).data;
  assert.equal(week.completed, 2);
});

test('another weekly head own claim routes to Arjun admin review', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-admin-review-'));
  const database = path.join(directory, 'test.sqlite');
  const server = await startServer(database, '2026-09-25');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });

  const arjun = await login(server.base, 'Arjun');
  const vaishnav = await login(server.base, 'Vaishnav');
  const akshay = await login(server.base, 'Akshay');
  const week = (await request(server.base, arjun, '/api/cleaning-week?date=2026-09-27')).data;
  const bathroomId = week.tasks.find(task => task.task_name === 'Bathroom + garbage').id;
  const result = await request(server.base, vaishnav, '/api/duties/action', { id: bathroomId, action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Admin Review');
  assert.equal(result.data.duty.review_type, 'admin');
  assert.equal((await request(server.base, vaishnav, '/api/duties/action', { id: bathroomId, action: 'approve' })).ok, false);
  const arjunQueue = await request(server.base, arjun, '/api/review-queue');
  assert.equal(arjunQueue.data.pendingCount, 1);
  assert.equal(arjunQueue.data.requests.length, 1);
  assert.equal(arjunQueue.data.requests[0].id, bathroomId);
  assert.equal(arjunQueue.data.requests[0].task_name, 'Bathroom + garbage');
  assert.equal(arjunQueue.data.requests[0].assigned_member, 'Vaishnav');
  assert.equal(arjunQueue.data.requests[0].weekly_head, 'Vaishnav');
  assert.equal(arjunQueue.data.requests[0].can_review, true);
  assert.equal((await request(server.base, vaishnav, '/api/review-queue')).data.requests[0].can_review, false);
  assert.equal((await request(server.base, akshay, '/api/duties/action', { id: bathroomId, action: 'adminReviewApprove', reason: 'Unauthorized test.' })).ok, false);
  assert.equal((await request(server.base, akshay, '/api/settings', { household_name: 'Unauthorized change' })).status, 403);
  const notifications = (await request(server.base, arjun, '/api/dashboard')).data.notifications;
  assert.ok(notifications.some(item => item.kind === 'claim' && item.duty_id === bathroomId));
  const adminReview = await request(server.base, arjun, '/api/duties/action', { id: bathroomId, action: 'adminReviewApprove', reason: 'Verified head task.' });
  assert.equal(adminReview.data.duty.status, 'Completed');
  assert.equal(adminReview.data.duty.approval_by, 'Arjun');
  assert.equal((await request(server.base, arjun, '/api/review-queue')).data.pendingCount, 0);
});

test('Arjun must give a reason to reject a head-self request and failed state preserves its history', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-admin-reject-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-25');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });
  const arjun = await login(server.base, 'Arjun');
  const vaishnav = await login(server.base, 'Vaishnav');
  const week = (await request(server.base, vaishnav, '/api/cleaning-week?date=2026-09-27')).data;
  const taskId = week.tasks.find(task => task.task_name === 'Bathroom + garbage').id;
  await request(server.base, vaishnav, '/api/duties/action', { id: taskId, action: 'claim' });
  assert.equal((await request(server.base, arjun, '/api/duties/action', { id: taskId, action: 'adminReviewReject' })).ok, false);
  await stopServer(server.child);

  server = await startServer(database, '2026-09-29');
  const arjunAfterDeadline = await login(server.base, 'Arjun');
  const vaishnavAfterDeadline = await login(server.base, 'Vaishnav');
  let queue = await request(server.base, arjunAfterDeadline, '/api/review-queue');
  assert.equal(queue.data.requests[0].status, 'Awaiting Admin Review');
  const rejected = await request(server.base, arjunAfterDeadline, '/api/duties/action', { id: taskId, action: 'adminReviewReject', reason: 'The submitted work did not meet the standard.' });
  assert.equal(rejected.data.duty.status, 'Failed to Complete');
  assert.equal(rejected.data.duty.claimHistory[0].status, 'Rejected');
  assert.equal(rejected.data.duty.claimHistory[0].rejection_reason, 'The submitted work did not meet the standard.');
  queue = await request(server.base, arjunAfterDeadline, '/api/review-queue');
  assert.equal(queue.data.pendingCount, 0);
  const memberNotifications = (await request(server.base, vaishnavAfterDeadline, '/api/dashboard')).data.notifications;
  assert.ok(memberNotifications.some(item => item.message.includes('rejected by Arjun')));
});

test('startup migration routes existing pending weekly-head claims into Arjun review queue', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-review-migration-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-25');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });
  const arjun = await login(server.base, 'Arjun');
  const vaishnav = await login(server.base, 'Vaishnav');
  const week = (await request(server.base, arjun, '/api/cleaning-week?date=2026-09-27')).data;
  const dutyId = week.tasks.find(task => task.task_name === 'Bathroom + garbage').id;
  const claimResult = await request(server.base, vaishnav, '/api/duties/action', { id: dutyId, action: 'claim' });
  assert.equal(claimResult.data.duty.status, 'Awaiting Admin Review');
  await stopServer(server.child);

  const db = new DatabaseSync(database);
  db.prepare("UPDATE duties SET status='Awaiting Head Approval' WHERE id=?").run(dutyId);
  db.prepare("UPDATE claims SET status='Awaiting Head Approval' WHERE duty_id=?").run(dutyId);
  db.prepare("UPDATE notifications SET duty_id=NULL WHERE member='Arjun' AND kind='claim'").run();
  db.prepare("DELETE FROM settings WHERE key='admin_review_routing_v1'").run();
  db.close();

  server = await startServer(database, '2026-09-26');
  const arjunAfterRestart = await login(server.base, 'Arjun');
  const queue = await request(server.base, arjunAfterRestart, '/api/review-queue');
  assert.equal(queue.data.pendingCount, 1);
  assert.equal(queue.data.requests.length, 1);
  assert.equal(queue.data.requests[0].status, 'Awaiting Admin Review');
  assert.equal(queue.data.requests[0].id, dutyId);
  const dashboard = await request(server.base, arjunAfterRestart, '/api/dashboard');
  assert.equal(dashboard.data.notifications.filter(item => item.kind === 'claim' && item.duty_id === dutyId).length, 1);
});

test('completion requests remain open Monday and fail after Monday ends', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-monday-window-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-28');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });

  const arjun = await login(server.base, 'Arjun');
  const akshay = await login(server.base, 'Akshay');
  let week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.tasks.find(task => task.task_name === 'Hall').can_submit, true);
  const hallId = week.tasks.find(task => task.task_name === 'Hall').id;
  await stopServer(server.child);

  server = await startServer(database, '2026-09-29');
  const nextDayAkshay = await login(server.base, 'Akshay');
  const nextDayArjun = await login(server.base, 'Arjun');
  week = (await request(server.base, nextDayAkshay, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.tasks.find(task => task.task_name === 'Hall').status, 'Failed to Complete');
  assert.equal(week.tasks.find(task => task.task_name === 'Hall').can_submit, false);
  const denied = await request(server.base, nextDayAkshay, '/api/duties/action', { id: hallId, action: 'claim' });
  assert.equal(denied.ok, false);
  assert.match(denied.data.error, /allowed only from 2026-09-25 through 2026-09-28/);
  assert.equal((await request(server.base, nextDayArjun, '/api/cleaning-week?date=2026-09-27')).data.failed, 5);
});

test('one-time reset removes cleaning history only and starts fresh on 27 September', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-cleaning-reset-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-27');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });

  const akshay = await login(server.base, 'Akshay');
  const vaishnav = await login(server.base, 'Vaishnav');
  let week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  const hall = week.tasks.find(task => task.task_name === 'Hall');
  let result = await request(server.base, akshay, '/api/duties/action', { id: hall.id, action: 'claim' });
  assert.equal(result.data.duty.status, 'Awaiting Head Approval');
  result = await request(server.base, vaishnav, '/api/duties/action', { id: hall.id, action: 'approve' });
  assert.equal(result.data.duty.status, 'Completed');
  await request(server.base, akshay, '/api/duties?kind=water');
  await stopServer(server.child);

  const resetDb = new DatabaseSync(database);
  const oldCleaningId = 'legacy-cleaning-june';
  const stamp = '2026-06-07T12:00:00.000Z';
  resetDb.prepare('INSERT INTO duties(id,kind,scheduled_date,task_name,original_member,assigned_member,status,due_at) VALUES (?,?,?,?,?,?,?,?)').run(oldCleaningId,'cleaning','2026-06-07','Hall','Akshay','Akshay','Failed to Complete','2026-06-07T23:59:59+05:30');
  resetDb.prepare('INSERT INTO changes(id,duty_id,action,previous_value,new_value,reason,actor,created_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy-cleaning-change',oldCleaningId,'missed','Pending','Failed to Complete','Old schedule','Arjun',stamp);
  resetDb.prepare('INSERT INTO audit_log(id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').run('legacy-cleaning-audit','Arjun','missed',`${oldCleaningId}: old schedule`,stamp);
  resetDb.prepare('INSERT INTO notifications(id,member,message,kind,created_at) VALUES (?,?,?,?,?)').run('legacy-cleaning-notification','Akshay','Old cleaning request for June','claim',stamp);
  resetDb.prepare('INSERT INTO duties(id,kind,scheduled_date,task_name,original_member,assigned_member,status,due_at) VALUES (?,?,?,?,?,?,?,?)').run('preserved-water-row','water','2026-09-27','Fill water','Akshay','Akshay','Pending','2026-09-27T23:59:59+05:30');
  const waterId=resetDb.prepare("SELECT id FROM duties WHERE kind='water' ORDER BY scheduled_date LIMIT 1").get().id;
  const waterCountBefore=resetDb.prepare("SELECT COUNT(*) count FROM duties WHERE kind='water'").get().count;
  const accountBefore=resetDb.prepare("SELECT role,password_hash FROM members WHERE name='Akshay'").get();
  resetDb.prepare("DELETE FROM settings WHERE key='cleaning_reset_2026_09_27_v1'").run();
  resetDb.close();

  server = await startServer(database, '2026-09-27');
  const akshayAfterReset = await login(server.base, 'Akshay');
  const dashboard = await request(server.base, akshayAfterReset, '/api/dashboard');
  assert.equal(dashboard.data.sunday, '2026-09-27');
  assert.equal(dashboard.data.summary.completed, 0);
  assert.equal(dashboard.data.summary.progress, 0);
  assert.equal(dashboard.data.outstanding.length, 0);
  week = (await request(server.base, akshayAfterReset, '/api/cleaning-week?date=2026-09-27')).data;
  assert.equal(week.date, '2026-09-27');
  assert.equal(week.weekNumber, 1);
  assert.equal(week.completed, 0);
  assert.equal(week.progress, 0);
  assert.equal(week.tasks.length, 5);
  const allCleaning = (await request(server.base, akshayAfterReset, '/api/duties?kind=cleaning')).data.duties;
  assert.ok(allCleaning.every(task => task.scheduled_date >= '2026-09-27'));
  assert.equal(allCleaning.some(task => task.id === oldCleaningId), false);

  const verifyDb = new DatabaseSync(database);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM claims").get().count, 0);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM changes WHERE duty_id=?").get(oldCleaningId).count, 0);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM audit_log WHERE id='legacy-cleaning-audit'").get().count, 0);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM notifications WHERE id='legacy-cleaning-notification'").get().count, 0);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM duties WHERE kind='water'").get().count, waterCountBefore);
  assert.ok(verifyDb.prepare('SELECT 1 FROM duties WHERE id=?').get(waterId));
  assert.equal(verifyDb.prepare("SELECT role,password_hash FROM members WHERE name='Akshay'").get().role, accountBefore.role);
  assert.equal(verifyDb.prepare("SELECT role,password_hash FROM members WHERE name='Akshay'").get().password_hash, accountBefore.password_hash);
  assert.equal(verifyDb.prepare("SELECT value FROM settings WHERE key='cleaning_anchor'").get().value, '2026-09-27');
  verifyDb.close();

  await request(server.base, akshayAfterReset, '/api/logout', {});
  const relogged = await login(server.base, 'Akshay');
  const afterRefresh = await request(server.base, relogged, '/api/dashboard');
  assert.equal(afterRefresh.data.summary.progress, 0);
  assert.equal(afterRefresh.data.outstanding.length, 0);
});

test('water completion advances the shared member pointer atomically and survives restart', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-water-rotation-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-27');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });
  const tokens = Object.fromEntries(await Promise.all(membersForWater.map(async name => [name, await login(server.base, name)])));
  const expected = ['Akshay', 'Vinit', 'Dhruv', 'Arjun', 'Vaishnav', 'Akshay'];

  let current = (await request(server.base, tokens.Akshay, '/api/water')).data.current;
  assert.equal(current.name, expected[0]);
  const failedDb = new DatabaseSync(database);
  failedDb.exec("CREATE TRIGGER fail_water_insert BEFORE INSERT ON water_completions BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;");
  const failed = await request(server.base, tokens.Akshay, '/api/water/complete', {});
  assert.equal(failed.ok, false);
  assert.equal((await request(server.base, tokens.Vinit, '/api/water')).data.current.name, 'Akshay');
  assert.equal(failedDb.prepare('SELECT COUNT(*) count FROM water_completions').get().count, 0);
  failedDb.exec('DROP TRIGGER fail_water_insert');
  failedDb.close();

  const unauthorized = await request(server.base, tokens.Vinit, '/api/water/complete', {});
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.data.error, /Only Akshay can complete/);
  for (let index = 0; index < expected.length - 1; index++) {
    const responsible = expected[index];
    const result = await request(server.base, tokens[responsible], '/api/water/complete', {});
    assert.equal(result.ok, true, result.data.error);
    assert.equal(result.data.completion.member_name, responsible);
    assert.equal(result.data.completion.sequence, index + 1);
    assert.equal(result.data.current.name, expected[index + 1]);
    assert.equal((await request(server.base, tokens.Vaishnav, '/api/water')).data.current.name, expected[index + 1]);
    const duplicate = await request(server.base, tokens[responsible], '/api/water/complete', {});
    assert.equal(duplicate.ok, false);
  }
  const history = (await request(server.base, tokens.Akshay, '/api/water/history')).data.completions;
  assert.deepEqual(history.map(record => record.member_name).reverse(), expected.slice(0, 5));
  assert.ok(history.every(record => Number.isInteger(record.member_id)));

  await stopServer(server.child);
  server = await startServer(database, '2026-09-28');
  const reauthenticatedAkshay = await login(server.base, 'Akshay');
  assert.equal((await request(server.base, reauthenticatedAkshay, '/api/water')).data.current.name, 'Akshay');
});

const membersForWater = ['Akshay', 'Vinit', 'Dhruv', 'Arjun', 'Vaishnav'];

test('on-time Monday request remains awaiting while other tasks reconcile to failed after downtime', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'homeflow-deadline-recovery-'));
  const database = path.join(directory, 'test.sqlite');
  let server = await startServer(database, '2026-09-28T23:59:59.000+05:30');
  t.after(async () => {
    await stopServer(server.child);
    rmSync(directory, { recursive: true, force: true });
  });

  const akshay = await login(server.base, 'Akshay');
  const week = (await request(server.base, akshay, '/api/cleaning-week?date=2026-09-27')).data;
  const hall = week.tasks.find(task => task.task_name === 'Hall');
  assert.equal(hall.can_submit, true);
  const submitted = await request(server.base, akshay, '/api/duties/action', { id: hall.id, action: 'claim' });
  assert.equal(submitted.data.duty.status, 'Awaiting Head Approval');
  await stopServer(server.child);

  server = await startServer(database, '2026-09-29T00:00:00.000+05:30');
  const arjun = await login(server.base, 'Arjun');
  const recovered = (await request(server.base, arjun, '/api/cleaning-week?date=2026-09-27')).data;
  const byName = Object.fromEntries(recovered.tasks.map(task => [task.task_name, task]));
  assert.equal(byName.Hall.status, 'Awaiting Head Approval');
  assert.equal(byName.Hall.failed_at, null);
  assert.equal(byName.Bedroom.status, 'Failed to Complete');
  assert.ok(byName.Bedroom.failed_at);
  assert.equal(recovered.awaiting, 1);
  assert.equal(recovered.failed, 4);
  const outstanding = (await request(server.base, arjun, '/api/dashboard')).data.outstanding;
  assert.equal(outstanding.length, 4);
  assert.ok(outstanding.every(task => task.status === 'Failed to Complete'));
  await request(server.base, arjun, '/api/cleaning-week?date=2026-09-27');
  const auditDb = new DatabaseSync(database);
  assert.equal(auditDb.prepare("SELECT COUNT(*) count FROM changes WHERE action='failed_to_complete'").get().count, 4);
  assert.equal(auditDb.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='failed_to_complete'").get().count, 4);
  auditDb.close();
});
