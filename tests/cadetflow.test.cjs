// Automated tests for CadetFlow (index.html).
// Run:  npm install  &&  npm test
// Each test opens the real page in headless Chromium with a fake Supabase backend that
// several pages share, so two "editors" can be simulated saving at the same time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const PAGE_URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const STUB = fs.readFileSync(path.join(__dirname, 'supabase-stub.js'), 'utf8');

const { Backend, clone } = require('./fake-supabase.cjs');

/**
 * In-memory Supabase shared by all pages in one test (tests/fake-supabase.cjs), with the real
 * cadetflow-api server. Accounts: administrators user-a and user-b, and user-v, an approved member
 * not linked to any cadet (can view, cannot change anything).
 */
function makeDb() {
  return new Backend().account('user-a', { role: 'admin' }).account('user-b', { role: 'admin' }).account('user-v');
}

async function openAs(browser, db, userId, { url = PAGE_URL, init, viewport, waitReady = true } = {}) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  // The site's own dialogs answer through window.confirm / prompt / alert, so tests can accept or replace them.
  await page.addInitScript(() => { window.__cfNativeDialogs = true; });
  if (init) await page.addInitScript(init);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript(u => { window.__testUser = u; }, userId ? { id: userId, email: db.users.get(userId)?.email || `${userId}@example.com` } : null);
  await page.exposeFunction('__db', (q, uid) => db.clientExec(q, uid));
  await page.exposeFunction('__auth', (op, args) => db.authCall(op, args));
  await page.exposeFunction('__fn', (name, body, uid) => db.callFunction(name, body, uid));
  await page.route('**/supabase-js@2', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '' }));
  await page.goto(url);
  // Approved accounts wait for the shared data; anyone else for the sign-in screen.
  if (waitReady) await page.waitForFunction(() => typeof app !== 'undefined' && app && app.authChecked === true && (app.remoteReady === true || document.body.classList.contains('locked')));
  db.pages.push(page);
  return page;
}
/** The view the sign-in screen shows (signin, register, pending, ...), or '' when the site is open. */
const gateView = page => page.evaluate(() => (document.body.classList.contains('locked') ? GATE.view : ''));

const run = (page, fn, arg) => page.evaluate(fn, arg);
const flush = page => run(page, () => app.flushRemoteSave());
const refresh = page => run(page, () => app.refreshFromRemote());
const setPrompt = (page, answer) => run(page, a => { window.prompt = () => a; }, answer);
const createTask = (page, title, extra = {}) => run(page, async ({ title, extra }) => {
  app.openNewEventModal();
  document.getElementById('newEventTitleInput').value = title;
  if (extra.deadline) {
    document.getElementById('newEventHasDeadline').checked = true;
    document.getElementById('newEventDeadlineInput').value = extra.deadline;
  }
  await app.handleCreateEvent({ preventDefault() {} });
  return app.state.activeEventId;
}, { title, extra });
/** Create a special event through the real editor UI state. teams: [{ name, cadets: [ids] }] → team-test-1, team-test-2, … */
const createSpecial = (page, title, teams) => run(page, async ({ title, teams }) => {
  app.openSpecialEventModal(title);
  const d = app.specialDraft;
  d.teams = teams.map((t, i) => ({ id: `team-test-${i + 1}`, name: t.name }));
  teams.forEach((t, i) => t.cadets.forEach(c => { d.assignments[c] = `team-test-${i + 1}`; }));
  await app.saveSpecialEvent();
  return app.state.activeEventId;
}, { title, teams });
/** Add a task to a special event through the task dialog; returns the new task's id. */
const addTask = (page, eventId, title, teamIds, extra = {}) => run(page, async ({ eventId, title, teamIds, extra }) => {
  app.openSpecialTaskModal(eventId);
  document.getElementById('specialTaskTitle').value = title;
  document.getElementById('specialTaskDetails').value = extra.details || '';
  document.querySelectorAll('#specialTaskTeams input').forEach(b => { b.checked = teamIds.includes(b.value); });
  await app.saveSpecialTask();
  const ev = app.findEvent(eventId);
  return ev.tasks[ev.tasks.length - 1].id;
}, { eventId, title, teamIds, extra });
const dbEvent = (db, id) => db.row.state.events.find(e => e.id === id);
const teamsOf = ev => Object.fromEntries(ev.teams.map(t => [t.name, [...t.cadetIds].sort()]));

async function withBrowser(fn) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try { await fn(browser); } finally { await browser.close(); }
}
function noErrors(...pages) { pages.forEach(p => assert.deepEqual(p.errors, [], 'page errors')); }

// ---------------------------------------------------------------------------------------

test('two editors saving at the same time keep both sets of changes', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a'); // first editor seeds the shared row
  const b = await openAs(browser, db, 'user-b');
  db.autoNotify = false; // B works on a stale copy until it saves
  const task = await run(a, () => app.state.activeEventId);

  await run(a, id => app.toggleCadetStatus('cadet-1', id), task);
  const taskA = await createTask(a, 'Uniform check');
  await setPrompt(b, 'Medical leave');
  await run(b, id => app.promptReason('cadet-2', id), task);
  await run(b, id => app.toggleCadetStatus('cadet-3', id), task);
  const taskB = await createTask(b, 'Drill practice');

  await flush(a);
  await flush(b); // conflicts with A's save → must merge, not overwrite

  const ev = dbEvent(db, task);
  assert.equal(ev.records['cadet-1'].done, true, "A's done mark kept");
  assert.equal(ev.records['cadet-2'].note, 'Medical leave', "B's reason kept");
  assert.equal(ev.records['cadet-3'].done, true, "B's done mark kept");
  assert.ok(dbEvent(db, taskA), "A's new task kept");
  assert.ok(dbEvent(db, taskB), "B's new task kept");
  assert.ok(db.row.state.history.some(h => h.details.includes('Uniform check')) && db.row.state.history.some(h => h.details.includes('Drill practice')), 'both histories kept');

  await refresh(a);
  assert.equal(await run(a, id => app.peekRecord('cadet-3', app.findEvent(id)).done, task), true, 'A sees B\'s change after refresh');
  assert.equal(await run(a, id => !!app.findEvent(id), taskB), true);
  noErrors(a, b);
}));

test('same field changed by both editors: the later save wins, nothing breaks', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const b = await openAs(browser, db, 'user-b');
  db.autoNotify = false;
  await run(a, () => app.updateCadetField('cadet-5', 'name', 'Name From A'));
  await run(b, () => app.updateCadetField('cadet-5', 'name', 'Name From B'));
  await flush(a);
  await flush(b);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-5').name, 'Name From B');
  assert.equal(db.row.state.cadets.length, 37);
  noErrors(a, b);
}));

test('opening a task or rendering does not write to the database or create records', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const other = await createTask(a, 'Second task');
  await flush(a);
  const writes = db.writes;
  const first = await run(a, () => app.state.events[1].id);
  await run(a, id => { app.switchEvent(id); app.renderAll(); renderTaskArchive(); }, first);
  await run(a, id => app.switchEvent(id), other);
  await a.waitForTimeout(700);
  await flush(a);
  assert.equal(db.writes, writes, 'no writes from viewing');
  assert.equal(Object.keys(dbEvent(db, first).records).length, 0, 'no empty records created');
  noErrors(a);
}));

test('special event: teams and tasks are separate; marks go to that event and task, whatever is open', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const sp = await createSpecial(a, 'Camp setup', [
    { name: 'Tents', cadets: ['cadet-1', 'cadet-12'] },
    { name: 'Kitchen', cadets: ['cadet-25'] }
  ]);
  await flush(a);
  assert.deepEqual(dbEvent(db, sp).tasks, [], 'a new special event starts without tasks');
  const pitch = await addTask(a, sp, 'Pitch tents', ['team-test-1']);
  const cook = await addTask(a, sp, 'Cook', ['team-test-2'], { details: 'Lunch for 60' });
  const clean = await addTask(a, sp, 'Clean up', ['team-test-1', 'team-test-2']);
  assert.equal(await a.locator('#specialEventView [data-task-id]').count(), 3, 'tasks are shown on the event page');
  const tentsCard = await a.textContent('#specialEventView [data-team-id="team-test-1"]');
  assert.match(tentsCard, /Pitch tents/); assert.match(tentsCard, /Clean up/); assert.ok(!tentsCard.includes('Cook'));

  const normal = await run(a, () => app.state.events.find(e => e.type !== 'special').id);
  await run(a, id => app.switchEvent(id), normal); // a different task is now open
  await run(a, ({ sp, pitch }) => app.toggleCadetStatus('cadet-12', sp, pitch), { sp, pitch });
  await run(a, ({ sp, cook }) => app.setTeamDone('team-test-2', true, sp, cook), { sp, cook });
  await setPrompt(a, 'Exam');
  await run(a, ({ sp, clean }) => app.promptReason('cadet-1', sp, clean), { sp, clean });
  // cadet-25 has two tasks, so a mark without a task is refused rather than guessed
  await run(a, sp => app.toggleCadetStatus('cadet-25', sp), sp);
  // cadet-25 is not in Tents, so it can't be marked on Pitch tents
  await run(a, ({ sp, pitch }) => app.toggleCadetStatus('cadet-25', sp, pitch), { sp, pitch });
  await flush(a);

  let ev = dbEvent(db, sp);
  const task = id => ev.tasks.find(t => t.id === id);
  assert.equal(task(pitch).records['cadet-12'].done, true);
  assert.deepEqual(Object.keys(task(cook).records), ['cadet-25']);
  assert.equal(task(cook).details, 'Lunch for 60');
  assert.equal(task(clean).records['cadet-1'].note, 'Exam');
  assert.equal(task(clean).records['cadet-25'], undefined);
  assert.equal(task(pitch).records['cadet-25'], undefined);
  assert.deepEqual(ev.records, {}, 'special events keep marks on their tasks');
  assert.deepEqual(dbEvent(db, normal).records, {}, 'open task untouched');

  // Overall status: done only when every task of the cadet's team is done
  assert.equal(await run(a, sp => app.cadetStatus('cadet-25', app.findEvent(sp)), sp), 'pending');
  await run(a, ({ sp, clean }) => app.toggleCadetStatus('cadet-25', sp, clean), { sp, clean });
  assert.equal(await run(a, sp => app.cadetStatus('cadet-25', app.findEvent(sp)), sp), 'done');
  // cadet-1 has a reason for Clean up, so only Pitch tents counts for them
  assert.equal(await run(a, sp => app.cadetStatus('cadet-1', app.findEvent(sp)), sp), 'pending');
  await run(a, ({ sp, pitch }) => app.toggleCadetStatus('cadet-1', sp, pitch), { sp, pitch });
  assert.equal(await run(a, sp => app.cadetStatus('cadet-1', app.findEvent(sp)), sp), 'done');

  // Archive outcomes and the CSV use the per-task marks
  const outcomes = await run(a, sp => { const ev = app.findEvent(sp); return app.eventCadets(ev).map(c => [c.id, taskOutcome(ev, c)]); }, sp);
  assert.deepEqual(Object.fromEntries(outcomes), { 'cadet-1': 'ontime', 'cadet-12': 'pending', 'cadet-25': 'ontime' });
  const csv = await run(a, sp => { let out; app.downloadCSV = text => { out = text; }; app.switchEvent(sp); app.exportEventCSV(); return out; }, sp);
  assert.match(csv.split('\n')[0], /"Team","Pitch tents","Cook","Clean up","Overall"/);
  assert.match(csv, /REASON: Exam/);

  // WhatsApp copy for one task lists only the teams doing it
  const msg = await run(a, ({ sp, cook }) => { let out; app.copyToClipboard = t => { out = t; }; app.copySpecialTask(sp, cook); return out; }, { sp, cook });
  assert.match(msg, /\*Camp setup: Cook\*/); assert.match(msg, /Kitchen/); assert.ok(!msg.includes('Tents'));
  noErrors(a);
}));

test('special event tasks: create, give to several teams, edit, delete; edits merge with other editors', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const dialogs = [];
  a.on('dialog', d => dialogs.push(d.message()));
  const sp = await createSpecial(a, 'Drill day', [
    { name: 'A', cadets: ['cadet-1', 'cadet-2'] }, { name: 'B', cadets: ['cadet-3'] }, { name: 'C', cadets: ['cadet-4'] }
  ]);
  // Validation: a task needs a name and at least one team
  await run(a, sp => { app.openSpecialTaskModal(sp); document.getElementById('specialTaskTitle').value = 'Nothing'; document.querySelectorAll('#specialTaskTeams input').forEach(b => { b.checked = false; }); app.saveSpecialTask(); }, sp);
  assert.match(await a.textContent('#specialTaskError'), /at least one team/);
  await run(a, () => app.closeModal('specialTaskModal'));

  const drill = await addTask(a, sp, 'Drill', ['team-test-1', 'team-test-2']);
  const kit = await addTask(a, sp, 'Kit check', ['team-test-1', 'team-test-2', 'team-test-3']);
  await run(a, ({ sp, drill }) => { app.toggleCadetStatus('cadet-1', sp, drill); app.toggleCadetStatus('cadet-3', sp, drill); }, { sp, drill });
  await flush(a);

  // Take B off Drill and give it to C: B's marks for Drill go (after a warning), A's stay
  await run(a, ({ sp, drill }) => {
    app.openSpecialTaskModal(sp, drill);
    document.querySelector('#specialTaskTeams input[value="team-test-2"]').checked = false;
    document.querySelector('#specialTaskTeams input[value="team-test-3"]').checked = true;
    app.saveSpecialTask();
  }, { sp, drill });
  await flush(a);
  let t = dbEvent(db, sp).tasks.find(x => x.id === drill);
  assert.deepEqual(t.teamIds, ['team-test-1', 'team-test-3']);
  assert.deepEqual(Object.keys(t.records), ['cadet-1']);
  assert.ok(dialogs.some(m => m.includes('taken off this task')), 'warned before marks are removed');

  // A opens the editor; meanwhile B sets a deadline on the same task. A renames it. Both changes kept.
  await run(a, ({ sp, drill }) => app.openSpecialTaskModal(sp, drill), { sp, drill });
  const b = await openAs(browser, db, 'user-b');
  await run(b, ({ sp, drill }) => {
    app.openSpecialTaskModal(sp, drill);
    document.getElementById('specialTaskHasDeadline').checked = true;
    document.getElementById('specialTaskDeadline').value = '2030-01-01T10:00';
    app.saveSpecialTask();
  }, { sp, drill });
  await flush(b);
  await refresh(a);
  await run(a, () => { document.getElementById('specialTaskTitle').value = 'Morning drill'; app.saveSpecialTask(); });
  await flush(a);
  t = dbEvent(db, sp).tasks.find(x => x.id === drill);
  assert.equal(t.title, 'Morning drill');
  assert.equal(t.deadline, new Date('2030-01-01T10:00').getTime());
  assert.equal(t.records['cadet-1'].done, true, 'marks kept through the edit');

  // Delete a task
  await run(a, ({ sp, kit }) => app.deleteSpecialTask(sp, kit), { sp, kit });
  await flush(a);
  assert.deepEqual(dbEvent(db, sp).tasks.map(x => x.id), [drill]);
  assert.ok(db.row.state.history.some(h => h.action === 'special-task-deleted'));
  noErrors(a, b);
}));

test('editing teams keeps tasks and marks, and merges with changes made meanwhile', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const id = await createSpecial(a, 'Republic Day', [
    { name: 'Dais', cadets: ['cadet-1', 'cadet-2'] },
    { name: 'Guard', cadets: ['cadet-3'] }
  ]);
  const dais = await addTask(a, id, 'Set up dais', ['team-test-1']);
  const guard = await addTask(a, id, 'Guard of honour', ['team-test-2']);
  const parade = await addTask(a, id, 'Parade', ['team-test-1', 'team-test-2']);
  await run(a, ({ id, dais }) => app.toggleCadetStatus('cadet-1', id, dais), { id, dais });
  await setPrompt(a, 'On leave');
  await run(a, ({ id, parade }) => app.promptReason('cadet-2', id, parade), { id, parade });
  await flush(a);
  const before = clone(dbEvent(db, id));

  // 1) Open the team editor and save without changes: event must be identical.
  await run(a, id => { app.openSpecialEventModal(null, id); app.saveSpecialEvent(); }, id);
  await flush(a);
  assert.deepEqual(dbEvent(db, id), before, 'no-op edit changes nothing');

  // 2) A opens the editor; while it is open, B adds a cadet and marks someone done.
  await run(a, id => app.openSpecialEventModal(null, id), id);
  const b = await openAs(browser, db, 'user-b');
  await run(b, ({ id, guard }) => {
    app.openSpecialEventModal(null, id);
    app.specialDraft.assignments['cadet-4'] = 'team-test-2';
    app.saveSpecialEvent();
    app.toggleCadetStatus('cadet-3', id, guard);
  }, { id, guard });
  await flush(b);
  await refresh(a);

  // A renames Dais and moves cadet-2 to Guard, then saves.
  await run(a, () => {
    const d = app.specialDraft;
    d.teams.find(t => t.id === 'team-test-1').name = 'Alpha';
    d.assignments['cadet-2'] = 'team-test-2';
    app.saveSpecialEvent();
  });
  await flush(a);

  const ev = dbEvent(db, id);
  assert.equal(ev.id, before.id);
  assert.equal(ev.createdAt, before.createdAt);
  assert.deepEqual(teamsOf(ev), { Alpha: ['cadet-1'], Guard: ['cadet-2', 'cadet-3', 'cadet-4'] }, "A's move and B's addition both kept");
  assert.deepEqual(ev.tasks.map(t => t.title), ['Set up dais', 'Guard of honour', 'Parade'], 'tasks untouched by team edits');
  const rec = (task, c) => ev.tasks.find(t => t.id === task).records[c];
  assert.equal(rec(dais, 'cadet-1').done, true, 'done mark preserved');
  assert.equal(rec(parade, 'cadet-2').note, 'On leave', "reason kept: cadet-2's new team also does the Parade");
  assert.equal(rec(guard, 'cadet-3').done, true, "B's done mark preserved");
  assert.ok(ev.teams.every(t => !('task' in t)));
  const all = ev.teams.flatMap(t => t.cadetIds);
  assert.equal(new Set(all).size, all.length, 'every cadet in only one team');
  noErrors(a, b);
}));

test('moving or removing a cadet clears marks only for tasks their new team does not have', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const dialogs = [];
  a.on('dialog', d => dialogs.push(d.message()));
  const id = await createSpecial(a, 'Cleanup', [
    { name: 'One', cadets: ['cadet-7', 'cadet-8', 'cadet-9'] },
    { name: 'Two', cadets: ['cadet-10'] }
  ]);
  const sweep = await addTask(a, id, 'Sweep', ['team-test-1']);
  const paint = await addTask(a, id, 'Paint', ['team-test-2']);
  const both = await addTask(a, id, 'Both teams', ['team-test-1', 'team-test-2']);
  await run(a, ({ id, sweep, paint, both }) => {
    app.toggleCadetStatus('cadet-7', id, sweep); app.toggleCadetStatus('cadet-7', id, both);
    app.toggleCadetStatus('cadet-8', id, sweep); app.toggleCadetStatus('cadet-10', id, paint);
  }, { id, sweep, paint, both });
  await setPrompt(a, 'Injured');
  await run(a, ({ id, both }) => app.promptReason('cadet-9', id, both), { id, both });

  // Move cadet-7 and cadet-9 to Two; remove cadet-8; leave cadet-10 alone.
  await run(a, async id => {
    app.openSpecialEventModal(null, id);
    const d = app.specialDraft;
    d.assignments['cadet-7'] = 'team-test-2';
    d.assignments['cadet-9'] = 'team-test-2';
    delete d.assignments['cadet-8'];
    await app.saveSpecialEvent();
  }, id);
  await flush(a);
  let ev = dbEvent(db, id);
  const recs = task => ev.tasks.find(t => t.id === task).records;
  assert.deepEqual(teamsOf(ev), { One: [], Two: ['cadet-10', 'cadet-7', 'cadet-9'].sort() });
  assert.deepEqual(recs(sweep), {}, "moved and removed cadets lose marks for One's task");
  assert.equal(recs(both)['cadet-7'].done, true, 'Two also does "Both teams", so that mark stays');
  assert.equal(recs(both)['cadet-9'].note, 'Injured');
  assert.equal(recs(paint)['cadet-10'].done, true, 'untouched cadet keeps done mark');
  assert.ok(dialogs.some(m => m.includes('moving to another team') && m.includes('removed from the event')), 'editor is warned before saving');
  assert.ok(db.row.state.history.some(h => h.action === 'team-move-reset') && db.row.state.history.some(h => h.action === 'team-member-removed'));

  // Adding the removed cadet back starts them fresh.
  await run(a, id => { app.openSpecialEventModal(null, id); app.specialDraft.assignments['cadet-8'] = 'team-test-1'; app.saveSpecialEvent(); }, id);
  await flush(a);
  ev = dbEvent(db, id);
  assert.deepEqual(teamsOf(ev).One, ['cadet-8']);
  assert.equal(recs(sweep)['cadet-8'], undefined);

  // Cancelling the warning leaves everything as it was.
  await run(a, () => { window.confirm = () => false; });
  await run(a, id => { app.openSpecialEventModal(null, id); delete app.specialDraft.assignments['cadet-10']; app.saveSpecialEvent(); }, id);
  await flush(a);
  ev = dbEvent(db, id);
  assert.equal(recs(paint)['cadet-10'].done, true, 'cancel keeps the record');

  // Removing a team takes it off its tasks
  await run(a, () => { window.confirm = () => true; });
  await run(a, async id => { app.openSpecialEventModal(null, id); await app.removeSpecialTeam('team-test-1'); await app.saveSpecialEvent(); }, id);
  await flush(a);
  ev = dbEvent(db, id);
  assert.deepEqual(ev.tasks.map(t => [t.title, t.teamIds]), [['Sweep', []], ['Paint', ['team-test-2']], ['Both teams', ['team-test-2']]]);
  noErrors(a);
}));

test('older special events (one task written on each team) are converted to tasks', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => {
    const old = { id: 'old-sp', title: 'Old event', type: 'special', scope: 'All', archived: false, createdAt: 5,
      teams: [{ id: 't1', name: 'Alpha', task: 'Carry chairs', cadetIds: ['cadet-1'] }, { id: 't2', name: 'Beta', task: '', cadetIds: ['cadet-2'] }, { id: 't3', name: 'Gamma', task: '', cadetIds: [] }],
      records: { 'cadet-1': { done: true, note: '', completedAt: 9 }, 'cadet-2': { done: false, note: 'Sick', completedAt: null } } };
    app.applyState({ ...app.serializableState(), events: [old, ...app.state.events] });
    app.saveStorage();
  });
  await flush(a);
  const ev = dbEvent(db, 'old-sp');
  assert.deepEqual(ev.tasks.map(t => [t.id, t.title, t.teamIds]), [['task-t1', 'Carry chairs', ['t1']], ['task-t2', 'Beta task', ['t2']]]);
  assert.equal(ev.tasks[0].records['cadet-1'].done, true);
  assert.equal(ev.tasks[1].records['cadet-2'].note, 'Sick');
  assert.deepEqual(ev.records, {});
  assert.ok(ev.teams.every(t => !('task' in t)));
  noErrors(a);
}));

test('actions always apply to the task on screen, even if the selection changes underneath', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const shown = await createTask(a, 'Shown task');
  const other = await createTask(a, 'Other task');
  await run(a, () => { switchCadetFlowPage('roster'); showTaskMasterSection('workspace'); });
  // Show one task, then change the selection without the workspace being redrawn.
  const desync = () => run(a, ({ shown, other }) => { app.switchEvent(shown); app.state.activeEventId = other; }, { shown, other });

  await desync();
  await run(a, () => app.toggleCadetStatus('cadet-1'));
  await desync();
  await run(a, () => { app.setStatusFilter('all', false); app.bulkToggleVisible(true); });
  await desync();
  await run(a, () => app.openEditCurrentEventModal());
  await run(a, id => { app.state.activeEventId = id; document.getElementById('editEventTitleInput').value = 'Shown task (edited)'; app.handleSaveEditedEvent({ preventDefault() {} }); }, other);
  await flush(a);
  let s = dbEvent(db, shown), o = dbEvent(db, other);
  assert.equal(s.title, 'Shown task (edited)', 'edit saved to the task that was opened');
  assert.equal(o.title, 'Other task');
  assert.equal(Object.values(s.records).filter(r => r.done).length, 37, 'bulk applied to the shown task');
  assert.deepEqual(o.records, {}, 'other task untouched');

  // Archive and delete from the header also target the shown task.
  await run(a, id => { app.switchEvent(id); app.state.activeEventId = 'nonexistent'; app.toggleArchiveCurrentEvent(); }, shown);
  assert.equal(await run(a, id => app.findEvent(id).archived, shown), true);
  assert.equal(await run(a, id => app.findEvent(id).archived, other), false);
  await run(a, id => { app.switchEvent(id); app.state.activeEventId = 'nonexistent'; app.handleDeleteCurrentEventDirectly(); }, other);
  assert.equal(await run(a, id => !!app.findEvent(id), other), false);
  assert.equal(await run(a, id => !!app.findEvent(id), shown), true);
  noErrors(a);
}));

test('if another editor deletes the task on screen, nothing is applied to a different task', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const doomed = await createTask(a, 'Doomed');
  const keep = await createTask(a, 'Keep');
  await flush(a);
  await run(a, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); app.openEditCurrentEventModal(); }, doomed);
  const b = await openAs(browser, db, 'user-b');
  await run(b, id => { app.switchEvent(id); app.handleDeleteCurrentEventDirectly(id); }, doomed);
  await flush(b);
  await refresh(a);
  assert.equal(await a.isVisible('#editEventModal'), false, 'edit form closed');
  assert.equal(await a.isVisible('#taskMasterHome'), true, 'back on Task Master home');
  // A stale click on a button drawn for the deleted task does nothing.
  await run(a, id => app.toggleCadetStatus('cadet-1', id), doomed);
  await flush(a);
  assert.equal(dbEvent(db, doomed), undefined);
  assert.deepEqual(dbEvent(db, keep).records, {});
  noErrors(a, b);
}));

test('year of study: set it, and filter by it everywhere', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Set years: cadets 1-10 → 1st, 11-20 → 2nd, Abhinav (29) → 3rd, rest not set.
  await run(a, () => {
    app.openRosterModal();
    for (let i = 1; i <= 20; i++) app.updateCadetField(`cadet-${i}`, 'year', i <= 10 ? '1st' : '2nd');
    app.updateCadetField('cadet-29', 'year', '3rd');
  });
  assert.match(await a.textContent('#rosterSummary'), /1st 10 · 2nd 10 · 3rd 1 · year not set 16/);
  // Roster year filter, tick all shown, bulk-set year
  await a.selectOption('#rosterFilterYear', 'none');
  assert.equal(await a.locator('#modalRosterTableBody tr').count(), 16);
  await a.check('#rosterTickAll');
  await a.selectOption('#rosterBulkField', 'year');
  await a.selectOption('#rosterBulkValue', '2nd');
  await a.click('#rosterBulkBar button:has-text("Apply")');
  assert.match(await a.textContent('#rosterSummary'), /2nd 26 · 3rd 1 · year not set 0/);
  await run(a, () => { app.updateCadetField('cadet-30', 'year', ''); app.closeModal('rosterModal'); });
  await flush(a);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-1').year, '1st', 'saved to the shared roster');

  // Task workspace filter
  const task = await run(a, () => app.state.activeEventId);
  await run(a, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); app.setYearFilter('3rd'); }, task);
  const rows = await a.locator('#cadetListContainer > div').allTextContents();
  assert.equal(rows.length, 1); assert.match(rows[0], /Abhinav Pathak/); assert.match(rows[0], /3rd yr/);
  await run(a, () => app.setYearFilter('none'));
  assert.match((await a.locator('#cadetListContainer > div').allTextContents()).join(''), /Shaurya Pandey/);
  const msg = await run(a, () => { let out; app.copyToClipboard = t => { out = t; }; app.setYearFilter('1st'); app.copySmartPending(); return out; });
  assert.equal((msg.match(/^\d+\./gm) || []).length, 10, 'copied list follows the year filter');
  assert.match(await a.textContent('#mainCopyBtnLabel'), /Filtered/);

  // Special event editor filter + special view filter
  const sp = await createSpecial(a, 'Year mix', [{ name: 'Mixed', cadets: ['cadet-1', 'cadet-15', 'cadet-29'] }]);
  await run(a, () => { app.openSpecialEventModal(); document.getElementById('specialAssignYear').value = '1st'; app.renderSpecialAssignList(); });
  assert.equal(await a.locator('#specialAssignList > div').count(), 10);
  await run(a, () => app.closeModal('specialEventModal'));
  await run(a, id => { app.switchEvent(id); showTaskMasterSection('workspace'); app.setYearFilter('2nd'); }, sp);
  await addTask(a, sp, 'Mixed task', ['team-test-1']);
  const card = await a.textContent('#specialEventView [data-task-id]');
  assert.match(card, /Prahast Mohanty|Ayush Vaishraj|Sri Karan M/); assert.ok(!card.includes('Harsh Rajesh Koti') && !card.includes('Abhinav Pathak'));
  assert.equal(await run(a, () => document.getElementById('specialYearFilter').value), '2nd');

  // Availability page
  await run(a, () => { switchCadetFlowPage('availability'); document.getElementById('availabilityDay').value = 'TUE'; document.getElementById('availabilityHalf').value = '2'; renderAvailabilityResults(); setAvailFilter('year', 'all'); });
  const avail = await a.textContent('#availabilityResults');
  assert.ok(!avail.includes('Abhinav Pathak'), '3rd years are not part of availability'); assert.match(avail, /Sri Karan M/);

  // Archive page filter
  await run(a, async id => { app.switchEvent(id); await app.toggleArchiveCurrentEvent(); showTaskMasterSection('archive'); document.getElementById('archiveYearFilter').value = '3rd'; renderTaskArchive(); }, task);
  const arch = await a.textContent('#taskArchiveList');
  assert.match(arch, /Abhinav Pathak/); assert.ok(!arch.includes('Harsh Rajesh Koti'));

  // CSV + batch paste
  const csv = await run(a, id => { let out; const o = URL.createObjectURL; URL.createObjectURL = b => { out = b; return 'blob:x'; }; HTMLAnchorElement.prototype.click = () => {}; app.switchEvent(id); app.exportEventCSV(); URL.createObjectURL = o; return out.text(); }, sp);
  assert.match(csv.split('\n')[0], /"Wing","Year","Company","Team"/);
  assert.match(csv, /"Abhinav Pathak","SD","3rd","Naushera"/);
  await run(a, async () => { app.openRosterModal(); document.getElementById('batchPasteArea').value = 'CDT, Test One, SD, Kohima, 2\nLCPL, Test Two, SW, Jessami, 3rd\nCDT, Test Three, SD, Naushera'; await app.applyBatchPaste(); });
  assert.equal(await run(a, () => app.state.cadets.length), 40, 'pasted cadets are added, nobody is wiped');
  assert.deepEqual(await run(a, () => app.state.cadets.slice(-3).map(c => c.year)), ['2nd', '3rd', '']);
  noErrors(a);
}));

test('cadets with a reason are listed separately and not counted', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => { switchCadetFlowPage('roster'); showTaskMasterSection('workspace'); });
  const task = await run(a, () => app.state.activeEventId);
  const allBefore = Number(await a.textContent('#statusCount-all'));

  await run(a, id => app.toggleCadetStatus('cadet-2', id), task);
  await setPrompt(a, 'NCC camp clash');
  await run(a, id => app.promptReason('cadet-2', id), task); // reason on a done cadet → no longer done
  await setPrompt(a, 'Sick');
  await run(a, id => app.promptReason('cadet-3', id), task);

  assert.equal(await run(a, id => app.cadetStatus('cadet-2', app.findEvent(id)), task), 'excused');
  assert.equal(Number(await a.textContent('#statusCount-all')), allBefore - 2, 'not counted in totals');
  assert.equal(Number(await a.textContent('#statusCount-pending')), allBefore - 2);
  assert.ok(await a.isVisible('#excusedListCard'));
  const card = await a.textContent('#excusedListCard');
  assert.match(card, /Samahith M Rao/); assert.match(card, /Sick/); assert.match(card, /NCC camp clash/);
  assert.ok(!(await a.textContent('#cadetListContainer')).includes('Samahith M Rao'), 'not in the main list');
  assert.match(await a.textContent('#statExcusedNote'), /2 with reason/);

  const msg = await run(a, () => { let out; app.copyToClipboard = t => { out = t; }; app.copyWhatsAppAll(); return out; });
  const [pendingPart, reasonPart] = msg.split('With reason (not counted):');
  assert.ok(reasonPart && reasonPart.includes('Mani Karnica – NCC camp clash') && reasonPart.includes('Samahith M Rao – Sick'));
  assert.ok(!pendingPart.includes('Samahith'), 'not in pending list');

  // "Archive Completed" treats the task as complete when everyone else is done.
  await run(a, id => { const ev = app.findEvent(id); app.eventCadets(ev).forEach(c => { if (app.cadetStatus(c.id, ev) === 'pending') app.toggleCadetStatus(c.id, id); }); app.archiveCompletedTasks(); }, task);
  assert.equal(await run(a, id => app.findEvent(id).archived, task), true);
  noErrors(a);
}));

test('archive outcomes do not depend on having a deadline', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const outcomes = (id, cadets) => run(a, ({ id, cadets }) => { const ev = app.findEvent(id); return cadets.map(c => taskOutcome(ev, app.state.cadets.find(x => x.id === c))); }, { id, cadets });

  // No deadline
  const noDl = await createTask(a, 'No deadline task');
  await run(a, id => app.toggleCadetStatus('cadet-1', id), noDl);
  await setPrompt(a, 'Hospital');
  await run(a, id => app.promptReason('cadet-2', id), noDl);
  assert.deepEqual(await outcomes(noDl, ['cadet-1', 'cadet-2', 'cadet-3']), ['ontime', 'excused', 'pending'], 'open task: not done = pending');
  await run(a, id => { app.switchEvent(id); app.toggleArchiveCurrentEvent(); }, noDl);
  assert.deepEqual(await outcomes(noDl, ['cadet-1', 'cadet-2', 'cadet-3']), ['ontime', 'excused', 'missing'], 'archived task: not done = did not submit');

  // Future deadline, archived early
  const future = new Date(Date.now() + 86400000);
  const pad = n => String(n).padStart(2, '0');
  const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fut = await createTask(a, 'Future deadline', { deadline: local(future) });
  await run(a, id => { app.switchEvent(id); app.toggleArchiveCurrentEvent(); }, fut);
  assert.deepEqual(await outcomes(fut, ['cadet-4']), ['missing']);

  // Past deadline, completed after it
  const past = await createTask(a, 'Past deadline', { deadline: local(new Date(Date.now() - 3600000)) });
  await run(a, id => app.toggleCadetStatus('cadet-5', id), past);
  assert.deepEqual(await outcomes(past, ['cadet-5', 'cadet-6']), ['late', 'missing']);

  await run(a, () => showTaskMasterSection('archive'));
  const text = await a.textContent('#taskArchiveList');
  assert.match(text, /No deadline task/); assert.match(text, /Completed/); assert.match(text, /Did not submit/); assert.match(text, /With reason/);
  noErrors(a);
}));

test('members below lance corporal can view but not change anything', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await flush(a);
  db.account('user-c', { cadetId: 'cadet-3' }); // a CDT
  const v = await openAs(browser, db, 'user-v');
  const c = await openAs(browser, db, 'user-c');
  assert.equal(await run(v, () => app.state.cadets.length), 37, 'they see the shared data');
  const writes = db.writes;
  await run(c, id => { app.toggleCadetStatus('cadet-1', id); app.recordCallOut(['cadet-2']); }, await run(c, () => app.state.activeEventId));
  // Even a direct write is refused by the database for them.
  const direct = await run(c, () => app.supabase.from('cadetflow_state').update({ state: {} }).eq('id', 1).select('id').maybeSingle());
  assert.equal(direct.data, null);
  const task = await run(v, () => app.state.activeEventId);
  await run(v, id => { app.toggleCadetStatus('cadet-1', id); app.setTeamDone('x', true); }, task);
  await v.waitForTimeout(700);
  assert.equal(db.writes, writes);
  assert.equal(await run(v, () => app.canEdit()), false);
  noErrors(a, v);
}));

test('tasks can be limited to one or more years, together with a company', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Kohima is cadet-12..24. Make 12-15 1st year, 16-19 2nd, 20-22 3rd, 23-24 not set; Abhinav (Naushera) 1st.
  await run(a, () => {
    for (let i = 12; i <= 22; i++) app.updateCadetField(`cadet-${i}`, 'year', i <= 15 ? '1st' : i <= 19 ? '2nd' : '3rd');
    app.updateCadetField('cadet-29', 'year', '1st');
  });

  // New task form: Kohima + 1st & 2nd year, with the live hint and the "no year set" warning.
  const dialogs = [];
  a.on('dialog', d => dialogs.push(d.message()));
  await run(a, () => {
    app.openNewEventModal();
    document.getElementById('newEventTitleInput').value = 'Kohima juniors drill';
    document.getElementById('newEventScopeInput').value = 'Kohima';
    document.querySelectorAll('#newEventYears input').forEach(i => { i.checked = i.value === '1st' || i.value === '2nd'; });
    app.updateTaskScopeHint('new');
  });
  const hint = await a.textContent('#newEventScopeHint');
  assert.match(hint, /Includes 8 cadets \(Kohima Company · 1st & 2nd year\)/);
  assert.match(hint, /2 cadets have no year set/);
  const id = await run(a, async () => { await app.handleCreateEvent({ preventDefault() {} }); return app.state.activeEventId; });
  assert.ok(dialogs.some(m => m.includes('no year set') && m.includes('Sharanya G Holla')), 'warned about cadets without a year');
  await flush(a);

  const ev = dbEvent(db, id);
  assert.equal(ev.scope, 'Kohima');
  assert.deepEqual(ev.years, ['1st', '2nd']);
  const members = await run(a, id => app.eventCadets(app.findEvent(id)).map(c => c.id), id);
  assert.deepEqual(members, ['cadet-12', 'cadet-13', 'cadet-14', 'cadet-15', 'cadet-16', 'cadet-17', 'cadet-18', 'cadet-19']);

  // Workspace: counts, list, banner, label, year buttons and copy all follow the scope.
  await run(a, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, id);
  assert.equal(await a.textContent('#statusCount-all'), '8');
  assert.equal(await a.locator('#cadetListContainer > div').count(), 8);
  assert.match(await a.textContent('#scopeBannerText'), /Kohima Company · 1st & 2nd year/);
  assert.equal(await a.isVisible('#yearBtn-3rd'), false);
  assert.equal(await a.isVisible('#yearBtn-none'), false);
  assert.equal(await a.isVisible('#yearBtn-2nd'), true);
  await run(a, () => app.setYearFilter('2nd'));
  assert.equal(await a.locator('#cadetListContainer > div').count(), 4);
  const msg = await run(a, id => { let out; app.copyToClipboard = t => { out = t; }; app.setYearFilter('all'); app.copyWhatsAppAll(); return out; }, id);
  assert.equal((msg.match(/^\d+\./gm) || []).length, 8);
  assert.ok(!msg.includes('Tanvi Vinnakota') && !msg.includes('Abhinav Pathak'));
  await run(a, () => showTaskMasterSection('ongoing'));
  assert.match(await a.textContent('#ongoingTasksList'), /Kohima juniors drill · Kohima Company · 1st & 2nd year/);

  // Edit: switch to all companies + 1st year only; then ticking all three means "every year".
  await run(a, () => {
    app.openEditCurrentEventModal();
    document.getElementById('editEventScopeInput').value = 'All';
    document.querySelectorAll('#editEventYears input').forEach(i => { i.checked = i.value === '1st'; });
    app.handleSaveEditedEvent({ preventDefault() {} });
  });
  assert.deepEqual(await run(a, id => app.eventCadets(app.findEvent(id)).map(c => c.id), id), ['cadet-12', 'cadet-13', 'cadet-14', 'cadet-15', 'cadet-29']);
  await run(a, () => {
    app.openEditCurrentEventModal();
    document.querySelectorAll('#editEventYears input').forEach(i => { i.checked = true; });
    app.handleSaveEditedEvent({ preventDefault() {} });
  });
  await flush(a);
  assert.equal(dbEvent(db, id).years, undefined, 'all three years = every year (stored as no year limit)');
  assert.equal(await run(a, id => app.eventCadets(app.findEvent(id)).length, id), 37);
  noErrors(a);
}));

test('importing a list adds and updates cadets without wiping the roster', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const dialogs = [];
  a.on('dialog', d => dialogs.push(d.message()));
  const task = await run(a, () => app.state.activeEventId);
  await run(a, id => app.toggleCadetStatus('cadet-29', id), task); // Abhinav done on a task
  const paste = lines => run(a, ({ lines, mode }) => {
    app.openRosterModal();
    document.querySelector(`input[name="batchMode"][value="${mode || 'merge'}"]`).checked = true;
    document.getElementById('batchPasteArea').value = lines.join('\n');
    app.applyBatchPaste();
  }, { lines });

  await paste([
    'CDT, New Cadet One, SD, Kohima, 1',
    'cdt, new cadet two, SW, naushera',            // lower-case rank/company accepted
    'Abhinav Pathak, SD, Naushera, 2nd',           // existing (no rank given): only year changes
    'LCPL, abhinav  pathak, SD, Naushera, 2',      // same person again (spacing/case): later line wins → rank LCPL
    'Missing Company Person, SD',                  // new cadet without company → skipped
    'CDT, Bad Wing, XX, Kohima'                    // invalid wing → skipped
  ]);
  const cadets = await run(a, () => app.state.cadets);
  assert.equal(cadets.length, 39, '37 kept + 2 added');
  const abhinav = cadets.find(c => c.id === 'cadet-29');
  assert.equal(abhinav.name, 'Abhinav Pathak'); assert.equal(abhinav.rank, 'LCPL'); assert.equal(abhinav.year, '2nd');
  assert.equal(await run(a, id => app.peekRecord('cadet-29', app.findEvent(id)).done, task), true, 'existing cadet keeps their task record');
  const two = cadets.find(c => c.name === 'new cadet two');
  assert.equal(two.company, 'Naushera'); assert.equal(two.rank, 'CDT'); assert.equal(two.wing, 'SW');
  assert.ok(!cadets.some(c => c.name === 'Missing Company Person' || c.name === 'Bad Wing'));
  const msg = dialogs.find(m => m.includes('Add / update cadets'));
  assert.match(msg, /2 new cadet\(s\) will be added/); assert.match(msg, /1 existing cadet\(s\) will be updated/);
  assert.match(msg, /Everyone else in the roster stays as is/); assert.match(msg, /missing company/); assert.match(msg, /wing must be SD or SW/);

  // Pasting people who are already there with the same details changes nothing.
  dialogs.length = 0;
  await paste(['LCPL, Abhinav Pathak, SD, Naushera, 2']);
  assert.equal(dialogs.length, 0, 'no confirmation needed when nothing changes');
  assert.equal(await run(a, () => app.state.cadets.length), 39);

  // Replace mode is explicit, lists who goes, and keeps ids (and records) for cadets still listed.
  await run(a, () => { window.confirm = () => false; });
  await paste(['CDT, Harsh Rajesh Koti, SD, Jessami'], 'replace');
  assert.equal(await run(a, () => app.state.cadets.length), 39, 'cancelling replace keeps everyone');
  await run(a, () => { window.confirm = m => { window.__lastConfirm = m; return true; }; });
  await run(a, ({ lines }) => {
    document.querySelector('input[name="batchMode"][value="replace"]').checked = true;
    document.getElementById('batchPasteArea').value = lines.join('\n');
    app.applyBatchPaste();
  }, { lines: ['LCPL, Abhinav Pathak, SD, Naushera, 2', 'CDT, Brand New, SW, Kohima, 3'] });
  assert.match(await run(a, () => window.__lastConfirm), /38 cadet\(s\) NOT in the list will be REMOVED[\s\S]*… and 23 more/);
  const after = await run(a, () => app.state.cadets);
  assert.deepEqual(after.map(c => c.name), ['Abhinav Pathak', 'Brand New']);
  assert.equal(after[0].id, 'cadet-29', 'kept cadet keeps the same id');
  await flush(a);
  assert.equal(dbEvent(db, task).records['cadet-29'].done, true);
  noErrors(a);
}));

test('cadet roster page is open to everyone and can be filtered by company, year, wing and rank', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => {
    for (let i = 25; i <= 30; i++) app.updateCadetField(`cadet-${i}`, 'year', i <= 27 ? '2nd' : '1st');
  });
  await flush(a);

  const v = await openAs(browser, db, 'user-v'); // a member without powers
  await run(v, () => switchCadetFlowPage('home'));
  await v.click('button[aria-label="Open Cadet Roster"]');
  assert.equal(await v.isVisible('#directoryPage'), true);
  assert.equal(await v.getAttribute('#directoryTab', 'aria-selected'), 'true');
  assert.equal(await v.isVisible('text=Edit roster'), false, 'visitors cannot edit');
  assert.match(await v.textContent('#dirSummary'), /Showing: 37/);
  assert.equal(await v.locator('#dirResults section').count(), 3);

  await v.selectOption('#dirCompany', 'Naushera');
  await v.selectOption('#dirYear', '2nd');
  let names = await v.locator('#dirResults li').allTextContents();
  assert.equal(names.length, 3);
  assert.ok(names.some(n => n.includes('Dhriti Shetty')) && names.some(n => n.includes('Vivasvat')));
  assert.match(names[0], /LCPL/, 'senior rank listed first');

  await v.selectOption('#dirYear', 'all');
  await v.selectOption('#dirWing', 'SW');
  await v.selectOption('#dirRank', 'CDT');
  names = await v.locator('#dirResults li').allTextContents();
  assert.equal(names.length, 5, 'Naushera SW cadets (not the LCPL)');
  await v.fill('#dirSearch', 'chel');
  assert.equal(await v.locator('#dirResults li').count(), 1);
  assert.deepEqual((await v.locator('#dirRank option').allTextContents()), ['All ranks', 'CDT', 'LCPL'], 'only ranks on the roster');

  // Editors see the edit button; changes show up for visitors after refresh.
  await run(a, () => switchCadetFlowPage('directory'));
  assert.equal(await a.isVisible('text=Edit roster'), true);
  await run(a, () => app.updateCadetField('cadet-36', 'year', '3rd'));
  await flush(a);
  await refresh(v);
  assert.match(await v.textContent('#dirResults'), /3rd yr/);
  noErrors(a, v);
}));

test('availability: filters, WhatsApp copy, cycle, work call-outs and leaderboard', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Tuesday second half is free for: Abhinav Pathak (29, Naushera), Sri Karan M (16, Kohima),
  // Mattupalli (4, Jessami), Harsh Rajesh Koti (1, Jessami), Aryaman Sharma (14, Kohima), Dhriti Shetty (25, Naushera).
  await run(a, () => {
    app.updateCadetField('cadet-29', 'year', '2nd'); app.updateCadetField('cadet-16', 'year', '2nd'); app.updateCadetField('cadet-1', 'year', '1st');
    switchCadetFlowPage('availability');
    document.getElementById('availabilityDay').value = 'TUE'; document.getElementById('availabilityHalf').value = '2';
    renderAvailabilityResults();
  });
  const shown = () => a.locator('#availabilityResults .grid > div').allTextContents();
  assert.equal(await a.textContent('#availableCount'), '6');

  // Filter buttons
  await a.click('#availabilityFilters button[data-af="company"][data-val="Kohima"]');
  assert.equal(await a.getAttribute('#availabilityFilters button[data-af="company"][data-val="Kohima"]', 'aria-pressed'), 'true');
  assert.equal(await a.textContent('#availableCount'), '2');
  await a.click('#availabilityFilters button[data-af="year"][data-val="2nd"]');
  let list = await shown();
  assert.equal(list.length, 1); assert.match(list[0], /Sri Karan M/);
  await a.click('#availabilityFilters button[data-af="company"][data-val="all"]');
  await a.click('#availabilityFilters button[data-af="wing"][data-val="SD"]');
  assert.equal(await a.textContent('#availableCount'), '2', '2nd year SD: Abhinav + Sri Karan');
  await a.click('#availabilityFilters button[data-af="year"][data-val="all"]');
  await a.click('#availabilityFilters button[data-af="wing"][data-val="all"]');

  // Cycle: toggle on cards (not recorded → yes → no) and set in roster; then filter.
  // Cycle is set in the roster editor; everyone starts without one.
  assert.equal(await run(a, () => app.state.cadets.filter(c => cycleState(c) === 'yes').length), 0, 'everyone starts with no cycle');
  await run(a, () => { app.updateCadetField('cadet-29', 'cycle', 'yes'); app.updateCadetField('cadet-16', 'cycle', 'yes'); });
  const cycles = await run(a, () => ['cadet-29', 'cadet-1', 'cadet-16', 'cadet-4'].map(id => cycleState(app.state.cadets.find(c => c.id === id))));
  assert.deepEqual(cycles, ['yes', 'no', 'yes', 'no']);
  assert.equal(await a.locator('#availabilityResults button[onclick*="toggleCycle"]').count(), 0, 'cycle is not editable on the availability page');
  await a.click('#availabilityFilters button[data-af="cycle"][data-val="yes"]');
  list = await shown();
  assert.equal(list.length, 2); assert.ok(list.every(t => /\bCycle\b/.test(t)));

  // WhatsApp copy: whole shown list, or only the ticked cadets.
  await run(a, () => { app.copyToClipboard = t => { window.__copied = t; }; });
  await a.click('#availCopyBtn');
  let msg = await run(a, () => window.__copied);
  assert.match(msg, /^\*Available cadets – Tuesday · Second Half\*\n\(has cycle\)\n1\. /);
  assert.match(msg, /CDT Abhinav Pathak \(Naushera, 2nd yr\) \(cycle\)/);
  assert.equal((msg.match(/^\d+\./gm) || []).length, 2);
  await a.click('#availabilityFilters button[data-af="cycle"][data-val="all"]');

  // Call-outs: tick two and mark; +1 on one card; counts and "fewest first" ordering.
  await run(a, () => { toggleAvailTick('cadet-29', true); toggleAvailTick('cadet-16', true); renderAvailabilityResults(); });
  assert.match(await a.textContent('#availCopyBtn'), /Copy ticked \(2\)/);
  await run(a, () => { window.prompt = () => 'Carry chairs to the hall'; });
  await a.click('#availCallBtn');
  await run(a, () => { window.prompt = () => ''; app.recordCallOut(['cadet-29']); });
  const counts = await run(a, () => { const { counts } = callCounts(); return counts; });
  assert.deepEqual(counts, { 'cadet-29': 2, 'cadet-16': 1 });
  list = await shown();
  assert.match(list[list.length - 1], /Abhinav Pathak[\s\S]*Called 2×/, 'most-called goes last when sorting by fewest calls');
  assert.match(await a.textContent('#dutyLog'), /Carry chairs to the hall/);

  // Leaderboard: ranking, filters and period.
  const board = await a.locator('#dutyLeaderboard li').allTextContents();
  assert.match(board[0], /^\s*1[\s\S]*Abhinav Pathak[\s\S]*2×/); assert.match(board[1], /^\s*2[\s\S]*Sri Karan M[\s\S]*1×/);
  await a.click('#availabilityFilters button[data-af="company"][data-val="Kohima"]');
  assert.equal(await a.locator('#dutyLeaderboard li').count(), 1);
  await a.click('#availabilityFilters button[data-af="company"][data-val="all"]');
  await run(a, () => { app.state.duties.forEach(d => { if (d.work === 'Carry chairs to the hall') d.at = Date.now() - 40 * 86400000; }); });
  await a.click('button[data-af="period"][data-val="30"]');
  const recent = await a.locator('#dutyLeaderboard li').allTextContents();
  assert.equal(recent.length, 1); assert.match(recent[0], /Abhinav Pathak[\s\S]*1×/);
  await a.click('button[data-af="period"][data-val="all"]');

  // Undo a call-out; everything saved to the shared roster.
  const firstId = await run(a, () => app.state.duties.find(d => d.work === '').id);
  await run(a, id => app.deleteCallOut(id), firstId);
  await flush(a);
  assert.equal(db.row.state.duties.length, 1);
  assert.deepEqual(db.row.state.duties[0].cadetIds.sort(), ['cadet-16', 'cadet-29']);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-29').cycle, 'yes');

  // Two editors recording call-outs at the same time: both kept.
  const b = await openAs(browser, db, 'user-b');
  db.autoNotify = false;
  await run(a, () => { window.prompt = () => 'Flag duty'; app.recordCallOut(['cadet-4']); });
  await run(b, () => { switchCadetFlowPage('availability'); window.prompt = () => 'Gate duty'; app.recordCallOut(['cadet-14']); });
  await flush(a); await flush(b);
  assert.deepEqual(db.row.state.duties.map(d => d.work).sort(), ['Carry chairs to the hall', 'Flag duty', 'Gate duty']);

  // Members without powers see counts and leaderboard but no editing controls.
  const v = await openAs(browser, db, 'user-v');
  await run(v, () => { switchCadetFlowPage('availability'); document.getElementById('availabilityDay').value = 'TUE'; document.getElementById('availabilityHalf').value = '2'; renderAvailabilityResults(); });
  assert.equal(await v.locator('#availabilityResults input[type=checkbox]').count(), 0);
  assert.equal(await v.isVisible('#availCallBtn'), false);
  assert.equal(await v.isVisible('#availCopyBtn'), true);
  assert.match(await v.textContent('#dutyLeaderboard'), /Abhinav Pathak/);
  noErrors(a, b, v);
}));

test('roster editor: search, filters, in-place edits, add, bulk changes and remove', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const dialogs = [];
  a.on('dialog', d => dialogs.push(d.message()));
  await run(a, () => { switchCadetFlowPage('directory'); });
  await a.click('text=Edit roster');
  assert.equal(await a.isVisible('#rosterModal'), true);
  await a.waitForFunction(() => document.activeElement && document.activeElement.id === 'rosterSearch', null, { timeout: 2000 });
  assert.match(await a.textContent('#rosterShowing'), /Showing all 37 cadets/);
  assert.match(await a.textContent('#rosterSummary'), /0 with a cycle/, 'nobody has a cycle to start with');
  assert.equal(await a.locator(`#modalRosterTableBody button[onclick*="'cycle'"][aria-pressed="false"]`).count(), 37);

  // Search (case/space-insensitive) + filters
  await a.fill('#rosterSearch', '  ABHINAV ');
  assert.equal(await a.locator('#modalRosterTableBody tr').count(), 1);
  await a.fill('#rosterSearch', '');
  await a.selectOption('#rosterFilterCompany', 'Kohima');
  await a.selectOption('#rosterFilterWing', 'SW');
  assert.equal(await a.locator('#modalRosterTableBody tr').count(), 5);
  assert.match(await a.textContent('#rosterShowing'), /Showing 5 of 37/);

  // In-place edits: the row stays where it is, scroll/focus not lost, saved immediately.
  const row = a.locator('#modalRosterTableBody tr[data-cadet-id="cadet-22"]');
  await row.locator('button[title="Click to change"]').click();          // cycle → yes
  assert.equal(await row.locator('button[title="Click to change"]').textContent(), 'Yes');
  await row.locator('select[aria-label="Year"]').selectOption('2nd');
  await row.locator('input[aria-label="Name"]').fill('Sejal Sharma');
  await row.locator('input[aria-label="Name"]').press('Enter');
  const sejal = await run(a, () => app.state.cadets.find(c => c.id === 'cadet-22'));
  assert.deepEqual([sejal.name, sejal.cycle, sejal.year], ['Sejal Sharma', 'yes', '2nd']);
  assert.match(await a.textContent('#rosterSummary'), /1 with a cycle/);
  // Empty name is refused
  await row.locator('input[aria-label="Name"]').fill('   ');
  await row.locator('input[aria-label="Name"]').press('Enter');
  assert.equal(await row.locator('input[aria-label="Name"]').inputValue(), 'Sejal Sharma');

  // Filter by cycle
  await run(a, () => app.resetRosterFilters());
  await a.selectOption('#rosterFilterCycle', 'yes');
  assert.equal(await a.locator('#modalRosterTableBody tr').count(), 1);
  await run(a, () => app.resetRosterFilters());

  // Add a cadet with the form; duplicate name asks first.
  await a.click('#addCadetSection summary');
  await a.selectOption('#addCadetRank', 'LCPL');
  await a.fill('#addCadetName', 'Riya  Menon');
  await a.selectOption('#addCadetWing', 'SW');
  await a.selectOption('#addCadetCompany', 'Jessami');
  await a.selectOption('#addCadetYear', '1st');
  await a.selectOption('#addCadetCycle', 'yes');
  await a.press('#addCadetName', 'Enter');
  const riya = await run(a, () => app.state.cadets.find(c => c.name === 'Riya Menon'));
  assert.deepEqual([riya.rank, riya.wing, riya.company, riya.year, riya.cycle], ['LCPL', 'SW', 'Jessami', '1st', 'yes']);
  assert.equal(await a.locator('#modalRosterTableBody tr').count(), 1, 'new cadet is shown');
  await a.fill('#addCadetName', 'riya menon');
  await run(a, () => { window.confirm = () => false; });
  await a.press('#addCadetName', 'Enter');
  assert.equal(await run(a, () => app.state.cadets.filter(c => c.name.toLowerCase() === 'riya menon').length), 1, 'duplicate not added when declined');
  await run(a, () => { window.confirm = () => true; });

  // Bulk: tick Naushera, set cycle yes, then rank; remove two ticked.
  await run(a, () => app.resetRosterFilters());
  await a.selectOption('#rosterFilterCompany', 'Naushera');
  await a.check('#rosterTickAll');
  assert.equal(await a.textContent('#rosterTickCount'), '13');
  await a.selectOption('#rosterBulkField', 'cycle');
  await a.selectOption('#rosterBulkValue', 'yes');
  await a.click('#rosterBulkBar button:has-text("Apply")');
  assert.equal(await run(a, () => app.state.cadets.filter(c => c.company === 'Naushera' && c.cycle === 'yes').length), 13);
  assert.equal(await a.isVisible('#rosterBulkBar'), false, 'ticks cleared after applying');
  await a.locator('#modalRosterTableBody tr[data-cadet-id="cadet-36"] input[type=checkbox]').check();
  await a.locator('#modalRosterTableBody tr[data-cadet-id="cadet-37"] input[type=checkbox]').check();
  await a.click('#rosterBulkBar button:has-text("Remove ticked")');
  assert.equal(await run(a, () => app.state.cadets.length), 36);
  // Single remove asks for confirmation.
  await run(a, () => { window.confirm = () => false; });
  await a.locator('#modalRosterTableBody tr[data-cadet-id="cadet-35"] button[aria-label^="Remove"]').click();
  assert.equal(await run(a, () => app.state.cadets.length), 36, 'cancel keeps the cadet');

  await flush(a);
  assert.equal(db.row.state.cadets.length, 36);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-22').name, 'Sejal Sharma');
  // Other pages updated
  await run(a, () => { app.closeModal('rosterModal'); switchCadetFlowPage('directory'); });
  assert.match(await a.textContent('#dirResults'), /Riya Menon/);
  noErrors(a);
}));

test('interface uses no emoji and no pointer circle', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => { app.recordCallOut = app.recordCallOut; switchCadetFlowPage('availability'); });
  const pages = ['home', 'availability', 'directory', 'roster'];
  for (const p of pages) {
    await run(a, p => switchCadetFlowPage(p), p);
    const text = await a.evaluate(() => document.body.innerText);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2705}]/u.test(text), `no emoji on ${p}`);
  }
  assert.equal(await a.locator('#fxRing').count(), 0);
  noErrors(a);
}));

test('bug fixes: pasted lines without rank, every rank filterable, no emails shown, broken data, Escape', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // A 4-part line without a rank is Name, Wing, Company, Year
  assert.deepEqual((await run(a, () => app.parseRosterLine('New Person, SW, Kohima, 2'))).fields, { name: 'New Person', wing: 'SW', company: 'Kohima', year: '2nd' });
  assert.deepEqual((await run(a, () => app.parseRosterLine('SGT, New Person, SW, Kohima'))).fields, { rank: 'SGT', name: 'New Person', wing: 'SW', company: 'Kohima' });

  // Every rank on the roster gets a filter button with a count
  await run(a, () => { switchCadetFlowPage('roster'); showTaskMasterSection('workspace'); app.updateCadetField('cadet-5', 'rank', 'SGT'); app.updateCadetField('cadet-6', 'rank', 'JUO'); });
  assert.deepEqual(await a.locator('#rankFilterButtons button').allTextContents(), ['JUO (1)', 'SGT (1)', 'LCPL (4)', 'CDT (31)']);
  await a.click('#rankBtn-SGT');
  assert.equal(await a.locator('#cadetListContainer > div').count(), 1);
  await a.click('#rankBtn-all');

  // Call-outs record a name, never the email address
  await run(a, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-1']); });
  await flush(a);
  assert.equal(db.row.state.duties[0].by, 'user-a');
  assert.ok(!JSON.stringify(db.row.state).includes('@example.com'), 'no email in shared data');
  await run(a, () => { app.applyState({ ...app.serializableState(), duties: [{ id: 'old', at: 1, cadetIds: ['cadet-2'], work: '', by: 'someone@college.edu' }] }); });
  assert.equal(await run(a, () => app.state.duties[0].by), 'someone', 'old emails are trimmed on load');

  // A backup with damaged cadet records doesn't break the page
  await run(a, () => {
    app.applyState({ cadets: [{ id: 'x1' }, null, { id: 'x2', name: '  Asha  ', rank: 'lcpl', wing: 'SW', company: 'Kohima' }, { name: 'No id' }], events: app.state.events, activeEventId: app.state.activeEventId });
    app.rerenderAfterRemote(); switchCadetFlowPage('directory'); document.getElementById('dirSearch').value = 'a'; renderRosterDirectory();
  });
  const cadets = await run(a, () => app.state.cadets.map(c => [c.name, c.rank, c.wing]));
  assert.deepEqual(cadets, [['Unnamed cadet', 'CDT', 'SD'], ['Asha', 'LCPL', 'SW'], ['No id', 'CDT', 'SD']]);

  // Escape closes the open dialog
  await run(a, () => app.openRosterModal());
  await a.keyboard.press('Escape');
  assert.equal(await a.isVisible('#rosterModal'), false);
  noErrors(a);
}));

test('phone gets a bottom tab bar and card rows; laptop keeps the top tabs and table', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');

  // Laptop
  await a.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await a.isVisible('#phoneNav'), false);
  await run(a, () => switchCadetFlowPage('availability'));
  assert.equal(await a.isVisible('#availabilityTab'), true);
  await run(a, () => app.openRosterModal());
  assert.equal(await a.locator('#rosterTableWrap thead').isVisible(), true);
  await run(a, () => app.closeModal('rosterModal'));

  // Phone
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.isVisible('#phoneNav'), true);
  assert.equal(await a.isVisible('#availabilityTab'), false, 'top tabs give way to the bottom bar');
  assert.equal(await a.locator('#phoneNav [aria-current="page"]').textContent(), 'Availability');
  await a.click('#phoneNav [data-page="directory"]');
  assert.equal(await a.isVisible('#directoryPage'), true);
  assert.equal(await a.locator('#phoneNav [aria-current="page"]').textContent(), 'Roster');
  await a.click('#phoneNav [data-page="home"]');
  assert.equal(await a.isVisible('#homePage'), true);

  // Roster editor rows become cards that fit the screen
  await run(a, () => app.openRosterModal());
  assert.equal(await a.locator('#rosterTableWrap thead').isVisible(), false);
  const row = a.locator('#modalRosterTableBody tr').first();
  assert.equal(await row.evaluate(r => getComputedStyle(r).display), 'grid');
  const fits = await a.evaluate(() => [...document.querySelectorAll('#modalRosterTableBody tr:first-child select, #modalRosterTableBody tr:first-child input, #modalRosterTableBody tr:first-child button')]
    .every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  assert.ok(fits, 'every control in a roster card is on screen');
  noErrors(a);
}));

test('a new task can be for hand-picked cadets instead of companies and years', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Create through the dialog: pick two Kohima cadets via the filters, and one more by search
  const id = await run(a, () => {
    app.openNewEventModal();
    document.getElementById('newEventTitleInput').value = 'Guard duty';
    app.setTaskWho('new', 'pick');
    // nothing picked yet: refused
    app.handleCreateEvent({ preventDefault() {} });
    return app.state.events[0].title;
  });
  assert.notEqual(id, 'Guard duty', 'a picked task needs at least one cadet');
  const created = await run(a, () => {
    document.getElementById('newEventTitleInput').value = 'Guard duty';
    document.getElementById('newPickCoy').value = 'Kohima'; app.renderTaskPicker('new');
    const boxes = [...document.querySelectorAll('#newPickList input')];
    boxes.slice(0, 2).forEach(b => { b.checked = true; b.dispatchEvent(new Event('change')); });
    document.getElementById('newPickCoy').value = 'all';
    document.getElementById('newPickSearch').value = 'abhinav'; app.renderTaskPicker('new');
    app.pickAllShown('new', true);
    const count = document.getElementById('newPickCount').textContent;
    app.handleCreateEvent({ preventDefault() {} });
    const ev = app.state.events[0];
    return { count, ev, members: app.eventCadets(ev).map(c => c.id), label: eventScopeLabel(ev) };
  });
  assert.equal(created.count, '3 cadets picked');
  assert.equal(created.ev.title, 'Guard duty');
  assert.equal(created.ev.scope, 'All');
  assert.equal(created.ev.cadetIds.length, 3);
  assert.deepEqual(created.members.slice().sort(), created.ev.cadetIds.slice().sort(), 'only the picked cadets are in the task');
  assert.ok(created.ev.cadetIds.includes('cadet-29'));
  assert.equal(created.label, '3 picked cadets');

  // The task list shows just them; copying the pending list too
  await run(a, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, created.ev.id);
  assert.equal(await a.locator('#cadetListContainer > div').count(), 3);
  assert.match(await a.textContent('#scopeBannerText'), /3 picked cadets/);
  const msg = await run(a, () => { let out; app.copyToClipboard = t => { out = t; }; app.copySmartPending(); return out; });
  assert.equal((msg.match(/^\d+\./gm) || []).length, 3);

  // Edit: the picker opens with the same cadets; untick one
  await run(a, () => {
    app.openEditCurrentEventModal();
    document.getElementById('editPickShow').value = 'picked'; app.renderTaskPicker('edit');
    const first = document.querySelector('#editPickList input'); first.checked = false; first.dispatchEvent(new Event('change'));
    app.handleSaveEditedEvent({ preventDefault() {} });
  });
  await flush(a);
  assert.equal(dbEvent(db, created.ev.id).cadetIds.length, 2);

  // Switch it back to a whole company
  await run(a, () => {
    app.openEditCurrentEventModal();
    app.setTaskWho('edit', 'group');
    document.getElementById('editEventScopeInput').value = 'Naushera';
    app.handleSaveEditedEvent({ preventDefault() {} });
  });
  await flush(a);
  const ev = dbEvent(db, created.ev.id);
  assert.equal(ev.scope, 'Naushera');
  assert.equal(ev.cadetIds, undefined);
  assert.equal(await a.locator('#cadetListContainer > div').count(), 13);
  noErrors(a);
}));

test('group tasks: one mark for everyone (normal task) or one mark per team (special event task)', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Normal task for 3 picked cadets, done once by the group
  const id = await run(a, () => {
    app.openNewEventModal();
    document.getElementById('newEventTitleInput').value = 'Clean the store room';
    app.setTaskWho('new', 'pick');
    ['cadet-1', 'cadet-2', 'cadet-3'].forEach(c => app.taskPick.new.ids.add(c));
    app.setCompletion('newCompletion', 'group');
    app.handleCreateEvent({ preventDefault() {} });
    const ev = app.state.events[0];
    switchCadetFlowPage('roster'); app.switchEvent(ev.id); showTaskMasterSection('workspace');
    return ev.id;
  });
  assert.equal(await a.isVisible('#groupTaskCard'), true);
  assert.equal(await a.isVisible('#bulkMarkBar'), false);
  assert.equal(await a.locator('#cadetListContainer button[onclick*="toggleCadetStatus"]').count(), 0, 'no per-cadet mark buttons');
  await a.click('#groupTaskCard button[onclick*="setGroupDone"]');
  await flush(a);
  let ev = dbEvent(db, id);
  assert.equal(ev.completion, 'group');
  assert.equal(ev.groupDone.done, true);
  assert.deepEqual(ev.records, {}, 'no per-cadet records');
  assert.deepEqual(await run(a, id => { const ev = app.findEvent(id); return app.eventCadets(ev).map(c => app.cadetStatus(c.id, ev)); }, id), ['done', 'done', 'done']);
  // Reasons don't apply; toggling any cadet toggles the group
  await setPrompt(a, 'Sick');
  await run(a, id => app.promptReason('cadet-1', id), id);
  await run(a, id => app.toggleCadetStatus('cadet-2', id), id);
  await flush(a);
  ev = dbEvent(db, id);
  assert.equal(ev.groupDone.done, false); assert.deepEqual(ev.records, {});
  // Switching back to "each cadet" works
  await run(a, () => { app.openEditCurrentEventModal(); app.setCompletion('editCompletion', 'each'); app.handleSaveEditedEvent({ preventDefault() {} }); });
  await flush(a);
  ev = dbEvent(db, id);
  assert.equal(ev.completion, undefined); assert.equal(ev.groupDone, undefined);

  // Special event task done once per team
  const sp = await createSpecial(a, 'Camp', [{ name: 'Red', cadets: ['cadet-5', 'cadet-6'] }, { name: 'Blue', cadets: ['cadet-7'] }]);
  const tid = await run(a, sp => {
    app.openSpecialTaskModal(sp);
    document.getElementById('specialTaskTitle').value = 'Pitch one tent';
    document.querySelectorAll('#specialTaskTeams input').forEach(b => { b.checked = true; });
    app.setCompletion('specialTaskCompletion', 'group');
    app.saveSpecialTask();
    const ev = app.findEvent(sp); return ev.tasks[0].id;
  }, sp);
  await run(a, ({ sp, tid }) => app.toggleCadetStatus('cadet-5', sp, tid), { sp, tid });
  await flush(a);
  let t = dbEvent(db, sp).tasks[0];
  assert.equal(t.completion, 'group');
  assert.equal(t.teamDone['team-test-1'].done, true);
  assert.deepEqual(t.records, {});
  assert.deepEqual(await run(a, sp => { const ev = app.findEvent(sp); return ['cadet-5', 'cadet-6', 'cadet-7'].map(c => app.cadetStatus(c, ev)); }, sp), ['done', 'done', 'pending']);
  assert.match(await a.textContent(`#specialEventView [data-task-id="${tid}"]`), /1\/2 teams done/);
  await run(a, ({ sp }) => app.setTeamDone('team-test-2', true, sp), { sp });
  await flush(a);
  assert.equal(dbEvent(db, sp).tasks[0].teamDone['team-test-2'].done, true);
  // Taking a team off the task drops its mark
  await run(a, ({ sp, tid }) => { app.openSpecialTaskModal(sp, tid); document.querySelector('#specialTaskTeams input[value="team-test-2"]').checked = false; app.saveSpecialTask(); }, { sp, tid });
  await flush(a);
  t = dbEvent(db, sp).tasks[0];
  assert.deepEqual(Object.keys(t.teamDone), ['team-test-1']);
  noErrors(a);
}));

test('uniform orders: next order totals, beret sizes, who needs it, place, arrive and hand over; every member can view', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => switchCadetFlowPage('uniform'));
  assert.equal(await a.isVisible('#uniformContent'), true);
  const req = (cadets, items, sizes = {}, extra = {}) => run(a, ({ cadets, items, sizes, extra }) => {
    cadets.forEach(id => toggleUniformCadet(id, true));
    items.forEach(k => toggleUniformItem(k));
    Object.entries(sizes).forEach(([id, s]) => { const el = document.querySelector(`#uniSizeList input[data-cadet="${id}"]`); el.value = s; el.dispatchEvent(new Event('input')); });
    if (extra.custom) document.getElementById('uniCustom').value = extra.custom;
    if (extra.qty) document.getElementById('uniQty').value = extra.qty;
    createUniformRequests();
  }, { cadets, items, sizes, extra });

  // Each beret needs that cadet's size
  await req(['cadet-1', 'cadet-2'], ['beret', 'hackle'], { 'cadet-1': '57' });
  assert.equal(await run(a, () => app.state.uniform.length), 0, 'refused: cadet-2 has no beret size');
  await run(a, () => document.querySelector('#uniSizeList input[data-cadet="cadet-2"]').value = '58');
  await run(a, () => { UNI.sizes['cadet-2'] = '58'; createUniformRequests(); });
  await req(['cadet-3'], ['beret', 'custom'], { 'cadet-3': '57' }, { custom: 'Whistle cord', qty: 2 });
  await flush(a);
  assert.equal(db.row.state.uniform.length, 6);
  assert.deepEqual(db.row.state.uniform.filter(r => r.item === 'beret').map(r => r.size).sort(), ['57', '57', '58']);
  assert.ok(db.row.state.uniform.filter(r => r.item !== 'beret').every(r => r.size === undefined), 'only berets have sizes');

  // Next order: totals per item, berets split by size
  const items = await a.textContent('#uniOrderItems');
  assert.match(items, /Hackle[\s\S]*2 cadets\s*2/);
  assert.match(items, /Beret\s*size 57 ×3 · size 58 ×1/, 'cadet-3 asked for 2 berets');
  assert.match(items, /Whistle cord[\s\S]*1 cadet\s*2/);
  // Tap an item: who needs it, berets grouped by size
  await a.click('#uniOrderItems details[data-key="beret"] summary');
  const beret = await a.textContent('#uniOrderItems details[data-key="beret"] > div');
  assert.match(beret, /Size 57[\s\S]*Size 58/);
  assert.equal(await a.locator('#uniOrderItems details[data-key="beret"] li').count(), 3);
  assert.equal(await a.locator('#uniOrderItems details[data-key="hackle"] li').first().isVisible(), false, 'other items stay closed');
  const copy = () => run(a, () => { let out; app.copyToClipboard = t => { out = t; }; copyUniformOrderList(); return out; });
  assert.match(await copy(), /Beret – 4 \(size 57 ×3, size 58 ×1\)/);
  assert.match(await copy(), /Hackle – 2/);

  // Place the order: it becomes Order 1 and the next order starts empty
  await run(a, () => placeUniformOrder());
  await flush(a);
  const ids = new Set(db.row.state.uniform.map(r => r.orderId));
  assert.equal(ids.size, 1); assert.ok(db.row.state.uniform.every(r => r.status === 'ordered'));
  assert.match(await a.textContent('#uniOrderHead'), /Order 1/);
  await run(a, () => selectUniformOrder('next'));
  assert.match(await a.textContent('#uniOrderItems'), /Nothing in the next order/);
  // New requests go into the next order only; old ones are not mixed in
  await req(['cadet-4'], ['hackle']);
  assert.equal(await a.locator('#uniOrderItems details').count(), 1);
  assert.match(await a.textContent('#uniOrderHead'), /1 item for 1 cadet/);
  // A cadet's beret size is filled in from last time
  await run(a, () => { toggleUniformCadet('cadet-1', true); toggleUniformItem('beret'); });
  assert.equal(await a.inputValue('#uniSizeList input[data-cadet="cadet-1"]'), '57');
  await run(a, () => { toggleUniformCadet('cadet-1', false); toggleUniformItem('beret'); });

  // Order 1 arrives (one item first, then the rest); items are handed over one by one
  const order1 = [...ids][0];
  await run(a, id => selectUniformOrder(id), order1);
  const one = db.row.state.uniform.find(r => r.item === 'hackle' && r.cadetId === 'cadet-1').id;
  assert.equal(await run(a, id => { setUniformReceived(id, true); return uniformFind([id])[0].status; }, one), 'ordered', 'cannot hand over before it arrives');
  await run(a, id => setUniformArrived(id, true), one);
  assert.match(await a.textContent('#uniOrderHead'), /1 of 6 arrived/);
  assert.equal(await a.isVisible('#uniOrderActions button:has-text("Undo placing")'), false, 'cannot undo once something arrived');
  await run(a, () => markUniformOrderArrived());
  await run(a, id => setUniformReceived(id, true), one); // no price set: handed over after a confirm
  await flush(a);
  assert.equal(db.row.state.uniform.filter(r => r.orderId === order1 && r.status === 'arrived').length, 5);
  assert.equal(db.row.state.uniform.find(r => r.id === one).status, 'received');
  assert.match(await a.textContent('#uniOrderHead'), /arrived · 1 of 6 collected/);
  assert.match(await a.textContent('#uniOrderSelect'), /Order 1 · .* · arrived/);

  // Place and undo order 2
  await run(a, () => { selectUniformOrder('next'); placeUniformOrder(); });
  assert.match(await a.textContent('#uniOrderHead'), /Order 2/);
  await run(a, () => undoUniformOrder());
  assert.equal(await run(a, () => uniformNextRequests().length), 1);

  // Older requests that were ordered before orders existed are grouped by when they were ordered
  await run(a, () => {
    app.state.uniform = normalizeUniform([...app.state.uniform,
      { id: 'old-1', cadetId: 'cadet-5', item: 'belt', qty: 1, status: 'ordered', requestedAt: 1, orderedAt: 1000, amount: 300 },
      { id: 'old-2', cadetId: 'cadet-6', item: 'belt', qty: 1, status: 'received', requestedAt: 1, orderedAt: 1000 }]);
    renderUniformPage();
  });
  assert.equal(await run(a, () => uniformOrders().length), 2);
  assert.equal(await run(a, () => uniformOrders().find(o => o.id === 'order-1000').number), 1, 'oldest order is number 1');

  // Another editor's request merges with ours
  await flush(a);
  const b = await openAs(browser, db, 'user-b');
  await run(b, () => { toggleUniformCadet('cadet-9', true); toggleUniformItem('belt'); createUniformRequests(); });
  await run(a, () => { toggleUniformCadet('cadet-8', true); toggleUniformItem('socks'); createUniformRequests(); });
  await flush(b); await flush(a);
  assert.equal(db.row.state.uniform.filter(r => r.status === 'requested').length, 3);

  // Every member can see the orders and who needs what; only the CQMS and the administrator change them
  db.account('user-c', { cadetId: 'cadet-5' }); // a CDT
  const v = await openAs(browser, db, 'user-v');
  await run(v, () => switchCadetFlowPage('uniform'));
  assert.equal(await v.isVisible('#uniformContent'), true);
  assert.equal(await v.locator('#uniOrderItems details').count(), 3);
  assert.equal(await v.isVisible('#uniOrderActions button:has-text("Place order")'), false);
  assert.equal(await v.isVisible('#uniNewHeading'), false, 'no new-request form for visitors');
  await v.click('#uniOrderItems details summary');
  assert.equal(await v.locator('#uniOrderItems li button:has-text("Remove")').first().isVisible(), false);
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => switchCadetFlowPage('uniform'));
  assert.equal(await c.isVisible('#uniformViewOnly'), true);
  assert.equal(await v.isVisible('#uniMine'), false, 'no "My uniform" without a cadet on the roster');
  assert.match(await c.textContent('#uniMine'), /My uniform[\s\S]*Belt/, "the cadet's own items");
  noErrors(a, b, v, c);
}));

test('group tasks take plain updates (optionally flagged as an issue)', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const id = await run(a, () => {
    app.openNewEventModal();
    document.getElementById('newEventTitleInput').value = 'Set up the stage';
    app.setCompletion('newCompletion', 'group');
    app.handleCreateEvent({ preventDefault() {} });
    const ev = app.state.events[0];
    switchCadetFlowPage('roster'); app.switchEvent(ev.id); showTaskMasterSection('workspace');
    return ev.id;
  });
  assert.equal(await a.locator('#groupUpdateModal input[type="range"]').count(), 0, 'no progress slider');
  // An empty update is refused
  await run(a, id => { app.openGroupUpdate(id); app.saveGroupUpdate(); }, id);
  assert.equal(await a.isVisible('#groupUpdateError'), true);
  await run(a, () => { document.getElementById('groupUpdateText').value = 'Short of 2 chairs'; document.getElementById('groupUpdateIssue').checked = true; app.saveGroupUpdate(); });
  await run(a, id => { app.openGroupUpdate(id); document.getElementById('groupUpdateText').value = 'Chairs found'; app.saveGroupUpdate(); }, id);
  await flush(a);
  const ev = dbEvent(db, id);
  assert.deepEqual(ev.updates.map(u => [u.text, !!u.issue, 'progress' in u]), [['Chairs found', false, false], ['Short of 2 chairs', true, false]]);
  const card = await a.textContent('#groupTaskCard');
  assert.match(card, /Chairs found/); assert.match(card, /Short of 2 chairs/); assert.match(card, /Issue/);
  assert.ok(!/%/.test(card), 'no percentages');
  // Delete an update
  await run(a, ({ id, u }) => app.deleteGroupUpdate(id, '', u), { id, u: ev.updates[1].id });
  await flush(a);
  assert.equal(dbEvent(db, id).updates.length, 1);

  // Special event: updates per team on a group task
  const sp = await createSpecial(a, 'Camp', [{ name: 'Red', cadets: ['cadet-5'] }, { name: 'Blue', cadets: ['cadet-7'] }]);
  const tid = await run(a, sp => {
    app.openSpecialTaskModal(sp); document.getElementById('specialTaskTitle').value = 'Build a gate';
    document.querySelectorAll('#specialTaskTeams input').forEach(b => { b.checked = true; });
    app.setCompletion('specialTaskCompletion', 'group'); app.saveSpecialTask();
    return app.findEvent(sp).tasks[0].id;
  }, sp);
  await run(a, ({ sp, tid }) => { app.openGroupUpdate(sp, tid, 'team-test-2'); document.getElementById('groupUpdateText').value = 'Ropes ordered'; app.saveGroupUpdate(); }, { sp, tid });
  await flush(a);
  assert.equal(dbEvent(db, sp).tasks[0].updates[0].teamId, 'team-test-2');
  assert.match(await a.textContent(`#specialEventView [data-task-id="${tid}"]`), /Ropes ordered/);

  // Members without powers see updates but can't post
  const v = await openAs(browser, db, 'user-v');
  await run(v, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, id);
  assert.match(await v.textContent('#groupTaskCard'), /Chairs found/);
  assert.equal(await v.locator('#groupTaskCard button:has-text("Post update")').isVisible(), false);
  noErrors(a, v);
}));

test('CSM and CQMS ranks, and cadets with no company', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Roster editor: making someone CSM moves them to "No company"
  await run(a, () => { app.openRosterModal(); const sel = document.querySelector('#modalRosterTableBody tr[data-cadet-id="cadet-1"] select[aria-label="Rank"]'); sel.value = 'CSM'; sel.dispatchEvent(new Event('change')); });
  // Add a CQMS through the form
  await run(a, () => {
    document.getElementById('addCadetName').value = 'Ravi Kumar';
    const r = document.getElementById('addCadetRank'); r.value = 'CQMS'; r.dispatchEvent(new Event('change'));
    app.addCadetFromForm();
  });
  // A pasted line can say "No company"
  assert.deepEqual((await run(a, () => app.parseRosterLine('CQMS, Asha Rao, SW, No company'))).fields, { rank: 'CQMS', name: 'Asha Rao', wing: 'SW', company: 'No company' });
  await flush(a);
  const cadets = db.row.state.cadets;
  assert.deepEqual([cadets.find(c => c.id === 'cadet-1').rank, cadets.find(c => c.id === 'cadet-1').company], ['CSM', 'No company']);
  const ravi = cadets.find(c => c.name === 'Ravi Kumar');
  assert.deepEqual([ravi.rank, ravi.company], ['CQMS', 'No company']);
  // Reloading keeps "No company" (not reset to a company)
  await refresh(a);
  assert.equal(await run(a, () => app.state.cadets.find(c => c.id === 'cadet-1').company), 'No company');

  // Public roster shows a No company section and can filter by it
  await run(a, () => { app.closeModal('rosterModal'); switchCadetFlowPage('directory'); });
  assert.match(await a.textContent('#dirResults'), /No company/);
  await run(a, () => { document.getElementById('dirCompany').value = 'No company'; renderRosterDirectory(); });
  const dir = await a.textContent('#dirResults');
  assert.match(dir, /Harsh Rajesh Koti/); assert.match(dir, /Ravi Kumar/); assert.ok(!dir.includes('Mani Karnica'));

  // Whole-battalion tasks include them; company tasks don't; the workspace has a No company filter
  const all = await createTask(a, 'Battalion task');
  await run(a, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, all);
  assert.equal(await run(a, id => app.eventCadets(app.findEvent(id)).length, all), 38);
  assert.match(await a.textContent('#coyBtn-No\\ company'), /No company \(2\)/);
  assert.equal(await a.isVisible('#coyBtn-No\\ company'), true);
  await run(a, () => app.setCompanyFilter('No company'));
  assert.equal(await a.locator('#cadetListContainer > div').count(), 2);
  assert.match(await a.textContent('#statTotalCount'), /38/, 'counted in the battalion total, not added to Jessami');
  assert.match(await a.textContent('#statJessamiTotal'), /10 done/);
  // Rank filter offers the new ranks
  const ranks = await a.locator('#rankFilterButtons button').allTextContents();
  assert.ok(ranks.some(r => r.startsWith('CSM')) && ranks.some(r => r.startsWith('CQMS')));
  noErrors(a);
}));

test('availability: editors edit timetables on the site; 3rd years are left out', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => { switchCadetFlowPage('availability'); document.getElementById('availabilityDay').value = 'TUE'; document.getElementById('availabilityHalf').value = '2'; renderAvailabilityResults(); });
  // Abhinav Pathak is free on Tuesday second half in the old list — until he is a 3rd year
  assert.match(await a.textContent('#availabilityResults'), /Abhinav Pathak/);
  await run(a, () => { app.updateCadetField('cadet-29', 'year', '3rd'); renderAvailabilityResults(); });
  assert.ok(!(await a.textContent('#availabilityResults')).includes('Abhinav Pathak'), '3rd years are hidden');
  assert.equal(await a.locator('#availabilityFilters [data-val="3rd"]').count(), 0, 'no 3rd year filter');
  assert.ok(!(await a.textContent('#availabilityUnassigned')).includes('Abhinav Pathak'));

  // Give Shaurya Pandey (no timetable) Tuesday second half, via the editor
  await run(a, () => openTimetableEditor('cadet-30'));
  assert.equal(await a.isVisible('#timetableModal'), true);
  assert.ok(!(await a.locator('#ttList button').allTextContents()).some(t => t.includes('Abhinav Pathak')), 'editor lists no 3rd years');
  // Search and filters narrow the list; Enter in the search picks the first match
  await a.fill('#ttSearch', 'karan');
  assert.deepEqual((await a.locator('#ttList button').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim().split(' Kohima')[0]), ['CDT Sri Karan M']);
  await a.press('#ttSearch', 'Enter');
  assert.equal(await a.textContent('#ttName'), 'CDT Sri Karan M');
  await a.fill('#ttSearch', '');
  await a.selectOption('#ttShow', 'missing');
  const missing = await a.locator('#ttList button').allTextContents();
  assert.ok(missing.length > 0 && missing.every(t => t.includes('Not set')), 'only cadets without a timetable');
  await a.selectOption('#ttCoy', 'Naushera');
  assert.ok((await a.locator('#ttList button').allTextContents()).every(t => t.includes('Naushera')));
  // Next/previous move within the filtered list
  await run(a, () => stepTimetable(1));
  assert.match(await a.textContent('#ttMeta'), /Naushera/);
  await run(a, () => openTimetableEditor('cadet-30')); // opening from a cadet clears the filters
  await a.click('#ttGrid button[onclick*="TUE2"]');
  await a.click('#ttGrid button[onclick*="SAT1"]');
  await flush(a);
  assert.deepEqual(db.row.state.cadets.find(c => c.id === 'cadet-30').free, ['TUE2', 'SAT1']);
  assert.match(await a.textContent('#availabilityResults'), /Shaurya Pandey/);
  // Editing someone from the old list starts from their existing timetable
  await run(a, () => { openTimetableEditor('cadet-3'); toggleTimetableSlot('SAT2'); });
  await flush(a);
  assert.deepEqual(db.row.state.cadets.find(c => c.id === 'cadet-3').free, ['WED1', 'THU2', 'FRI1']);
  // Next/previous moves through cadets; clear empties the timetable
  await run(a, () => { openTimetableEditor('cadet-30'); clearTimetable(); });
  await flush(a);
  assert.deepEqual(db.row.state.cadets.find(c => c.id === 'cadet-30').free, []);
  assert.match(await a.textContent('#availabilityUnassigned'), /Shaurya Pandey/);
  assert.ok(db.row.state.history.some(h => h.action === 'timetable-edited'));

  // Members without powers can't open the editor
  const v = await openAs(browser, db, 'user-v');
  await run(v, () => switchCadetFlowPage('availability'));
  assert.equal(await v.locator('button:has-text("Edit timetables")').isVisible(), false);
  await run(v, () => openTimetableEditor('cadet-30'));
  assert.equal(await v.isVisible('#timetableModal'), false);
  noErrors(a, v);
}));

test('powers come from rank: LCPL tasks, SGT requests, JUO/SUO parades, CQMS uniform; the administrator everything', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => { app.updateCadetField('cadet-3', 'rank', 'SGT'); app.updateCadetField('cadet-4', 'rank', 'JUO'); app.updateCadetField('cadet-5', 'rank', 'CQMS'); });
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-1' }).account('user-g', { cadetId: 'cadet-3' }).account('user-j', { cadetId: 'cadet-4' })
    .account('user-q', { cadetId: 'cadet-5' }).account('user-c', { cadetId: 'cadet-6' });
  const lcpl = await openAs(browser, db, 'user-l'), sgt = await openAs(browser, db, 'user-g'), juo = await openAs(browser, db, 'user-j');
  const cqms = await openAs(browser, db, 'user-q'), cdt = await openAs(browser, db, 'user-c');
  const powers = p => run(p, () => ['write', 'parade', 'requests', 'uniform'].filter(k => app.can(k)).concat(app.isAdmin() ? ['admin'] : []));
  assert.deepEqual(await powers(admin), ['write', 'parade', 'requests', 'uniform', 'admin']);
  assert.deepEqual(await powers(lcpl), ['write']);
  assert.deepEqual(await powers(sgt), ['write', 'requests']);
  assert.deepEqual(await powers(juo), ['write', 'parade', 'requests']);
  assert.deepEqual(await powers(cqms), ['write', 'requests', 'uniform']);
  assert.deepEqual(await powers(cdt), []);
  const classes = p => run(p, () => ['can-edit', 'can-parade', 'can-requests', 'can-uniform', 'is-admin', 'has-cadet'].filter(c => document.body.classList.contains(c)));
  assert.deepEqual(await classes(sgt), ['can-edit', 'can-requests', 'has-cadet']);
  assert.deepEqual(await classes(admin), ['can-edit', 'can-parade', 'can-requests', 'can-uniform', 'is-admin']);
  assert.match(await lcpl.textContent('#accountRole'), /LCPL · tasks, call-outs/);
  assert.match(await cdt.textContent('#accountRole'), /CDT · view and own requests/);
  assert.match(await admin.textContent('#accountRole'), /Administrator/);
  assert.match(await lcpl.textContent('#accountName'), /LCPL Harsh Rajesh Koti/);

  // LCPL: tasks and call-outs, but no parades, uniform orders, roster, timetables or deleting tasks
  const task = await createTask(lcpl, 'Senior task');
  await run(lcpl, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-2']); openParadeModal(); toggleUniformCadet('cadet-3', true); toggleUniformItem('belt'); createUniformRequests(); });
  assert.equal(await lcpl.isVisible('#paradeModal'), false);
  await flush(lcpl);
  assert.ok(db.row.state.events.some(e => e.id === task));
  assert.equal(db.row.state.duties.length, 1);
  assert.equal((db.row.state.uniform || []).length, 0, 'only the CQMS adds uniform requests for others');
  const before = JSON.stringify(db.row.state.cadets);
  await run(lcpl, id => {
    app.openRosterModal(); app.updateCadetField('cadet-1', 'name', 'Changed'); app.removeCadet('cadet-2');
    openTimetableEditor('cadet-3'); toggleTimetableSlot('MON1');
    app.handleDeleteCurrentEventDirectly(id);
  }, task);
  await flush(lcpl);
  assert.equal(JSON.stringify(db.row.state.cadets), before, 'roster unchanged');
  assert.ok(db.row.state.events.some(e => e.id === task), 'task not deleted');
  assert.equal(await lcpl.isVisible('#rosterModal'), false);
  await run(lcpl, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, task);
  assert.equal(await lcpl.locator('button[onclick*="handleDeleteCurrentEventDirectly"]').first().isVisible(), false);
  assert.equal(await lcpl.locator('button[onclick*="openEditCurrentEventModal"]').first().isVisible(), true);
  await run(lcpl, () => switchCadetFlowPage('availability'));
  assert.equal(await lcpl.locator('button:has-text("Edit timetables")').isVisible(), false);

  // JUO creates a parade; the SGT cannot, but marks attendance; the LCPL cannot mark
  const newParade = (p, title) => run(p, title => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('custom');
    const at = new Date(Date.now() + 5 * 3600000), pad = n => String(n).padStart(2, '0');
    document.getElementById('paradeTitle').value = title;
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
    return (app.state.parades || []).find(x => x.title === title)?.id || null;
  }, title);
  assert.equal(await newParade(sgt, 'SGT parade'), null);
  const pid = await newParade(juo, 'JUO parade');
  assert.ok(pid);
  await flush(juo);
  await refresh(sgt); await refresh(lcpl);
  await run(lcpl, id => setParadeMark(id, 'cadet-7', 'present'), pid);
  assert.equal(await run(lcpl, id => findParade(id).marks?.['cadet-7'] ?? null, pid), null, 'the LCPL cannot mark attendance');
  await run(sgt, id => setParadeMark(id, 'cadet-7', 'present'), pid);
  await flush(lcpl); await flush(sgt);
  assert.equal(db.row.state.parades.find(p => p.id === pid).marks['cadet-7'], 'present');
  // The server agrees: notifications only from JUO/SUO and the administrator
  await assert.rejects(db.api('user-g', 'notify', { paradeId: pid }), /JUOs, SUOs/);
  assert.ok(db.calls.some(c => c.action === 'notify' && c.userId === 'user-j' && c.status === 200), "the JUO's new parade was announced");

  // CQMS: uniform orders and payment details; nobody else
  await refresh(cqms);
  await run(cqms, () => { switchCadetFlowPage('uniform'); toggleUniformCadet('cadet-8', true); toggleUniformItem('socks'); createUniformRequests(); placeUniformOrder(); });
  await flush(cqms);
  assert.equal(db.row.state.uniform.find(r => r.cadetId === 'cadet-8').status, 'ordered');
  await assert.rejects(db.api('user-g', 'setPayInfo', { upi: 'x@y' }), /CQMS/);
  assert.deepEqual(await db.api('user-q', 'setPayInfo', { upi: 'unit@sbi', payee: 'NCC Unit' }), { ok: true });

  // A new rank takes effect straight away
  await run(admin, () => app.updateCadetField('cadet-1', 'rank', 'SGT'));
  await flush(admin);
  await refresh(lcpl);
  assert.deepEqual(await powers(lcpl), ['write', 'requests']);

  // Members below LCPL change nothing
  const writes = db.writes;
  await run(cdt, () => { window.prompt = () => 'x'; app.recordCallOut(['cadet-2']); app.openNewEventModal(); });
  await run(cdt, () => app.flushRemoteSave());
  assert.equal(db.writes, writes);
  noErrors(admin, lcpl, sgt, juo, cqms, cdt);
}));

test('parades: create, late/absence reports with cutoff, company-wise attendance', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => { app.updateCadetField('cadet-10', 'rank', 'SGT'); app.updateCadetField('cadet-20', 'rank', 'JUO'); });
  await flush(admin);
  db.account('user-s', { cadetId: 'cadet-20' }); // the JUO
  const senior = await openAs(browser, db, 'user-s');
  // The JUO creates a parade for the whole battalion, 2 hours from now
  const pid = await run(senior, () => {
    switchCadetFlowPage('parades');
    openParadeModal();
    const at = new Date(Date.now() + 2 * 3600000); const pad = n => String(n).padStart(2, '0');
    setParadeKind('custom');
    document.getElementById('paradeTitle').value = 'Saturday parade';
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    document.getElementById('paradeVenue').value = 'Main ground';
    document.getElementById('paradeAgenda').value = 'Drill\nUniform check';
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
    return app.state.parades[0].id;
  });
  await flush(senior);
  let pd = db.row.state.parades[0];
  assert.equal(pd.title, 'Saturday parade'); assert.equal(pd.venue, 'Main ground'); assert.equal(pd.scope, 'All');
  assert.match(await senior.textContent('#paradeDetailView'), /Main ground/);
  assert.match(await senior.textContent('#paradeDetailView'), /Uniform check/);

  // Informed-to list: SGT and above only
  await run(senior, id => openParadeReport(id), pid);
  const informers = await senior.locator('#prInformed option').allTextContents();
  assert.ok(informers.slice(1).every(t => /^(SGT|CQMS|CSM|JUO|SUO) /.test(t)) && informers.length === 3, informers.join(','));
  // Report: missing fields refused, then a late and a can't-come report
  await run(senior, () => saveParadeReport());
  assert.equal(await senior.isVisible('#paradeReportError'), true);
  await run(senior, () => { pickParadeReportCadet('cadet-1'); document.getElementById('prReason').value = 'Lab till 7'; document.getElementById('prInformed').value = 'cadet-10'; saveParadeReport(); });
  await run(senior, id => { openParadeReport(id); pickParadeReportCadet('cadet-14'); document.querySelector('input[name="prKind"][value="absent"]').checked = true; document.getElementById('prReason').value = 'Fever'; document.getElementById('prInformed').value = 'cadet-20'; saveParadeReport(); }, pid);
  await flush(senior);
  pd = db.row.state.parades[0];
  assert.deepEqual(pd.reports.map(r => [r.cadetId, r.kind, r.reason, r.informedTo, !!r.afterCutoff]), [['cadet-1', 'late', 'Lab till 7', 'cadet-10', false], ['cadet-14', 'absent', 'Fever', 'cadet-20', false]]);

  // After the cutoff: seniors can't add, administrators can (flagged)
  await run(senior, () => { const p = app.state.parades[0]; p.reportAt = Date.now() + 10 * 60000; app.saveStorage(); renderParadePage(); });
  await flush(senior);
  assert.equal(await senior.locator('#paradeDetailView button:has-text("Add report")').count(), 0);
  await run(senior, id => openParadeReport(id), pid);
  assert.equal(await senior.isVisible('#paradeReportModal'), false);
  await refresh(admin);
  await run(admin, id => { switchCadetFlowPage('parades'); openParadeDetail(id); openParadeReport(id); pickParadeReportCadet('cadet-2'); document.getElementById('prReason').value = 'Bus late'; document.getElementById('prInformed').value = 'cadet-10'; saveParadeReport(); }, pid);
  await flush(admin);
  assert.equal(db.row.state.parades[0].reports.find(r => r.cadetId === 'cadet-2').afterCutoff, true);

  // Attendance by company
  await refresh(senior);
  await run(senior, id => { openParadeDetail(id); PAR.coy = 'Jessami'; renderParadePage(); }, pid);
  const jessamiRows = await senior.locator('#paradeAttendanceList > li').count();
  assert.equal(jessamiRows, 11);
  await run(senior, id => { setParadeMark(id, 'cadet-1', 'late'); setParadeMark(id, 'cadet-3', 'absent'); window.confirm = () => true; paradeBulkMark(id, 'present'); }, pid);
  await flush(senior);
  pd = db.row.state.parades[0];
  assert.equal(pd.marks['cadet-1'], 'late'); assert.equal(pd.marks['cadet-3'], 'absent'); assert.equal(pd.marks['cadet-2'], 'present');
  assert.equal(Object.values(pd.marks).filter(v => v === 'present').length, 9, 'bulk only touched unmarked Jessami cadets');
  assert.equal(pd.marks['cadet-12'], undefined, 'other companies untouched');
  // Can't-come (Kohima cadet-14) is listed separately and not counted
  const counts = await run(senior, id => paradeCounts(findParade(id)), pid);
  assert.equal(counts.excused, 1); assert.equal(counts.present, 9); assert.equal(counts.late, 1); assert.equal(counts.absent, 1);
  // Tapping the same status clears it
  await run(senior, id => setParadeMark(id, 'cadet-3', 'absent'), pid);
  assert.equal(await run(senior, id => findParade(id).marks['cadet-3'], pid), undefined);
  const report = await run(senior, id => { let out; app.copyToClipboard = t => { out = t; }; copyParadeAttendance(id); return out; }, pid);
  assert.match(report, /Present 9 · Late 1 · Absent 0/); assert.match(report, /\*Late\* \(1\)\nJessami:\n1\. LCPL Harsh Rajesh Koti – Lab till 7/); assert.match(report, /Informed can't come/);
  const ann = await run(senior, id => { let out; app.copyToClipboard = t => { out = t; }; copyParadeAnnouncement(id); return out; }, pid);
  assert.match(ann, /Venue: Main ground/); assert.match(ann, /SGT and above/);

  // Seniors can't delete a parade; administrators can. Visitors only look.
  await run(senior, id => deleteParade(id), pid);
  assert.ok(await run(senior, id => !!findParade(id), pid));
  const v = await openAs(browser, db, 'user-v');
  await run(v, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.match(await v.textContent('#paradeDetailView'), /Saturday parade/);
  assert.equal(await v.locator('#paradeDetailView button:has-text("Present")').first().isVisible(), false);
  assert.equal(await v.locator('#paradeDetailView button:has-text("Edit")').isVisible(), false);
  await refresh(admin);
  await run(admin, id => deleteParade(id), pid);
  await flush(admin);
  assert.equal(db.row.state.parades.length, 0);
  noErrors(admin, senior, v);
}));

test('cadet profile: attendance %, calendar colours, call-outs', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  // Three past parades and one upcoming, all for the whole battalion
  await run(a, () => {
    app.updateCadetField('cadet-10', 'rank', 'SGT');
    const day = (y, m, d, h = 6) => new Date(y, m, d, h, 30).getTime();
    const mk = (id, ts) => ({ id, title: 'Parade ' + id, reportAt: ts, venue: 'Ground', agenda: '', scope: 'All', createdAt: 1, reports: [], marks: {} });
    const p1 = mk('p1', day(2026, 9, 3)), p2 = mk('p2', day(2026, 9, 10)), p3 = mk('p3', day(2026, 9, 17)), p4 = mk('p4', day(2026, 9, 24)), up = mk('up', Date.now() + 5 * 86400000);
    p1.marks['cadet-29'] = 'present';
    p2.marks['cadet-29'] = 'late';
    p3.marks['cadet-29'] = 'absent';                              // missed, no reason → red
    p4.reports.push({ id: 'r1', cadetId: 'cadet-29', kind: 'absent', reason: 'Exam', informedTo: 'cadet-10', at: 1, by: 'x' }); // yellow
    app.state.parades = normalizeParades([p1, p2, p3, p4, up]);
    app.state.duties = [{ id: 'd1', at: Date.now(), cadetIds: ['cadet-29', 'cadet-1'], work: 'Carry chairs', slot: 'MON1', by: 'senior' }];
    app.saveStorage();
  });
  await flush(a);
  // Open from the public roster page by clicking the name
  await run(a, () => { switchCadetFlowPage('directory'); });
  await a.click('#dirResults button[onclick*="cadet-29"]');
  assert.equal(await a.isVisible('#profileModal'), true);
  const body = await a.textContent('#profileBody');
  assert.match(body, /67%/, '2 attended (present + late) of 3 counted');
  assert.match(body, /2 of 3 attended/);
  assert.match(body, /With reason 1/);
  assert.match(body, /Called for work\s*1×/); assert.match(body, /Carry chairs/);
  // Calendar shows October 2026 with the colours
  const cls = await a.$$eval('#profileCalendar .cal-day.has', els => els.map(e => [e.textContent.trim(), e.className.match(/attended|missed|excused|unmarked|upcoming/)[0]]));
  assert.deepEqual(cls, [['3', 'attended'], ['10', 'attended'], ['17', 'missed'], ['24', 'excused']]);
  // Tap a date to see the parade
  await a.click('#profileCalendar button:has-text("24")');
  assert.match(await a.textContent('#profileBody'), /Missed with reason \(not counted\)/);
  assert.match(await a.textContent('#profileBody'), /Exam/);
  // Absent after saying they'd be late also counts as "with reason"
  await run(a, () => { const p = app.state.parades.find(x => x.id === 'p3'); p.reports.push({ id: 'r2', cadetId: 'cadet-29', kind: 'late', reason: 'Bus', informedTo: 'cadet-10', at: 1 }); renderCadetProfile(); });
  assert.match(await a.textContent('#profileBody'), /100%/);
  // Visitors can open profiles too
  const v = await openAs(browser, db, 'user-v');
  await run(v, () => openCadetProfile('cadet-29'));
  assert.equal(await v.isVisible('#profileModal'), true);
  noErrors(a, v);
}));

test('installable app: manifest, icons, service worker and the "Get the app" block', () => withBrowser(async browser => {
  const root = path.resolve(__dirname, '..');
  // Manifest is valid and every icon it names exists
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
  manifest.icons.forEach(i => assert.ok(fs.existsSync(path.join(root, i.src)), `${i.src} exists`));
  // Service worker parses, and precaches only files that exist
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  new Function(sw.replace(/self\.addEventListener/g, '(()=>{})'));
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  shell.filter(f => f !== './').forEach(f => assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`));
  // Push notifications are shown by the service worker
  assert.match(sw, /addEventListener\('push'/); assert.match(sw, /addEventListener\('notificationclick'/);

  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  assert.equal(await a.getAttribute('link[rel="manifest"]', 'href'), 'manifest.webmanifest');
  // In a normal browser the block explains how to install; no install button until the browser offers one
  assert.equal(await a.isVisible('#getApp'), true);
  assert.equal(await a.isVisible('#installAppBtn'), false);
  assert.match(await a.textContent('#getAppHint'), /Install app/);
  // When the browser offers installation, the button appears and triggers the prompt
  await run(a, () => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  assert.equal(await a.isVisible('#installAppBtn'), true);
  await a.click('#installAppBtn');
  assert.equal(await run(a, () => window.__prompted), true);
  assert.equal(await a.isVisible('#installAppBtn'), false);

  // Once installed (opened from the home screen) the block is hidden
  const p = await openAs(browser, db, 'user-v', { init: () => { Object.defineProperty(navigator, 'standalone', { value: true }); } });
  assert.equal(await p.isVisible('#getApp'), false);
  noErrors(a, p);
}));

test('uniform prices: edited on the page, bill per order, placed orders keep their prices', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => switchCadetFlowPage('uniform'));
  const setPrice = (page, key, value) => page.fill(`#uniPriceList input[data-key="${key}"]`, value);
  const save = page => page.click('#uniformPage button:has-text("Save prices")');

  // Prices are typed straight into the page and saved
  await setPrice(a, 'hackle', '40');
  await setPrice(a, 'beret', '₹250');
  assert.match(await a.textContent('#uniPriceHint'), /2 prices changed, not saved/);
  await save(a);
  await flush(a);
  assert.deepEqual(db.row.state.uniformPrices.map(p => [p.id, p.price]).sort(), [['beret', 250], ['hackle', 40]]);
  assert.ok(db.row.state.uniformPrices.every(p => p.updatedBy === 'user-a'));
  // A bad price is refused
  await setPrice(a, 'belt', 'abc'); await save(a);
  assert.equal(await run(a, () => uniformPriceOf('belt')), null);
  await setPrice(a, 'belt', ''); await save(a);

  // Requests: two hackles, a cadet who needs 2 berets, and an unpriced custom item
  await run(a, () => {
    const add = (ids, items, sizes, qty, custom) => { ids.forEach(i => toggleUniformCadet(i, true)); items.forEach(toggleUniformItem); Object.assign(UNI.sizes, sizes || {}); document.getElementById('uniQty').value = qty || 1; if (custom) document.getElementById('uniCustom').value = custom; createUniformRequests(); };
    add(['cadet-1', 'cadet-2'], ['hackle']);
    add(['cadet-3'], ['beret'], { 'cadet-3': '57' }, 2);
    add(['cadet-4'], ['custom'], {}, 1, 'Whistle cord');
  });
  let bill = await a.textContent('#uniBill');
  assert.match(bill, /Bill\s*₹580/, '2 × 40 + 2 × 250');
  assert.match(bill, /1 request has no price yet/);
  assert.match(await a.textContent('#uniOrderItems details[data-key="hackle"] summary'), /₹40 each · ₹80/);
  // The custom item shows up in the price list to be priced
  assert.equal(await a.isVisible('#uniPriceList input[data-key="custom:whistle cord"]'), true);
  await setPrice(a, 'custom:whistle cord', '30'); await save(a);
  assert.match(await a.textContent('#uniBill'), /Bill\s*₹610/);
  // Custom items can be added to the price list directly (a standard name maps to that item)
  await a.fill('#uniPriceNewName', 'Cap badge cover'); await a.fill('#uniPriceNewValue', '15');
  await a.click('#uniformPage button:has-text("Add item")');
  await a.fill('#uniPriceNewName', 'lanyard'); await a.fill('#uniPriceNewValue', '20');
  await a.click('#uniformPage button:has-text("Add item")');
  assert.equal(await run(a, () => uniformPriceOf('custom:cap badge cover')), 15);
  assert.equal(await run(a, () => uniformPriceOf('lanyard')), 20);
  // What each cadet pays
  await a.click('#uniBill summary');
  assert.match(await a.textContent('#uniBill details'), /Pradeep|cadet-3|₹500/);
  const copy = await run(a, () => { let out; app.copyToClipboard = t => { out = t; }; copyUniformBill(); return out; });
  assert.match(copy, /Beret: 2 × ₹250 = ₹500/); assert.match(copy, /\*Total: ₹610\*/);

  // Place the order: prices are copied onto it, so a later price change doesn't touch it
  await run(a, () => placeUniformOrder());
  await flush(a);
  assert.ok(db.row.state.uniform.find(r => r.item === 'beret').unitPrice === 250);
  await setPrice(a, 'beret', '300'); await save(a);
  assert.match(await a.textContent('#uniBill'), /Bill\s*₹610/, 'placed order keeps old prices');
  // ...unless CQMS chooses to use the current prices
  assert.equal(await a.isVisible('#uniOrderActions button:has-text("Use current prices")'), true);
  await run(a, () => applyUniformPricesToOrder());
  assert.match(await a.textContent('#uniBill'), /Bill\s*₹710/);
  // The next order uses the current prices
  await run(a, () => { selectUniformOrder('next'); toggleUniformCadet('cadet-5', true); toggleUniformItem('beret'); UNI.sizes['cadet-5'] = '56'; createUniformRequests(); });
  assert.match(await a.textContent('#uniBill'), /Bill\s*₹300/);
  await flush(a);

  // The CQMS and the administrator changing different prices at the same time keep both
  await run(a, () => app.updateCadetField('cadet-6', 'rank', 'CQMS'));
  await flush(a);
  db.account('user-s', { cadetId: 'cadet-6' });
  const b = await openAs(browser, db, 'user-s');
  db.autoNotify = false;
  await run(b, () => switchCadetFlowPage('uniform'));
  await setPrice(a, 'socks', '25'); await save(a);
  await setPrice(b, 'belt', '90'); await save(b);
  await flush(a); await flush(b);
  assert.equal(db.row.state.uniformPrices.find(p => p.id === 'socks').price, 25);
  assert.equal(db.row.state.uniformPrices.find(p => p.id === 'belt').price, 90);

  // Visitors see the prices and the bill but cannot change them
  const v = await openAs(browser, db, 'user-v');
  await run(v, () => switchCadetFlowPage('uniform'));
  assert.equal(await v.locator('#uniPriceList input').count(), 0);
  assert.match(await v.textContent('#uniPriceList'), /Beret\s*₹300/);
  assert.equal(await v.isVisible('#uniformPage button:has-text("Save prices")'), false);
  assert.equal(await v.isVisible('#uniBill'), true);
  noErrors(a, b, v);
}));

test('parade type: Shooting, Drill, Classroom or a custom name', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const create = (kind, name) => run(a, ({ kind, name }) => {
    switchCadetFlowPage('parades');
    openParadeModal();
    if (kind) setParadeKind(kind);
    if (name != null) document.getElementById('paradeTitle').value = name;
    document.getElementById('paradeDate').value = '2030-01-05';
    document.getElementById('paradeTime').value = '07:00';
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
    return { n: app.state.parades.length, err: document.getElementById('paradeModalError').textContent, nameShown: !document.getElementById('paradeTitleWrap').classList.contains('hidden') };
  }, { kind, name });
  // The type must be picked
  let r = await create(null);
  assert.equal(r.n, 0); assert.match(r.err, /Pick the type/);
  await run(a, () => app.closeModal('paradeModal'));
  // Preset types use their own name, the name box stays hidden
  r = await create('shooting');
  assert.equal(r.n, 1); assert.equal(r.nameShown, false);
  // Custom needs a name
  r = await create('custom', '');
  assert.equal(r.n, 1); assert.match(r.err, /Write a name/); assert.equal(r.nameShown, true);
  await run(a, () => app.closeModal('paradeModal'));
  r = await create('custom', 'Map reading');
  await flush(a);
  assert.deepEqual(db.row.state.parades.map(p => [p.kind, p.title]).sort(), [['custom', 'Map reading'], ['shooting', 'Shooting']]);
  // Editing shows the saved type; older parades without a type count as custom
  const shoot = db.row.state.parades.find(p => p.kind === 'shooting').id;
  await run(a, id => { openParadeModal(id); setParadeKind('drill'); if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade(); }, shoot);
  assert.equal(await run(a, id => findParade(id).title, shoot), 'Drill');
  await run(a, id => openParadeModal(id), shoot);
  assert.equal(await a.getAttribute('#paradeKinds [data-kind="drill"]', 'aria-pressed'), 'true');
  assert.equal(await run(a, () => normalizeParades([{ id: 'old', reportAt: 1, title: 'Old parade' }])[0].kind), 'custom');
  noErrors(a);
}));

test('after updating a cadet found by search, the search clears and the cursor goes back into it', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const name = await run(a, () => app.state.cadets.find(c => c.id === 'cadet-2').name);
  // Task Master: search, mark done
  await run(a, () => { switchCadetFlowPage('roster'); showTaskMasterSection('workspace'); });
  await a.fill('#searchInput', name);
  const shown = () => a.locator('#cadetListContainer button[onclick*="toggleCadetStatus"]').count();
  assert.equal(await shown(), 1);
  await a.click('#cadetListContainer button[onclick*="toggleCadetStatus(\'cadet-2\'"]');
  assert.equal(await a.inputValue('#searchInput'), '');
  assert.equal(await run(a, () => document.activeElement.id), 'searchInput');
  assert.ok(await shown() > 1, 'everyone is listed again');
  assert.equal(await run(a, id => app.peekRecord('cadet-2', app.findEvent(id)).done, await run(a, () => app.state.activeEventId)), true);
  // Typing goes straight into the box
  await a.keyboard.type('zz');
  assert.equal(await a.inputValue('#searchInput'), 'zz');
  // Giving a reason clears it too
  await setPrompt(a, 'Sick');
  await a.fill('#searchInput', name);
  await a.click('#cadetListContainer button[onclick*="promptReason(\'cadet-2\'"]');
  assert.equal(await a.inputValue('#searchInput'), '');
  // Without a search, nothing grabs the cursor
  await run(a, () => document.activeElement.blur());
  await a.click('#cadetListContainer button[onclick*="toggleCadetStatus(\'cadet-3\'"]');
  assert.notEqual(await run(a, () => document.activeElement.id), 'searchInput');

  // Parade attendance
  const pid = await run(a, () => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('drill');
    document.getElementById('paradeDate').value = '2020-01-05'; document.getElementById('paradeTime').value = '07:00';
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade(); return app.state.parades[0].id;
  });
  await run(a, id => openParadeDetail(id), pid);
  await a.fill('#paradeSearch', name);
  await a.click(`#paradeAttendanceList button[onclick*="'cadet-2', 'present'"]`);
  assert.equal(await run(a, id => findParade(id).marks['cadet-2'], pid), 'present');
  assert.equal(await a.inputValue('#paradeSearch'), '');
  assert.equal(await run(a, () => document.activeElement.id), 'paradeSearch');

  // Pickers: new task and uniform
  await run(a, () => { switchCadetFlowPage('roster'); app.openNewEventModal(); app.setTaskWho('new', 'pick'); });
  await a.fill('#newPickSearch', name);
  await a.check('#newPickList input[value="cadet-2"]');
  assert.equal(await a.inputValue('#newPickSearch'), '');
  assert.equal(await run(a, () => document.activeElement.id), 'newPickSearch');
  assert.equal(await run(a, () => app.taskPick.new.ids.has('cadet-2')), true);
  await run(a, () => { app.closeModal('newEventModal'); switchCadetFlowPage('uniform'); });
  await a.fill('#uniPickSearch', name);
  await a.check('#uniPickList input[value="cadet-2"]');
  assert.equal(await a.inputValue('#uniPickSearch'), '');
  assert.equal(await run(a, () => document.activeElement.id), 'uniPickSearch');
  noErrors(a);
}));

test('app shows "new version ready" when the site changed while it was in the background', () => withBrowser(async browser => {
  const root = path.resolve(__dirname, '..');
  // The service worker asks GitHub for a fresh page instead of trusting its 10-minute cache
  assert.match(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), /cache: 'no-cache'/);
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  assert.equal(await a.isVisible('#updateBanner'), false);
  await run(a, async () => {
    let v = 'etag-1'; window.siteVersion = async () => v;
    siteCheck.lastAt = 0; await checkForNewVersion();           // remembers the version it started with
    siteCheck.lastAt = 0; await checkForNewVersion();           // same version: nothing
    window.__same = !document.getElementById('updateBanner').classList.contains('hidden');
    v = 'etag-2'; siteCheck.lastAt = 0;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));     // app comes back to the screen
    await new Promise(r => setTimeout(r, 50));
  });
  assert.equal(await run(a, () => window.__same), false);
  assert.equal(await a.isVisible('#updateBanner'), true);
  assert.match(await a.textContent('#updateBanner'), /new version/);
  noErrors(a);
}));

/** Fake browser push support (the real thing needs https and a phone's push service). */
const FAKE_PUSH = () => {
  window.__sub = null; window.__perm = 'default'; window.__permAnswer = 'granted';
  // One device per test person: https://push.example/<user id>
  const sub = { get endpoint() { return 'https://push.example/' + (window.__testUser ? window.__testUser.id : 'visitor'); },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, async unsubscribe() { window.__sub = null; return true; } };
  const pushManager = { async getSubscription() { return window.__sub; }, async subscribe(o) { window.__subOpts = o; window.__sub = sub; return sub; } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager }), addEventListener() {}, getRegistration: async () => null } });
  window.PushManager = function () {};
  window.Notification = { get permission() { return window.__perm; }, async requestPermission() { window.__perm = window.__permAnswer; return window.__perm; } };
};
const toast = page => page.evaluate(() => document.getElementById('toastText').textContent);
const waitToast = (page, text) => page.waitForFunction(t => document.getElementById('toastText').textContent.includes(t), text);

test('notifications: when the browser refuses (Brave with Google push messaging off), the box says how to fix it', () => withBrowser(async browser => {
  const db = makeDb();
  const box = '#homePage [data-notify]';
  // Like FAKE_PUSH, but the browser's push service refuses, as Brave does by default.
  const refusing = brave => `(${FAKE_PUSH})();
    navigator.serviceWorker.ready.then(reg => { reg.pushManager.subscribe = async () => { throw new DOMException('Registration failed - push service error', 'AbortError'); }; });
    ${brave ? "Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: async () => true } });" : ''}`;
  const tryOn = async page => {
    await run(page, async () => { window.pushSupported = () => true; await renderNotifyBoxes(); });
    await page.click(`${box} button:has-text("Turn on notifications")`);
    await page.waitForFunction(() => !PUSH.busy && !!PUSH.problem);
    return page.textContent(`${box} [data-notify-text]`);
  };

  const brave = await openAs(browser, db, 'user-a', { init: refusing(true) });
  assert.match(await tryOn(brave), /brave:\/\/settings\/privacy[\s\S]*Use Google services for push messaging[\s\S]*restart Brave/);
  assert.match(await brave.textContent(box), /Turn on notifications/, 'the button stays to try again');

  const other = await openAs(browser, db, 'user-b', { init: refusing(false) });
  assert.match(await tryOn(other), /could not reach its notification service[\s\S]*Chrome, Edge or Firefox/);
  assert.equal(db.tables.cadetflow_push_subscriptions.length, 0, 'no device saved');
  noErrors(brave, other);
}));

test('parade notifications: per person and device, only the cadets a parade is for, tapping opens it', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => {
    app.updateCadetField('cadet-20', 'rank', 'JUO'); app.updateCadetField('cadet-20', 'year', '3rd');
    app.updateCadetField('cadet-1', 'year', '2nd'); app.updateCadetField('cadet-3', 'year', '1st');
  });
  await flush(admin);
  db.account('user-j', { cadetId: 'cadet-20' }).account('user-2', { cadetId: 'cadet-1' }).account('user-1', { cadetId: 'cadet-3' });
  const open = async (user, opts) => {
    const page = await openAs(browser, db, user, { init: FAKE_PUSH, ...opts });
    await run(page, async () => { window.pushSupported = () => true; await renderNotifyBoxes(); });
    return page;
  };
  const box = '#homePage [data-notify]';
  const turnOn = async page => {
    await page.click(`${box} button:has-text("Turn on notifications")`);
    await page.waitForFunction(() => document.querySelector('#homePage [data-notify]').dataset.state === 'on');
  };
  const devices = () => db.tables.cadetflow_push_subscriptions.map(s => [s.endpoint.replace('https://push.example/', ''), s.user_id]).sort();

  // Each person turns notifications on for their own device; the device is saved for them
  const two = await open('user-2');
  assert.match(await two.textContent(box), /when a parade for you is posted/);
  await turnOn(two);
  assert.equal(await run(two, () => window.__subOpts.userVisibleOnly), true);
  assert.match(await two.textContent('#paradePage [data-notify]'), /On for this device/, 'the Parades page shows it too');
  const one = await open('user-1'); await turnOn(one);
  const juo = await open('user-j'); await turnOn(juo);
  assert.deepEqual(devices(), [['user-1', 'user-1'], ['user-2', 'user-2'], ['user-j', 'user-j']]);
  // Test, then turn off
  await two.click(`${box} button:has-text("Send a test")`);
  await waitToast(two, 'Test sent');
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-2', 'CadetFlow']]);
  await one.click(`${box} button:has-text("Turn off")`);
  await one.waitForFunction(() => document.querySelector('#homePage [data-notify]').dataset.state === 'off');
  assert.deepEqual(devices().map(d => d[0]), ['user-2', 'user-j']);
  await turnOn(one);
  // Saying no to the permission request; iPhone in Safari is told to add CadetFlow to the Home Screen first
  const no = await open('user-v');
  await run(no, () => { window.__permAnswer = 'denied'; });
  await no.click(`${box} button:has-text("Turn on notifications")`);
  await no.waitForFunction(() => document.querySelector('#homePage [data-notify]').dataset.state === 'blocked');
  assert.match(await no.textContent(box), /blocked/);
  assert.equal(await run(no, () => { window.pushSupported = () => false; window.isIOS = () => true; return pushState(); }), 'ios-install');

  // The JUO posts a 2nd-year drill parade: saved first, then announced to 2nd years only
  db.pushes.length = 0;
  const make = (page, days, years) => run(page, ({ days, years }) => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('drill');
    const at = new Date(Date.now() + days * 86400000); const pad = n => String(n).padStart(2, '0');
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeTime').value = '07:00';
    if (years) document.querySelectorAll('#paradeEventYears input').forEach(i => { i.checked = years.includes(i.value); });
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade(); return PAR.openId;
  }, { days, years });
  const pid = await make(juo, 2, ['2nd']);
  await waitToast(juo, 'Notification sent to 1 device');
  assert.deepEqual(db.row.state.parades.find(p => p.id === pid).years, ['2nd']);
  assert.deepEqual(db.pushes.map(p => p.userId), ['user-2'], 'only the 2nd year');
  assert.equal(db.pushes[0].payload.title, 'New parade: Drill');
  assert.match(db.pushes[0].payload.body, /For: All companies \(2nd year\)/);
  assert.equal(db.pushes[0].payload.url, './?parade=' + encodeURIComponent(pid));
  // Past parades (entered for the record) and edits are not announced
  await make(juo, -3);
  await run(juo, id => { openParadeModal(id); if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade(); }, pid);
  await flush(juo);
  assert.equal(db.calls.filter(c => c.action === 'notify').length, 1);
  assert.equal(db.pushes.length, 1);

  // "Send notification": the JUO can't send it twice; the administrator can
  await run(juo, id => openParadeDetail(id), pid);
  await juo.click('#paradeDetailView button:has-text("More")');
  await juo.click('#paradeDetailView button:has-text("Send notification")');
  await waitToast(juo, 'Only an administrator can send it again');
  await refresh(admin);
  await run(admin, id => { switchCadetFlowPage('parades'); openParadeDetail(id); PAR.more = true; renderParadePage(); }, pid);
  await admin.click('#paradeDetailView button:has-text("Send notification")');
  await waitToast(admin, 'Notification sent to 1 device');
  assert.deepEqual(db.pushes.map(p => p.userId), ['user-2', 'user-2']);
  // A cadet without the power doesn't get the button; nobody is told "sent" when no device is on
  await refresh(two);
  await run(two, id => { switchCadetFlowPage('parades'); openParadeDetail(id); PAR.more = true; renderParadePage(); }, pid);
  assert.equal(await two.isVisible('#paradeDetailView button:has-text("Send notification")'), false);
  assert.match(await run(two, () => paradeNotifyResult({ sent: 0, failed: 0, devices: 0, people: 3 })), /Nobody this parade is for has notifications turned on/);
  // A phone that stopped accepting notifications is forgotten
  db.goneEndpoints.add('https://push.example/user-2');
  assert.deepEqual(await db.api('user-a', 'notify', { paradeId: pid, again: true }).then(r => [r.sent, r.removed]), [0, 1]);
  assert.ok(!devices().some(d => d[0] === 'user-2'));

  // Signing out takes the device away from that person
  await run(one, () => app.signOut());
  await one.waitForFunction(() => document.body.classList.contains('locked'));
  assert.ok(!devices().some(d => d[0] === 'user-1'));

  // Tapping the notification opens CadetFlow on that parade (after signing in if needed)
  const t = await openAs(browser, db, null, { url: PAGE_URL + '?parade=' + encodeURIComponent(pid) });
  assert.equal(await gateView(t), 'signin');
  await t.fill('#signinEmail', 'user-2@example.com'); await t.fill('#signinPassword', 'pass-user-2');
  await t.click('#gateSubmit');
  await t.waitForFunction(() => !document.getElementById('paradePage').classList.contains('hidden') && PAR.openId);
  assert.equal(await run(t, () => PAR.openId), pid);
  assert.equal(await run(t, () => location.search), '', 'the link is tidied up');
  noErrors(admin, two, one, juo, no, t);
}));

// ---- Accounts and sign-in ----------------------------------------------------------------------

test('sign-in: signed-out visitors see nothing; cadets register, wait for approval and get in', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-9' }); // already has an account

  // Signed out: only the sign-in screen, and the database gives nothing away
  const v = await openAs(browser, db, null);
  assert.equal(await gateView(v), 'signin');
  assert.equal(await v.isVisible('#gate'), true);
  assert.equal(await v.isVisible('#homePage'), false);
  assert.equal(await run(v, () => app.state.cadets.length), 0);
  assert.equal((await run(v, () => app.supabase.from('cadetflow_state').select('state').eq('id', 1).maybeSingle())).data, null);
  await v.fill('#signinEmail', 'user-c@example.com'); await v.fill('#signinPassword', 'wrong-one');
  await v.click('#gateSubmit');
  await v.waitForFunction(() => /Wrong email or password/.test(document.getElementById('gateMsg').textContent));

  // Register: pick your name, regimental number, email, password
  await v.click('#gate button[role="tab"]:has-text("Register")');
  await v.waitForSelector('#regList .pick-row');
  assert.equal(await v.locator('#regList .pick-row:has-text("Amber Singhai")').isDisabled(), true, 'a cadet with an account cannot be picked');
  await v.fill('#regSearch', 'abhinav');
  assert.equal(await v.locator('#regList .pick-row').count(), 1);
  await v.click('#regList .pick-row');
  assert.match(await v.textContent('#regPicked'), /CDT Abhinav Pathak/);
  await v.fill('#regNo', 'ka 21 sd 123'); await v.fill('#regEmail', 'Abhinav@Example.com');
  await v.fill('#regPassword', 'secret-123'); await v.fill('#regPassword2', 'secret-124');
  await v.click('#gateSubmit');
  assert.match(await v.textContent('#gateMsg'), /not the same/);
  await v.fill('#regPassword2', 'secret-123');
  await v.click('#gateSubmit');
  await v.waitForFunction(() => GATE.view === 'pending');
  assert.match(await v.textContent('#gateBody'), /Waiting for approval[\s\S]*Abhinav Pathak[\s\S]*KA21SD123/);
  const id = db.userByEmail('abhinav@example.com').id;
  const p = db.profile(id);
  assert.deepEqual([p.status, p.role, p.cadet_id, p.regimental_no], ['pending', 'viewer', 'cadet-29', 'KA21SD123']);
  assert.equal(await run(v, () => app.state.cadets.length), 0, 'still nothing to see');
  await assert.rejects(db.api(null, 'register', { cadetId: 'cadet-29', email: 'other@example.com', regNo: 'KA21SD777', password: 'secret-123' }), /already has an account/);

  // The administrator approves it on the Accounts page
  await run(admin, () => switchCadetFlowPage('accounts'));
  await admin.waitForSelector('#accountsBody button:has-text("Approve")');
  assert.match(await admin.textContent('#accountsBody'), /Waiting for approval \(1\)[\s\S]*Abhinav Pathak[\s\S]*KA21SD123[\s\S]*roster has none yet/);
  await admin.click('#accountsBody button:has-text("Approve")');
  await admin.waitForFunction(() => /Waiting for approval \(0\)/.test(document.getElementById('accountsBody').textContent));
  assert.equal(db.profile(id).status, 'approved');
  assert.equal(db.cadet('cadet-29').regNo, 'KA21SD123', 'their regimental number goes onto the roster');

  // They get in (the waiting screen also checks by itself)
  await v.click('#gateBody button:has-text("Check again")');
  await v.waitForFunction(() => !document.body.classList.contains('locked') && app.remoteReady);
  assert.match(await v.textContent('#accountName'), /CDT Abhinav Pathak/);
  assert.deepEqual(await run(v, () => [app.can('write'), app.isAdmin()]), [false, false]);
  await run(v, () => openMyProfile());
  assert.match(await v.textContent('#profileHead'), /CDT Abhinav Pathak[\s\S]*Cadet · Regimental no\. KA21SD123/);

  // A rejected registration stays out
  await db.api(null, 'register', { cadetId: 'cadet-30', email: 'shaurya@example.com', regNo: 'KA21SD999', password: 'secret-123' });
  await run(admin, () => loadAccounts(true));
  await admin.waitForSelector('#accountsBody button:has-text("Reject")');
  await admin.click('#accountsBody button:has-text("Reject")');
  await admin.waitForFunction(() => /Not approved \(1\)/.test(document.getElementById('accountsBody').textContent));
  const r = await openAs(browser, db, null);
  await r.fill('#signinEmail', 'shaurya@example.com'); await r.fill('#signinPassword', 'secret-123');
  await r.click('#gateSubmit');
  await r.waitForFunction(() => GATE.view === 'rejected');
  assert.equal(await run(r, () => app.state.cadets.length), 0);

  // Signing out wipes CadetFlow from the device
  await run(v, () => app.signOut());
  await v.waitForFunction(() => GATE.view === 'signin');
  assert.equal(await run(v, () => app.state.cadets.length), 0);
  assert.equal(await run(v, () => localStorage.getItem(app.storageKey)), null);
  noErrors(admin, v, r);
}));

test('passwords: forgotten ones are reset by the administrator with an emailed or shared link', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' });

  // The cadet asks from the sign-in screen; unknown emails get the same answer
  const c = await openAs(browser, db, null);
  await c.click('#gateBody button:has-text("Forgot your password?")');
  await c.fill('#forgotEmail', 'user-c@example.com');
  await c.click('#gateSubmit');
  await c.waitForFunction(() => /administrator will send you a link/.test(document.getElementById('gateMsg').textContent));
  assert.ok(db.profile('user-c').reset_requested_at);
  assert.deepEqual(await db.api(null, 'forgot', { email: 'nobody@example.com' }), { ok: true });

  // The administrator emails a reset link
  await run(admin, () => switchCadetFlowPage('accounts'));
  await admin.waitForSelector('#accountsBody button:has-text("Email reset link")');
  assert.match(await admin.textContent('#accountsBody'), /Asked for a new password \(1\)[\s\S]*CDT Samahith M Rao/);
  await admin.click('#accountsBody button:has-text("Email reset link")');
  await waitToast(admin, 'Reset link emailed to user-c@example.com');
  assert.deepEqual(db.mails.map(m => [m.type, m.email]), [['recovery', 'user-c@example.com']]);
  assert.equal(db.profile('user-c').reset_requested_at, null);
  // Without email set up, the link is shown to copy or share on WhatsApp
  db.mailWorks = false;
  await run(admin, () => sendResetLink('user-c', true));
  await admin.waitForSelector('#accountsBody a:has-text("Share on WhatsApp")');
  assert.match(await run(admin, () => ACC.links['user-c']), /#access_token=tok-user-c&type=recovery/);
  assert.equal(db.mails.length, 1);

  // The cadet opens the link, sets a new password and is in
  const l = await openAs(browser, db, null, { url: PAGE_URL + new URL(db.mails[0].link).hash });
  assert.equal(await gateView(l), 'password');
  await l.fill('#newPassword', 'brand-new-1'); await l.fill('#newPassword2', 'brand-new-1');
  await l.click('#gateSubmit');
  await l.waitForFunction(() => !document.body.classList.contains('locked') && app.remoteReady);
  assert.equal(db.users.get('user-c').password, 'brand-new-1');
  assert.equal(await run(l, () => location.hash), '', 'the token is taken out of the address');
  // The administrator can also set one; members change their own from the account menu
  await run(admin, () => { openPasswordModal('user-c'); document.getElementById('pwNew').value = 'set-by-admin'; });
  await admin.click('#pwSubmit');
  await waitToast(admin, 'Password set');
  assert.equal(db.users.get('user-c').password, 'set-by-admin');
  await run(l, () => { openPasswordModal(); document.getElementById('pwNew').value = 'mine-12345'; document.getElementById('pwConfirm').value = 'mine-12345'; });
  await l.click('#pwSubmit');
  await waitToast(l, 'Password changed');
  assert.equal(db.users.get('user-c').password, 'mine-12345');
  await assert.rejects(db.api('user-c', 'resetLink', { userId: 'user-v' }), /Only the administrator/);
  noErrors(admin, c, l);
}));

test('accounts: import a list to invite cadets, links when email is not set up, roles, linking and removing', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-old', { email: 'old@example.com' }); // has an account already, not linked
  await run(admin, () => switchCadetFlowPage('accounts'));
  await admin.waitForSelector('#accountsBody h3:has-text("Members")');
  const csv = 'Name,Email,Regimental No\nHarsh Rajesh Koti,harsh@example.com,KA21SD001\n"Mani Karnica",Mani@Example.com,ka21 sw002\nSomeone Else,else@example.com,\nSamahith M Rao,old@example.com,KA21SD003\n';
  await admin.setInputFiles('#accountsBody input[type=file]', { name: 'cadets.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await admin.waitForFunction(() => ACC.import && ACC.import.length === 4);
  assert.deepEqual(await run(admin, () => ACC.import.map(r => [r.email, r.regNo, r.cadetId])),
    [['harsh@example.com', 'KA21SD001', 'cadet-1'], ['mani@example.com', 'KA21SW002', 'cadet-2'], ['else@example.com', '', ''], ['old@example.com', 'KA21SD003', 'cadet-3']]);
  const preview = await admin.textContent('#accountsBody');
  assert.match(preview, /Pick who this is on the roster/);
  assert.match(preview, /Has an account: it will be linked/);
  assert.match(preview, /Send invites \(3\)/);
  await admin.click('#accountsBody button:has-text("Send invites")');
  await admin.waitForFunction(() => ACC.results && ACC.results.length === 3 && !ACC.busy);
  assert.deepEqual(await run(admin, () => ACC.results.map(r => r.result)), ['sent', 'sent', 'linked']);
  assert.deepEqual(db.mails.map(m => [m.type, m.email]), [['invite', 'harsh@example.com'], ['invite', 'mani@example.com']]);
  const harsh = db.userByEmail('harsh@example.com').id;
  assert.deepEqual([db.profile(harsh).status, db.profile(harsh).cadet_id], ['approved', 'cadet-1']);
  assert.deepEqual([db.profile('user-old').status, db.profile('user-old').cadet_id], ['approved', 'cadet-3']);
  assert.equal(db.cadet('cadet-2').regNo, 'KA21SW002', 'regimental numbers go onto the roster');

  // Without email set up: a link to copy or share instead
  db.mailWorks = false;
  await run(admin, () => { ACC.one = { cadetId: 'cadet-12', email: 'prahast@example.com', regNo: '' }; renderAccountsPage(); });
  await admin.click('#accountsBody button:text-is("Send invite")');
  await admin.waitForFunction(() => ACC.results?.[0]?.result === 'link' && !ACC.busy);
  const link = await run(admin, () => ACC.results[0].link);
  assert.match(link, /type=invite/);
  assert.equal(db.mails.length, 2, 'no email went out');

  // The invited cadet opens the link, sets a password and is in, linked to their name
  const p = await openAs(browser, db, null, { url: PAGE_URL + new URL(link).hash });
  assert.equal(await gateView(p), 'password');
  await p.fill('#newPassword', 'prahast-pw1'); await p.fill('#newPassword2', 'prahast-pw1');
  await p.click('#gateSubmit');
  await p.waitForFunction(() => !document.body.classList.contains('locked') && app.remoteReady);
  assert.match(await p.textContent('#accountName'), /LCPL Prahast Mohanty/);
  assert.deepEqual(await run(p, () => [app.can('write'), app.can('requests')]), [true, false]);

  // Roles, linking and removing
  const prahast = db.userByEmail('prahast@example.com').id;
  await run(admin, () => loadAccounts(true));
  await run(admin, id => setAccountRole(id, 'admin'), prahast);
  await admin.waitForFunction(() => !ACC.busy);
  assert.equal(db.profile(prahast).role, 'admin');
  await run(admin, id => linkAccount(id, 'cadet-13'), harsh);
  await admin.waitForFunction(() => !ACC.busy);
  assert.equal(db.profile(harsh).cadet_id, 'cadet-13');
  await assert.rejects(db.api('user-a', 'link', { userId: harsh, cadetId: 'cadet-3' }), /already linked/);
  await db.api('user-a', 'setRole', { userId: 'user-b', role: 'viewer' });
  await db.api('user-a', 'setRole', { userId: prahast, role: 'viewer' });
  await assert.rejects(db.api('user-a', 'setRole', { userId: 'user-a', role: 'viewer' }), /only administrator/);
  await run(admin, id => removeAccount(id), harsh);
  await admin.waitForFunction(() => !ACC.busy);
  assert.equal(db.users.has(harsh), false);
  assert.equal(db.profile(harsh), null);
  assert.equal(await admin.locator('#accountsBody li:has-text("harsh@example.com")').count(), 0);
  noErrors(admin, p);
}));

// ---- Requests from cadets, uniform payments, server rules ---------------------------------------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** Create a custom parade `hours` from now through the dialog; returns its id. */
const makeParade = (page, hours, title) => run(page, ({ hours, title }) => {
  switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('custom');
  const at = new Date(Date.now() + hours * 3600000), pad = n => String(n).padStart(2, '0');
  document.getElementById('paradeTitle').value = title;
  document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
  return PAR.openId;
}, { hours, title });

test('cadets send late/absence requests with a screenshot; sergeants and above approve; the screenshot goes after the parade', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  const pid = await makeParade(admin, 3, 'Sunday parade');
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' }).account('user-l', { cadetId: 'cadet-1' });
  db.tables.cadetflow_push_subscriptions.push({ endpoint: 'https://push.example/c', p256dh: 'p', auth: 'a', user_id: 'user-c' });

  // The cadet will be late and attaches a screenshot of the bus ticket
  const c = await openAs(browser, db, 'user-c');
  await run(c, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  await c.click(`#paradeDetailView button:has-text("I'll be late")`);
  assert.equal(await c.isVisible('#selfReportModal'), true);
  await c.fill('#srReason', 'Bus from the hostel is late');
  await c.setInputFiles('#srImage', { name: 'ticket.png', mimeType: 'image/png', buffer: PNG });
  await c.waitForFunction(() => !!SR.image);
  await c.click('#srSubmit');
  await c.waitForFunction(() => document.getElementById('selfReportModal').classList.contains('hidden'));
  const first = db.tables.cadetflow_requests[0];
  assert.deepEqual([first.cadet_id, first.kind, first.status, first.user_id], ['cadet-3', 'late', 'pending', 'user-c']);
  assert.ok(first.image_path && db.files.has(first.image_path), 'the screenshot is stored privately');
  assert.match(await c.textContent('#paradeDetailView'), /Coming late[\s\S]*Waiting for a sergeant or above[\s\S]*screenshot attached/);

  // Below sergeant nobody sees it; the cadet sees only their own
  const l = await openAs(browser, db, 'user-l');
  await run(l, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.doesNotMatch(await l.textContent('#paradeDetailView'), /Requests from cadets|Bus from the hostel/);
  assert.equal((await db.api('user-l', 'requests')).requests.length, 0);
  await assert.rejects(db.api('user-l', 'reportImage', { id: first.id }), /sergeants and above/);
  assert.equal((await db.api('user-c', 'requests')).requests.length, 1);

  // The sergeant sees it waiting, looks at the screenshot and approves it; the cadet is told
  const g = await openAs(browser, db, 'user-g');
  await run(g, () => switchCadetFlowPage('parades'));
  await g.waitForFunction(() => /1 waiting/.test(document.getElementById('paradeTiles').textContent));
  await run(g, id => openParadeDetail(id), pid);
  await g.click('#paradeRequestsBox');
  await g.click('#requestsBody button:has-text("View screenshot")');
  await g.waitForFunction(() => !document.getElementById('imageModal').classList.contains('hidden') && document.getElementById('imageView').src.startsWith('data:image/'));
  await run(g, () => app.closeModal('imageModal'));
  await g.click('#paradeRequests .rq-row button:has-text("Approve")');
  await waitToast(g, 'Approved');
  const rep = db.row.state.parades.find(p => p.id === pid).reports.find(r => r.cadetId === 'cadet-3');
  assert.deepEqual([rep.kind, rep.reason, rep.fromCadet, rep.informedTo, rep.by], ['late', 'Bus from the hostel is late', true, 'cadet-10', 'SGT Manusree T']);
  assert.equal(db.tables.cadetflow_requests[0].status, 'approved');
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-c', 'Request approved']]);
  await refresh(c);
  await run(c, id => openParadeDetail(id), pid);
  assert.match(await c.textContent('#paradeDetailView'), /Coming late[\s\S]*Approved by SGT Manusree T/);

  // A sergeant's own request is decided by someone else; a refusal carries a note
  await db.api('user-g', 'report', { paradeId: pid, kind: 'absent', reason: 'Exam that day' });
  const own = db.tables.cadetflow_requests.find(r => r.cadet_id === 'cadet-10');
  await assert.rejects(db.api('user-g', 'decide', { id: own.id, approve: true }), /Another senior/);
  await db.api('user-a', 'decide', { id: own.id, approve: false, note: 'Come after the exam' });
  assert.deepEqual([own.status, own.note], ['rejected', 'Come after the exam']);

  // Requests close 30 minutes before reporting time
  const soon = await makeParade(admin, 0.4, 'Soon parade');
  await flush(admin);
  await assert.rejects(db.api('user-c', 'report', { paradeId: soon, kind: 'late', reason: 'Traffic jam' }), /closed 30 minutes before/);
  await refresh(c);
  await run(c, id => openParadeDetail(id), soon);
  assert.match(await c.textContent('#paradeDetailView'), /Requests closed at/);

  // Once the parade is over, the screenshot is deleted; the request stays
  await run(admin, id => { findParade(id).reportAt = Date.now() - 4 * 3600000; app.saveStorage(); }, pid);
  const later = await makeParade(admin, 5, 'Later parade');
  await flush(admin);
  await db.api('user-l', 'report', { paradeId: later, kind: 'absent', reason: 'Fever since morning' });
  await db.api('user-a', 'decide', { id: db.tables.cadetflow_requests.find(r => r.cadet_id === 'cadet-1').id, approve: true });
  assert.equal(db.files.has(first.image_path || 'gone'), false);
  const after = db.tables.cadetflow_requests.find(r => r.id === first.id);
  assert.deepEqual([after.image_path, after.had_image, after.status], [null, true, 'approved']);
  noErrors(admin, c, l, g);
}));

test('uniform: cadets ask for their own items and pay with the QR and a screenshot; CQMS approves before they can mark it received', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.updateCadetField('cadet-5', 'rank', 'CQMS'));
  await flush(admin);
  db.account('user-q', { cadetId: 'cadet-5' }).account('user-c', { cadetId: 'cadet-3' });
  db.tables.cadetflow_push_subscriptions.push({ endpoint: 'https://push.example/q', p256dh: 'p', auth: 'a', user_id: 'user-q' },
    { endpoint: 'https://push.example/c', p256dh: 'p', auth: 'a', user_id: 'user-c' });

  // CQMS sets prices and where to pay: a QR code that stays until it is changed
  const q = await openAs(browser, db, 'user-q');
  await run(q, () => switchCadetFlowPage('uniform'));
  await q.fill('#uniPriceList input[data-key="beret"]', '300');
  await q.fill('#uniPriceList input[data-key="hackle"]', '40');
  await run(q, () => saveUniformPrices());
  await q.waitForSelector('#uniPaySettings input[placeholder="e.g. name@okaxis"]');
  await q.fill('#uniPaySettings input[placeholder="Name on the account"]', 'NCC Unit Fund');
  await q.fill('#uniPaySettings input[placeholder="e.g. name@okaxis"]', 'nccunit@sbi');
  await q.setInputFiles('#uniPaySettings input[type=file]', { name: 'qr.png', mimeType: 'image/png', buffer: PNG });
  await q.waitForFunction(() => !!UPAY.draft?.image);
  await q.click('#uniPaySettings button:has-text("Save")');
  await waitToast(q, 'Cadets now see these details');
  const where = db.tables.cadetflow_settings.find(s => s.key === 'payment').value;
  assert.deepEqual([where.upi, where.payee], ['nccunit@sbi', 'NCC Unit Fund']);
  assert.ok(db.files.has(where.qr), 'the QR code is stored');
  await flush(q);

  // The cadet asks for a beret and a hackle; CQMS is told
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => switchCadetFlowPage('uniform'));
  assert.match(await c.textContent('#uniMine'), /My uniform[\s\S]*You have not asked for anything yet/);
  await run(c, () => { toggleAskItem('beret'); toggleAskItem('hackle'); });
  await c.fill('#uniAskSize', '57');
  await c.click('#uniAskBtn');
  await waitToast(c, 'Asked for 2 items');
  const mine = () => db.row.state.uniform.filter(r => r.cadetId === 'cadet-3');
  assert.deepEqual(mine().map(r => [r.item, r.size || '', r.status, r.self]).sort(), [['beret', '57', 'requested', true], ['hackle', '', 'requested', true]]);
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-q', 'Uniform request']]);
  const beret = mine().find(r => r.item === 'beret').id, hackle = mine().find(r => r.item === 'hackle').id;
  const received = id => c.click(`#uniMine button[data-id="${id}"]:has-text("Received")`);
  await received(beret);
  assert.match(await c.textContent('#uniMine'), /CQMS has not placed the order yet/);

  // Paying: the total, the QR and the UPI ID; the screenshot is for the beret only
  await c.waitForSelector('#uniMinePay img[alt="QR code to pay"]');
  assert.match(await c.textContent('#uniMinePay'), /To pay\s*₹340[\s\S]*NCC Unit Fund[\s\S]*nccunit@sbi/);
  await c.uncheck(`#uniMinePay input[data-id="${hackle}"]`);
  assert.match(await c.textContent('#uniMinePay'), /To pay\s*₹300/);
  await c.setInputFiles('#uniMinePay input[type=file]', { name: 'paid.png', mimeType: 'image/png', buffer: PNG });
  await waitToast(c, 'Payment screenshot sent');
  const b = () => db.row.state.uniform.find(r => r.id === beret);
  assert.equal(b().pay.status, 'submitted');
  assert.ok(db.files.has(b().pay.file));
  assert.equal(db.pushes.at(-1).payload.title, 'Payment to check');
  assert.match(db.pushes.at(-1).payload.body, /CDT Samahith M Rao paid Rs 300 for Beret \(size 57\)/);

  // CQMS places the order and it arrives; until the payment is approved the cadet can't collect
  await refresh(q);
  await run(q, () => placeUniformOrder());
  await flush(q); await refresh(c);
  await received(beret);
  assert.match(await c.textContent('#uniMine'), /CQMS has not received the order yet/);
  await run(q, () => markUniformOrderArrived());
  await flush(q); await refresh(c);
  await received(beret);
  assert.match(await c.textContent('#uniMine'), /CQMS has not approved your payment yet/);
  await received(hackle);
  assert.match(await c.textContent('#uniMine'), /Pay for it first and upload the payment screenshot/);
  await assert.rejects(db.api('user-c', 'uniformReceived', { id: beret }), /CQMS has not approved your payment yet/);

  // CQMS looks at the screenshot and approves the payment; the cadet is told
  await refresh(q);
  assert.match(await q.textContent('#uniPayChecks'), /Payments to check\s*1[\s\S]*CDT Samahith M Rao\s*₹300/);
  await q.click('#uniPayChecks button:has-text("Screenshot")');
  await q.waitForFunction(() => document.getElementById('imageView').src.startsWith('data:image/'));
  await run(q, () => app.closeModal('imageModal'));
  await q.click('#uniPayChecks button:has-text("Approve")');
  await waitToast(q, 'Payment approved');
  assert.equal(b().pay.status, 'approved');
  assert.deepEqual([db.pushes.at(-1).userId, db.pushes.at(-1).payload.title], ['user-c', 'Payment approved']);
  assert.equal(await q.isVisible('#uniPayChecks'), false, 'nothing left to check');

  // The cadet collects it and marks it received; the screenshot is no longer kept
  await refresh(c);
  await received(beret);
  await waitToast(c, 'Marked received');
  assert.equal(b().status, 'received');
  assert.equal(b().pay.file, undefined);
  assert.equal([...db.files.keys()].some(k => k.startsWith('pay/')), false);

  // A payment that is not accepted: the cadet sees why and can send it again
  assert.match(await c.textContent('#uniMinePay'), /To pay\s*₹0/, 'the hackle is still unticked');
  await c.check(`#uniMinePay input[data-id="${hackle}"]`);
  await c.setInputFiles('#uniMinePay input[type=file]', { name: 'paid.png', mimeType: 'image/png', buffer: PNG });
  await waitToast(c, 'Payment screenshot sent');
  await refresh(q);
  await setPrompt(q, 'Amount not received');
  await q.click('#uniPayChecks button:has-text("Not accepted")');
  await waitToast(q, 'Marked not accepted');
  await refresh(c);
  assert.match(await c.textContent('#uniMine'), /Payment not accepted[\s\S]*CQMS: Amount not received/);
  assert.match(await c.textContent('#uniMinePay'), /send again/);
  assert.equal(db.pushes.at(-1).payload.title, 'Payment not accepted');
  await assert.rejects(db.api('user-c', 'payDecide', { proofId: 'x', ok: true }), /CQMS/);

  // A QR picture that does not load is fetched again once, not over and over
  const qrFile = db.files.get(db.tables.cadetflow_settings.find(s => s.key === 'payment').value.qr);
  qrFile.base64 = Buffer.from('not a picture').toString('base64');
  const payInfoCalls = () => db.calls.filter(x => x.action === 'payInfo' && x.userId === 'user-c').length;
  const callsBefore = payInfoCalls();
  await run(c, () => loadPayInfo(true));
  await c.waitForFunction(() => UPAY.qrRetryAt > 0);
  await c.waitForTimeout(1500);
  assert.equal(payInfoCalls() - callsBefore, 2, 'one fetch, then one more after the picture failed');

  // Something not ordered yet can be withdrawn
  await c.click('#uniAsk summary');
  await run(c, () => toggleAskItem('socks'));
  await c.click('#uniAskBtn');
  await waitToast(c, 'Asked for 1 item');
  const socks = mine().find(r => r.item === 'socks').id;
  await c.click(`#uniMine button[data-id="${socks}"]:has-text("Withdraw")`);
  await waitToast(c, 'Request withdrawn');
  assert.equal(mine().some(r => r.item === 'socks'), false);
  noErrors(admin, q, c);
}));

test('server rules: who gets a parade notification, which screenshots go, when items can be collected', async () => {
  const rules = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'cadetflow-api', 'rules.mjs')).href);
  const cadets = [{ id: 'c1', year: '1st', company: 'Jessami' }, { id: 'c2', year: '2nd', company: 'Kohima' }, { id: 'c3', year: '2nd', company: 'Jessami' }];
  const profiles = [{ user_id: 'u1', cadet_id: 'c1', status: 'approved' }, { user_id: 'u2', cadet_id: 'c2', status: 'approved' },
    { user_id: 'u3', cadet_id: 'c3', status: 'pending' }, { user_id: 'staff', cadet_id: null, status: 'approved' }];
  assert.deepEqual(rules.paradeRecipients(profiles, cadets, { scope: 'All', years: ['2nd'] }), ['u2', 'staff'], 'only 2nd years (and staff accounts)');
  assert.deepEqual(rules.paradeRecipients(profiles, cadets, { scope: 'Jessami' }), ['u1', 'staff']);
  assert.deepEqual(rules.paradeRecipients(profiles, cadets, { cadetIds: ['c2'] }), ['u2', 'staff']);
  assert.deepEqual(rules.paradeRecipients(profiles, cadets, { years: ['1st', '2nd', '3rd'] }), ['u1', 'u2', 'staff']);
  assert.equal(rules.audienceText({ scope: 'Kohima', years: ['2nd'] }), 'Kohima (2nd year)');

  const who = rank => ({ admin: false, rank });
  assert.deepEqual(rules.RANKS.map(r => ['task', 'requests', 'parade', 'uniform'].filter(p => rules.can(who(r), p)).join('+')),
    ['', 'task', 'task', 'task+requests', 'task+requests+uniform', 'task+requests', 'task+requests+parade', 'task+requests+parade']);
  assert.equal(rules.can({ admin: true, rank: null }, 'admin'), true);
  assert.equal(rules.can({ admin: false, rank: null }, 'task'), false, 'not linked to a cadet: no powers');

  const now = Date.now();
  assert.equal(rules.requestsOpen({ reportAt: now + 31 * 60000 }, now), true);
  assert.equal(rules.requestsOpen({ reportAt: now + 29 * 60000 }, now), false);
  const parades = [{ id: 'p-old', reportAt: now - 4 * 3600000 }, { id: 'p-new', reportAt: now + 3600000 }];
  const { deleteRows, clearImages } = rules.requestCleanup([
    { id: 'a', parade_id: 'p-old', status: 'approved', image_path: 'x' },
    { id: 'b', parade_id: 'p-old', status: 'pending', image_path: 'y' },
    { id: 'c', parade_id: 'p-new', status: 'approved', image_path: 'z' },
    { id: 'd', parade_id: 'deleted', status: 'pending', image_path: 'w' },
  ], parades, now);
  assert.deepEqual([deleteRows.map(r => r.id), clearImages.map(r => r.id)], [['d'], ['a']]);

  const u = (id, status, pay) => ({ id, status, pay });
  assert.deepEqual(rules.payProofsToDelete([
    u('1', 'received', { status: 'approved', proofId: 'P1', file: 'f1' }), u('2', 'received', { status: 'approved', proofId: 'P1', file: 'f1' }),
    u('3', 'arrived', { status: 'approved', proofId: 'P2', file: 'f2' }),
    u('4', 'ordered', { status: 'rejected', proofId: 'P3', file: 'f3', at: now - 40 * 86400000, decidedAt: now - 31 * 86400000 }),
    u('5', 'ordered', { status: 'rejected', proofId: 'P4', file: 'f4', at: now - 40 * 86400000, decidedAt: now - 2 * 86400000 }),
  ], now), ['P1', 'P3']);

  const prices = [{ id: 'beret', price: 300 }, { id: 'lanyard', price: 0 }];
  const block = r => rules.uniformReceiveBlock({ item: 'beret', qty: 1, ...r }, prices);
  assert.equal(block({ status: 'requested' }), 'CQMS has not placed the order yet.');
  assert.equal(block({ status: 'ordered', pay: { status: 'approved' } }), 'CQMS has not received the order yet.');
  assert.equal(block({ status: 'arrived' }), 'Pay for it first and upload the payment screenshot.');
  assert.equal(block({ status: 'arrived', pay: { status: 'submitted' } }), 'CQMS has not approved your payment yet.');
  assert.equal(block({ status: 'arrived', pay: { status: 'approved' } }), '');
  assert.equal(block({ status: 'arrived', paid: true }), '', 'older entries marked paid');
  assert.equal(block({ status: 'arrived', item: 'lanyard' }), '', 'free items need no payment');
  assert.equal(block({ status: 'arrived', item: 'belt' }), 'CQMS has not set a price for this item yet, so it cannot be paid.');
  assert.equal(block({ status: 'received' }), 'Already received.');
});

test('regimental numbers: set in the roster editor (capitals, no spaces, no duplicates), shown with the rank on the profile', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await run(a, () => app.openRosterModal());
  // The editor puts the cursor in its search box a moment after opening; type only after that.
  await a.waitForFunction(() => document.activeElement?.id === 'rosterSearch');
  const box = id => `#modalRosterTableBody tr[data-cadet-id="${id}"] input[aria-label="Regimental number"]`;
  await a.fill(box('cadet-1'), 'ka 21 sd 001'); await a.press(box('cadet-1'), 'Enter');
  await flush(a);
  assert.equal(db.cadet('cadet-1').regNo, 'KA21SD001');
  assert.equal(await a.inputValue(box('cadet-1')), 'KA21SD001');
  await a.fill(box('cadet-2'), 'KA21SD001'); await a.press(box('cadet-2'), 'Enter');
  await waitToast(a, 'already has regimental number KA21SD001');
  assert.equal(await a.inputValue(box('cadet-2')), '');
  await run(a, () => { app.closeModal('rosterModal'); openCadetProfile('cadet-1'); });
  assert.match(await a.textContent('#profileHead'), /LCPL Harsh Rajesh Koti\s*Lance Corporal · Regimental no\. KA21SD001/);
  await run(a, () => { app.closeModal('profileModal'); openCadetProfile('cadet-2'); });
  assert.match(await a.textContent('#profileHead'), /Regimental no\. not added yet/);
  // On a phone the number sits on its own line of the cadet's card
  await a.setViewportSize({ width: 390, height: 800 });
  await run(a, () => { app.closeModal('profileModal'); app.openRosterModal(); });
  assert.equal(await a.isVisible(box('cadet-1')), true);
  noErrors(a);
}));

// ---- What the database itself refuses (trigger cadetflow_state_guard), whatever a page sends -----------
/** A hand-made save, as anyone could send one with their own sign-in: read the shared data, change it, write it back. */
const handSave = (page, kind) => run(page, async kind => {
  const { data } = await app.supabase.from('cadetflow_state').select('state, updated_at').eq('id', 1).maybeSingle();
  const s = data.state;
  let values = { state: s };
  if (kind === 'rank') s.cadets.find(c => c.id === 'cadet-1').rank = 'CQMS';
  if (kind === 'add cadet') s.cadets.push({ id: 'cadet-fake', name: 'Fake Senior', rank: 'SUO', wing: 'SD', company: 'Jessami' });
  if (kind === 'wipe') values = { state: { events: s.events } };
  if (kind === 'pay') s.uniform.find(r => r.id === 'uni-old').pay = { status: 'approved', at: 1, proofId: 'pay-x' };
  if (kind === 'price') s.uniformPrices = [{ id: 'belt', price: 1 }];
  if (kind === 'equipment') s.equipment = [{ id: 'equip-x', cadetId: 'cadet-3', item: 'Rifle', qty: 1, issuedAt: 1 }];
  if (kind === 'delete task') s.events = s.events.slice(1);
  if (kind === 'task') s.events[0].title = 'Renamed by hand';
  if (kind === 'move') values = { id: 2 };
  const { data: rows, error } = await app.supabase.from('cadetflow_state').update(values).eq('id', 1).select('id');
  return error ? `${error.code}: ${error.message}` : rows.length ? 'saved' : 'not saved';
}, kind);

test('the database keeps the roster and deleting tasks to the administrator, and uniform to the CQMS, even for hand-made saves', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.updateCadetField('cadet-5', 'rank', 'CQMS'));
  await flush(admin);
  await admin.context().close();
  db.pages.length = 0;
  db.account('user-l', { cadetId: 'cadet-1' }).account('user-q', { cadetId: 'cadet-5' }).account('user-c', { cadetId: 'cadet-6' });

  // Data the way an older version or the server may have left it: not in the shape the site tidies it into
  const s = db.row.state;
  s.cadets.find(c => c.id === 'cadet-9').rank = 'cdt';
  delete s.cadets.find(c => c.id === 'cadet-10').wing;
  s.uniform = [{ id: 'uni-old', cadetId: 'cadet-7', item: 'belt', qty: '2', status: 'ordered', requestedAt: 1, orderedAt: 2, requestedBy: 'CQMS' }];
  s.uniformPrices = [{ id: 'belt', price: '120' }];
  const locked = () => JSON.stringify([db.row.state.cadets, db.row.state.uniform, db.row.state.uniformPrices]);
  const before = locked();

  // The LCPL's ordinary saves go through, and send the roster and uniform back exactly as stored
  const lcpl = await openAs(browser, db, 'user-l');
  await run(lcpl, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-2']); });
  await flush(lcpl);
  assert.equal(db.row.state.duties.length, 1, 'the call-out was saved');
  assert.equal(await run(lcpl, () => app.hasUnsyncedChanges), false);
  assert.equal(locked(), before, 'roster, uniform and prices untouched');
  assert.equal(await run(lcpl, () => app.state.cadets.find(c => c.id === 'cadet-9').rank), 'CDT', 'the page still shows them tidied up');

  // Hand-made saves that change what they may not: the database refuses them and nothing changes
  const writes = db.writes;
  for (const kind of ['rank', 'add cadet', 'wipe']) assert.equal(await handSave(lcpl, kind), '42501: Only the administrator can change the roster.', kind);
  assert.equal(await handSave(lcpl, 'delete task'), '42501: Only the administrator can remove tasks.');
  for (const kind of ['pay', 'price', 'equipment']) assert.equal(await handSave(lcpl, kind), '42501: Only the CQMS and the administrator can change uniform orders, payments, prices and equipment.', kind);
  assert.equal(await handSave(lcpl, 'move'), '42501: The shared data cannot be moved.');
  assert.equal(db.writes, writes, 'nothing was written');
  assert.equal(locked(), before);
  assert.equal(await handSave(lcpl, 'task'), 'saved', 'the rest is still theirs to change');

  // The CQMS changes uniform and prices (by hand or on the page), not the roster
  const cqms = await openAs(browser, db, 'user-q');
  assert.equal(await handSave(cqms, 'rank'), '42501: Only the administrator can change the roster.');
  assert.equal(await handSave(cqms, 'price'), 'saved');
  await run(cqms, () => setUniformArrived('uni-old', true));
  await flush(cqms);
  assert.equal(db.row.state.uniform.find(r => r.id === 'uni-old').status, 'arrived');

  // Cadets below LCPL save nothing; the administrator can change anything but cannot move the row
  const cdt = await openAs(browser, db, 'user-c');
  assert.equal(await handSave(cdt, 'task'), 'not saved');
  const admin2 = await openAs(browser, db, 'user-b');
  assert.equal(await handSave(admin2, 'move'), '42501: The shared data cannot be moved.');
  assert.equal(await handSave(admin2, 'rank'), 'saved');
  assert.equal(db.cadet('cadet-1').rank, 'CQMS');
  noErrors(lcpl, cqms, cdt, admin2);
}));

test('registration never says whether a regimental number is right; an invite replaces an account someone else made with that email', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.updateCadetField('cadet-12', 'regNo', 'KA21SD555'));
  await flush(admin);
  const reg = (cadetId, email, regNo, password = 'secret-123') => db.api(null, 'register', { cadetId, email, regNo, password });
  const invite = (...people) => db.api('user-a', 'invite', { people, send: false });

  // A number that is not the roster's is not refused (that would let anyone try numbers until one fits).
  // The administrator sees it before approving.
  assert.deepEqual(await reg('cadet-12', 'prahast@example.com', 'ka21 sd 556'), { ok: true });
  assert.equal(db.profile(db.userByEmail('prahast@example.com').id).regimental_no, 'KA21SD556');
  await run(admin, () => switchCadetFlowPage('accounts'));
  await run(admin, () => loadAccounts(true));
  await admin.waitForSelector('#accountsBody h3:has-text("Members")');
  let body = await admin.textContent('#accountsBody');
  assert.match(body, /Regimental no\. given: KA21SD556 roster has KA21SD555/);
  assert.match(body, /Anyone who knows a cadet's email and regimental number can register as them/);

  // Someone registered with a cadet's email and a password of their own. The list import says what will happen...
  await reg('cadet-13', 'cadet13@example.com', 'KA21SD600', 'their-own-pw');
  const pending = db.userByEmail('cadet13@example.com').id;
  await run(admin, () => loadAccounts(true));
  const csv = `Name,Email,Regimental No\n${db.cadet('cadet-13').name},cadet13@example.com,\n`;
  await admin.setInputFiles('#accountsBody input[type=file]', { name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await admin.waitForFunction(() => ACC.import && ACC.import.length === 1);
  assert.match(await admin.textContent('#accountsBody'), /Registered and waiting: approve it below to keep it, or it is replaced with a fresh invite/);
  // ...and the invite removes that account, so its password stops working: only the email's owner gets the invite
  const one = await invite({ cadetId: 'cadet-13', email: 'cadet13@example.com' });
  assert.deepEqual([one.results[0].result, one.results[0].replaced], ['link', true]);
  assert.equal(db.users.has(pending), false);
  assert.equal(db.signIn('cadet13@example.com', 'their-own-pw').error, 'Invalid login credentials');
  const invited = db.userByEmail('cadet13@example.com');
  assert.deepEqual([db.profile(invited.id).status, db.profile(invited.id).cadet_id, invited.email_confirmed_at], ['approved', 'cadet-13', null]);

  // Someone registered as a cadet with another email: the administrator decides on that one first
  await reg('cadet-16', 'someone-else@example.com', 'KA21SD601', 'other-pw-1');
  const blocked = await invite({ cadetId: 'cadet-16', email: 'cadet16@example.com' });
  assert.equal(blocked.results[0].result, 'error');
  assert.match(blocked.results[0].error, /registration waiting from someone-else@example\.com: approve or reject it/);

  // An approved account that belongs to another cadet is not moved; the same email twice is done once
  db.account('user-x', { cadetId: 'cadet-17', email: 'x17@example.com' });
  const moved = await invite({ cadetId: 'cadet-18', email: 'x17@example.com' });
  assert.match(moved.results[0].error, /This email's account belongs to /);
  assert.equal(db.profile('user-x').cadet_id, 'cadet-17');
  const twice = await invite({ cadetId: 'cadet-19', email: 'dup@example.com' }, { cadetId: 'cadet-20', email: 'dup@example.com' });
  assert.deepEqual(twice.results.map(r => r.result), ['link', 'error']);
  assert.match(twice.results[1].error, /already higher up in the list/);
  assert.equal(db.profile(db.userByEmail('dup@example.com').id).cadet_id, 'cadet-19');

  // A sign-in made outside the site (no CadetFlow profile, password chosen by whoever made it) gives way to a fresh invite
  db.addUser({ id: 'user-squat', email: 'cadet14@example.com', password: 'squatter-pw' });
  const two = await invite({ cadetId: 'cadet-14', email: 'cadet14@example.com' });
  assert.equal(two.results[0].result, 'link');
  assert.equal(db.users.has('user-squat'), false);
  assert.equal(db.signIn('cadet14@example.com', 'squatter-pw').error, 'Invalid login credentials');
  const fresh = db.userByEmail('cadet14@example.com').id;
  assert.deepEqual([db.profile(fresh).status, db.profile(fresh).cadet_id], ['approved', 'cadet-14']);

  // Someone registers the email while its invite is being made: their account is not taken over
  db.beforeInviteLink = email => db.account('user-race', { status: 'pending', email, password: 'race-pw', cadetId: 'cadet-21' });
  const raced = await invite({ cadetId: 'cadet-22', email: 'race@example.com' });
  assert.equal(raced.results[0].result, 'error');
  assert.deepEqual([db.profile('user-race').status, db.profile('user-race').cadet_id], ['pending', 'cadet-21']);
  noErrors(admin);
}));

test('a tab coming back into focus while a save is on its way keeps that save', () => withBrowser(async browser => {
  const db = makeDb().account('user-l', { cadetId: 'cadet-1' });
  const admin = await openAs(browser, db, 'user-a'); // puts the roster in the shared data
  await flush(admin);
  await admin.context().close();
  db.pages.length = 0;
  const lcpl = await openAs(browser, db, 'user-l');
  assert.equal(await run(lcpl, () => app.canEdit()), true);
  // Hold the LCPL's next save on its way to the database
  let release, held = false, holding = true;
  const gate = new Promise(r => { release = r; });
  const exec = db.clientExec.bind(db);
  db.clientExec = async (q, uid) => {
    if (holding && uid === 'user-l' && q.table === 'cadetflow_state' && q.op === 'update') { holding = false; held = true; await gate; }
    return exec(q, uid);
  };
  const id = await createTask(lcpl, 'Kit check');
  const saving = flush(lcpl);
  for (let i = 0; i < 200 && !held; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(held, true);
  // supabase-js says "signed in" again whenever a tab regains focus
  await run(lcpl, () => window.__emitAuth('SIGNED_IN'));
  await new Promise(r => setTimeout(r, 300));
  release();
  await saving;
  await refresh(lcpl);
  assert.ok(dbEvent(db, id), 'the task was saved');
  assert.equal(await run(lcpl, id => !!app.findEvent(id), id), true, 'and is still on the page');
  // The next save goes through too (it does not try to take the task away again)
  await run(lcpl, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-2']); });
  await flush(lcpl);
  assert.equal(db.row.state.duties.length, 1);
  assert.ok(dbEvent(db, id));
  assert.equal(await run(lcpl, () => app.hasUnsyncedChanges), false);
  noErrors(lcpl);
}));

test('names, titles and ids written to attack the page never run as code', () => withBrowser(async browser => {
  const db = makeDb().account('user-l', { cadetId: 'cadet-1' });
  // Breaks out of a JS string in an onclick, and out of an HTML attribute or text
  const P = `x');window.__pwned=(window.__pwned||0)+1;//"><img src=x onerror="window.__pwned=(window.__pwned||0)+1">`;
  let admin = await openAs(browser, db, 'user-a');
  // Written through the site itself
  await run(admin, P => app.updateCadetField('cadet-2', 'name', 'Cadet ' + P), P);
  const task = await createTask(admin, 'Task ' + P);
  const ev = await createSpecial(admin, 'Event ' + P, [{ name: 'Team ' + P, cadets: ['cadet-2', 'cadet-3'] }]);
  await addTask(admin, ev, 'Job ' + P, ['team-test-1'], { details: P });
  await run(admin, P => { window.prompt = () => P; app.recordCallOut(['cadet-2']); }, P);
  const parade = await makeParade(admin, 3, 'Parade ' + P);
  await flush(admin);
  await admin.context().close();
  db.pages.length = 0;
  // Written by hand into the shared data: text, and ids that would break out of an onclick
  const s = db.row.state;
  s.uniform = [{ id: 'uni-x1', cadetId: 'cadet-2', item: 'custom', custom: P, qty: 1, status: 'requested', requestedAt: 1, requestedBy: P }];
  s.uniformPrices = [{ id: 'custom:' + P.toLowerCase(), price: 10, label: P }];
  s.events.push({ id: P, title: 'Bad id', type: 'normal', cadetIds: [], completed: {}, createdAt: 1 });
  s.parades.push({ id: P, kind: 'custom', title: 'Bad parade', date: '2026-11-08', time: '07:00', reports: [] });
  s.duties.push({ id: P, cadetIds: ['cadet-3'], reason: 'Bad call-out', at: 1 });
  s.uniform.push({ id: P, cadetId: 'cadet-3', item: 'belt', qty: 1, status: 'requested', requestedAt: 1 });
  s.cadets.push({ id: P, name: 'Bad Id Cadet', rank: 'CDT', wing: 'SD', company: 'Jessami', year: '1st' });
  db.account('user-evil', { status: 'pending', email: `evil"><img src=x onerror=window.__pwned=1>@example.com`, name: P, regNo: P, cadetId: 'cadet-4' });

  const leaks = page => run(page, () => ({
    pwned: window.__pwned || 0,
    imgs: document.querySelectorAll('img[src="x"]').length,
    handlers: [...document.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name) && a.value.includes('__pwned')).map(a => `${el.tagName} ${a.name}`)),
  }));
  admin = await openAs(browser, db, 'user-a');
  assert.equal(await run(admin, P => [app.state.events, app.state.parades, app.state.duties, app.state.uniform].some(l => l.some(x => x.id === P)), P), false, 'items with unsafe ids are left out');
  assert.equal(await run(admin, P => app.state.cadets.some(c => c.id === P), P), false);
  assert.equal(await run(admin, () => app.state.cadets.some(c => c.name === 'Bad Id Cadet' && /^cadet-fix-/.test(c.id))), true, 'a cadet keeps their place under a plain id');
  const check = async (what, fn, arg) => {
    await run(admin, fn, arg);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(await leaks(admin), { pwned: 0, imgs: 0, handlers: [] }, what);
  };
  for (const pg of ['home', 'tasks', 'availability', 'directory', 'uniform', 'parades']) await check(pg, pg => switchCadetFlowPage(pg), pg);
  await run(admin, () => switchCadetFlowPage('tasks'));
  for (const id of [task, ev]) await check('task ' + id, id => app.switchEvent(id), id);
  await run(admin, () => switchCadetFlowPage('parades'));
  await check('parade', id => openParadeDetail(id), parade);
  await check('accounts', async () => { switchCadetFlowPage('accounts'); await loadAccounts(true); });
  await run(admin, () => { app.openRosterModal(); openCadetProfile('cadet-2'); });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await leaks(admin), { pwned: 0, imgs: 0, handlers: [] }, 'profile');
  assert.match(await admin.textContent('#accountsBody'), /evil"><img src=x onerror=window.__pwned=1>@example\.com/, 'shown as plain text');
  noErrors(admin);

  // Anyone who can save may clear out the items with unsafe ids; the rest of the tasks stay protected
  const lcpl = await openAs(browser, db, 'user-l');
  await run(lcpl, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-5']); });
  await flush(lcpl);
  assert.equal(await run(lcpl, () => app.hasUnsyncedChanges), false);
  assert.equal(db.row.state.events.some(e => e.id === P), false);
  assert.ok(dbEvent(db, task) && dbEvent(db, ev));
  assert.deepEqual(await leaks(lcpl), { pwned: 0, imgs: 0, handlers: [] });
  noErrors(lcpl);
}));

test('POC is ticked on the roster: they mark attendance and create tasks whatever their rank; the regimental number can wait', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  const pid = await makeParade(admin, 3, 'Sunday parade');
  // The administrator ticks POC in the roster editor
  await run(admin, () => app.openRosterModal());
  await admin.click('#modalRosterTableBody tr[data-cadet-id="cadet-6"] button[aria-label="POC"]');
  assert.equal(await run(admin, () => app.state.cadets.find(c => c.id === 'cadet-6').poc), true);
  assert.equal(await admin.getAttribute('#modalRosterTableBody tr[data-cadet-id="cadet-6"] button[aria-label="POC"]', 'aria-pressed'), 'true');
  await flush(admin);
  assert.equal(db.cadet('cadet-6').poc, true);

  // Registering without a regimental number works; the cadet adds it later, once
  assert.deepEqual(await db.api(null, 'register', { cadetId: 'cadet-6', email: 'six@example.com', regNo: '', password: 'secret-123' }), { ok: true });
  const six = db.userByEmail('six@example.com').id;
  assert.equal(db.profile(six).regimental_no, null);
  await db.api('user-a', 'approve', { userId: six });
  assert.equal(db.cadet('cadet-6').rank || 'CDT', 'CDT');

  const poc = await openAs(browser, db, six);
  assert.deepEqual(await run(poc, () => ['task', 'attendance', 'write', 'requests', 'parade', 'uniform', 'callout'].map(p => app.can(p))), [true, true, true, false, false, false, false]);
  await run(poc, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.equal(await poc.isVisible('#paradeAttendFolded'), true, 'before the parade the list is folded');
  await poc.click('#paradeAttendFolded button');
  const markBtn = `button[onclick*="setParadeMark('${pid}', 'cadet-2', 'present')"]`;
  assert.equal(await poc.isVisible(markBtn), true);
  await run(poc, id => setParadeMark(id, 'cadet-2', 'present'), pid);
  const tid = await createTask(poc, 'Clean the armoury');
  await flush(poc);
  assert.equal(db.row.state.parades.find(p => p.id === pid).marks['cadet-2'], 'present');
  assert.ok(dbEvent(db, tid));
  assert.equal(await run(poc, () => app.hasUnsyncedChanges), false);

  // Own regimental number: added once from the profile, then only the administrator changes it
  await run(poc, () => { window.prompt = () => 'ka21 sd 606'; openCadetProfile('cadet-6'); });
  await poc.click('#profileModal button:has-text("Add mine")');
  await poc.waitForFunction(() => app.myCadet()?.regNo === 'KA21SD606');
  assert.equal(db.cadet('cadet-6').regNo, 'KA21SD606');
  assert.equal(db.profile(six).regimental_no, 'KA21SD606');
  await assert.rejects(db.api(six, 'myRegNo', { regNo: 'KA21SD607' }), /already on the roster/);
  await run(poc, () => app.closeModal('profileModal'));

  // Un-ticking POC takes the powers away on their open page as soon as the change arrives
  await run(admin, () => app.rosterEdit('cadet-6', 'poc', 'no'));
  await flush(admin);
  await refresh(poc);
  assert.deepEqual(await run(poc, () => [app.can('attendance'), app.can('task'), document.body.classList.contains('can-attendance')]), [false, false, false]);
  assert.equal(await poc.isVisible(markBtn), false);
  noErrors(admin, poc);
}));

test('a new CQMS takes over uniform at once; the old one loses it as soon as their rank changes', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.rosterEdit('cadet-5', 'rank', 'CQMS'));
  await flush(admin);
  db.account('user-old', { cadetId: 'cadet-5' }).account('user-new', { cadetId: 'cadet-8' });
  const old = await openAs(browser, db, 'user-old');
  await run(old, () => switchCadetFlowPage('uniform'));
  assert.equal(await run(old, () => [app.can('uniform'), document.body.classList.contains('can-uniform')].join()), 'true,true');

  // The administrator makes cadet-8 CQMS (told that cadet-5 still is), then changes cadet-5's rank
  await run(admin, () => app.rosterEdit('cadet-8', 'rank', 'CQMS'));
  await waitToast(admin, 'also CQMS and can still place uniform orders');
  await run(admin, () => app.rosterEdit('cadet-5', 'rank', 'SGT'));
  await flush(admin);

  await refresh(old);
  assert.deepEqual(await run(old, () => [app.can('uniform'), document.body.classList.contains('can-uniform'), app.can('requests')]), [false, false, true]);
  // The server and the database follow the roster too
  await assert.rejects(db.api('user-old', 'setPayInfo', { upi: 'x@upi' }), /Only the CQMS/);
  const fresh = await openAs(browser, db, 'user-new');
  assert.equal(await run(fresh, () => app.can('uniform')), true);
  assert.deepEqual(await db.api('user-new', 'setPayInfo', { upi: 'new@upi', payee: 'CQMS' }), { ok: true });
  noErrors(admin, old, fresh);
}));

test('Back closes the open dialog, "/" finds the search box, offline is shown, and the header shows a save on its way', () => withBrowser(async browser => {
  const db = makeDb();
  const page = await openAs(browser, db, 'user-a');
  const profileHidden = () => page.evaluate(() => document.getElementById('profileModal').classList.contains('hidden'));

  // Back closes the dialog and stays on the site
  await run(page, () => openCadetProfile('cadet-1'));
  assert.equal(await profileHidden(), false);
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('profileModal').classList.contains('hidden'));
  assert.equal(await run(page, () => typeof app), 'object');
  // A dialog closed another way takes its Back step with it
  await run(page, () => openCadetProfile('cadet-1'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('profileModal').classList.contains('hidden') && !history.state?.cfModal);

  // "/" puts the cursor in the page's search box, but not while typing elsewhere
  await run(page, () => switchCadetFlowPage('directory'));
  await page.keyboard.press('/');
  assert.equal(await run(page, () => document.activeElement.id), 'dirSearch');
  await page.keyboard.type('/x');
  assert.equal(await page.inputValue('#dirSearch'), '/x');

  // Offline
  assert.equal(await page.isVisible('#netStatus'), false);
  await page.context().setOffline(true);
  await page.waitForFunction(() => document.body.classList.contains('is-offline'));
  assert.equal(await page.isVisible('#netStatus'), true);
  await page.context().setOffline(false);
  await page.waitForFunction(() => !document.body.classList.contains('is-offline'));

  // A save on its way lights the tricolour rule until it is done
  assert.equal(await run(page, () => { app.state.events = app.state.events || []; app.saveStorage(); return document.body.classList.contains('is-syncing'); }), true);
  await flush(page);
  assert.equal(await run(page, () => document.body.classList.contains('is-syncing')), false);
  noErrors(page);
}));

/** Give the first cadets years: ids 1-10 → 1st, 11-20 → 2nd, 21-30 → 3rd (as the administrator). */
const setYears = page => run(page, () => {
  for (let i = 1; i <= 30; i++) app.updateCadetField('cadet-' + i, 'year', i <= 10 ? '1st' : i <= 20 ? '2nd' : '3rd');
});
const device = (db, userId) => db.tables.cadetflow_push_subscriptions.push({ endpoint: 'https://push.example/' + userId, p256dh: 'p', auth: 'a', user_id: userId, created_at: new Date().toISOString() });
const ymdIn = days => { const d = new Date(Date.now() + days * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test('notice board: seniors post, everyone is notified and sees it on Home, seniors see who has seen it', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-1' }).account('user-c', { cadetId: 'cadet-3' }); // LCPL, CDT
  device(db, 'user-c'); device(db, 'user-v'); device(db, 'user-l');
  const lcpl = await openAs(browser, db, 'user-l');
  const cdt = await openAs(browser, db, 'user-c');

  // A cadet cannot post; the button is hidden and the server refuses
  assert.equal(await cdt.isVisible('#noticeNewBtn'), false);
  assert.equal(await cdt.isVisible('#noticeBoard'), false, 'no notices and nothing to post: no board');
  // The LCPL posts with a notification
  await lcpl.click('#noticeNewBtn');
  await lcpl.fill('#noticeText', 'Drill moves to the main ground <b>tomorrow</b>.');
  await lcpl.click('#noticePostBtn');
  await waitToast(lcpl, 'Notice posted. Sent to');
  const n = db.row.state.notices[0];
  assert.equal(n.text, 'Drill moves to the main ground <b>tomorrow</b>.');
  assert.equal(n.by, 'LCPL Harsh Rajesh Koti');
  assert.ok(n.until > Date.now() + 2.9 * 86400000, 'kept 3 days by default');
  assert.deepEqual(db.pushes.map(p => p.userId).sort(), ['user-a', 'user-b', 'user-c', 'user-v'].filter(u => db.tables.cadetflow_push_subscriptions.some(s => s.user_id === u)).sort(), 'everyone but the poster');
  assert.equal(db.pushes[0].payload.title, 'Notice from LCPL Harsh Rajesh Koti');
  await assert.rejects(db.api('user-c', 'announce', { id: n.id }), /lance corporals/);
  assert.deepEqual(await db.api('user-l', 'announce', { id: n.id }), { alreadySent: true, sent: 0, devices: 0, people: 0 }, 'only once');

  // The cadet sees it on Home (as text, not HTML) and that counts as seen
  await refresh(cdt);
  await cdt.waitForSelector('#noticeList [data-notice]');
  assert.match(await cdt.textContent('#noticeList .nb-text'), /<b>tomorrow<\/b>/);
  await cdt.waitForFunction(() => true);
  for (let i = 0; i < 50 && !db.tables.cadetflow_seen.some(r => r.user_id === 'user-c'); i++) await cdt.waitForTimeout(50);
  assert.ok(db.tables.cadetflow_seen.some(r => r.user_id === 'user-c' && r.item === 'notice:' + n.id));
  assert.equal(await cdt.isVisible('#noticeList button:has-text("Who has seen it")'), false, 'cadets do not see the list');
  await assert.rejects(db.api('user-c', 'seenBy', { item: 'notice:' + n.id }), /lance corporals/);

  // The LCPL opens "Who has seen it"
  await lcpl.click('#noticeList button:has-text("Who has seen it")');
  await lcpl.waitForSelector('#noticeList .seen-panel');
  const panel = await lcpl.textContent('#noticeList .seen-panel');
  assert.match(panel, /Seen \(\d+\)[\s\S]*CDT Samahith M Rao/);
  assert.match(panel, /Not seen yet/);
  assert.match(await lcpl.textContent('#noticeList .nb-actions'), /Seen by \d+ of 5/);

  // Only its poster (or the administrator) removes it
  assert.equal(await cdt.isVisible('#noticeList button:has-text("Remove")'), false);
  await lcpl.click('#noticeList button:has-text("Remove")');
  await flush(lcpl);
  assert.equal(db.row.state.notices.length, 0);
  assert.ok(db.row.state.history.some(h => h.action === 'notice-removed' && h.by === 'LCPL Harsh Rajesh Koti'));
  noErrors(admin, lcpl, cdt);
}));

test('repeating parades, the parade calendar, and deleting the rest of a series', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a', { viewport: { width: 1280, height: 900 } });
  await run(admin, d => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('drill');
    document.getElementById('paradeDate').value = d;
    document.getElementById('paradeTime').value = '06:30';
    document.getElementById('paradeRepeat').value = '7';
    document.getElementById('paradeRepeatCount').value = '5';
    updateParadeRepeatHint();
  }, ymdIn(3));
  assert.match(await admin.textContent('#paradeRepeatHint'), /^5 parades, from/);
  await run(admin, () => { if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade(); });
  await waitToast(admin, 'Created 5 Drill parades');
  await flush(admin);
  const list = db.row.state.parades;
  assert.equal(list.length, 5);
  assert.equal(new Set(list.map(p => p.seriesId)).size, 1);
  const gaps = list.slice(1).map((p, i) => Math.round((p.reportAt - list[i].reportAt) / 86400000));
  assert.deepEqual(gaps, [7, 7, 7, 7]);
  assert.ok(list.every(p => new Date(p.reportAt).getHours() === 6 && new Date(p.reportAt).getMinutes() === 30));
  // Editing a parade doesn't offer to repeat it
  await run(admin, id => openParadeModal(id), list[0].id);
  assert.equal(await admin.isVisible('#paradeRepeatBox'), false);
  await run(admin, () => app.closeModal('paradeModal'));

  // Calendar view shows them; picking a day lists it
  await run(admin, () => { closeParadeDetail(); setParadeView('calendar'); });
  assert.equal(await admin.isVisible('#paradeCalendar'), true);
  assert.equal(await admin.isVisible('#paradeUpcoming'), false);
  const first = new Date(list[0].reportAt);
  await run(admin, ({ y, m }) => { PAR.calY = y; PAR.calM = m; renderParadeCalendar(); }, { y: first.getFullYear(), m: first.getMonth() });
  await admin.click(`#paradeCalGrid button.pc-has >> nth=0`);
  assert.match(await admin.textContent('#paradeCalendar'), /Drill[\s\S]*06:30/);
  assert.equal(await run(admin, () => localStorage.getItem('cf-parade-view')), 'calendar', 'remembered');
  await run(admin, () => setParadeView('list'));

  // Deleting the 2nd asks about the later ones (the test accepts): 1 is left
  await run(admin, id => deleteParade(id), list[1].id);
  await flush(admin);
  assert.deepEqual(db.row.state.parades.map(p => p.id), [list[0].id]);
  noErrors(admin);
}));

test('reminders: parades 2 hours before and mess duty the evening before, each sent once', () => withBrowser(async browser => {
  const rules = await import('../supabase/functions/cadetflow-api/rules.mjs');
  const now = Date.UTC(2026, 10, 10, 14, 0); // 19:30 in India
  const at = h => now + h * 3600000;
  assert.deepEqual(rules.paradesToRemind([{ id: 'a', reportAt: at(1.5) }, { id: 'b', reportAt: at(3) }, { id: 'c', reportAt: at(0.1) }, { id: 'd', reportAt: at(-1) }], now).map(p => p.id), ['a']);
  const day = s => ({ id: 'mess-' + s, date: s, cadetIds: ['x'] });
  assert.deepEqual(rules.messToRemind([day('2026-11-10'), day('2026-11-11'), day('2026-11-12')], now).map(d => d.date), ['2026-11-10', '2026-11-11'], "today's (still before 8 pm) and tomorrow's");
  assert.deepEqual(rules.messToRemind([day('2026-11-11')], Date.UTC(2026, 10, 10, 6, 0)).length, 0, 'not in the morning before');

  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await flush(admin);
  db.account('user-1', { cadetId: 'cadet-1' }).account('user-12', { cadetId: 'cadet-12' });
  device(db, 'user-1'); device(db, 'user-12');
  db.row.state.parades = [
    { id: 'parade-soon', kind: 'drill', title: 'Drill', reportAt: Date.now() + 90 * 60000, scope: 'All', years: ['1st'], reports: [], marks: {} },
    { id: 'parade-later', kind: 'drill', title: 'Drill', reportAt: Date.now() + 5 * 3600000, scope: 'All', reports: [], marks: {} },
  ];
  const sent = r => ({ parades: r.parades, mess: r.mess }); // (weekly depends on the day of the week)
  assert.deepEqual(sent(await db.api(null, 'remind')), { parades: 1, mess: 0 }, 'needs no sign-in');
  assert.deepEqual(db.pushes.map(p => p.userId), ['user-1'], 'only the 1st year expected');
  assert.match(db.pushes[0].payload.title, /^In 1 h \d\d min: Drill$/);
  assert.deepEqual(sent(await db.api(null, 'remind')), { parades: 0, mess: 0 }, 'once');
  noErrors(admin);
}));

test('mess duty: refreshments switched on per parade; the advance volunteers are asked first, then every cadet, then the LCPLs and CPLs pick; no rank holders or locals', () => withBrowser(async browser => {
  const rules = await import('../supabase/functions/cadetflow-api/rules.mjs');
  // When each call is due
  const H = 3600000, t0 = Date.UTC(2026, 10, 10, 4, 0);
  const far = { id: 'p', reportAt: t0 + 7 * 24 * H };
  assert.equal(rules.messCallDue(far, null, 4, t0), 'standby');
  assert.equal(rules.messCallDue(far, { cadetIds: [], asked: { standby: t0, standbyN: 2 } }, 4, t0 + 11 * H), null, 'a week ahead: everyone is asked 12 hours later');
  assert.equal(rules.messCallDue(far, { cadetIds: [], asked: { standby: t0, standbyN: 2 } }, 4, t0 + 12 * H), 'all');
  assert.equal(rules.messCallDue(far, { cadetIds: [], asked: { standby: t0, standbyN: 0 } }, 4, t0), 'all', 'nobody on the list: everyone at once');
  assert.equal(rules.messCallDue(far, { cadetIds: [], asked: { standby: t0, all: t0 + 12 * H } }, 4, t0 + 2 * 24 * H), null, 'the LCPLs wait for the evening before');
  assert.equal(rules.messCallDue(far, { cadetIds: [], asked: { standby: t0, all: t0 + 12 * H } }, 4, rules.messEveningBefore(far.reportAt)), 'leads');
  assert.equal(rules.messCallDue(far, { cadetIds: ['a', 'b', 'c', 'd'], asked: {} }, 4, t0), null, 'full: nobody is asked');
  assert.equal(rules.messCallDue({ id: 'q', reportAt: t0 - 1 }, null, 4, t0), null, 'over');
  const soon = { id: 's', reportAt: t0 + 3 * H };
  assert.equal(rules.messCallDue(soon, { cadetIds: [], asked: { standby: t0, standbyN: 1 } }, 4, t0 + H), 'all', 'a parade soon: an hour later');
  assert.equal(rules.messCallDue(soon, { cadetIds: [], asked: { standby: t0, all: t0 + H } }, 4, t0 + 2 * H), 'leads', 'at the latest an hour before reporting');

  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => { app.updateCadetField('cadet-1', 'rank', 'LCPL'); app.updateCadetField('cadet-30', 'rank', 'CQMS'); app.updateCadetField('cadet-31', 'rank', 'SGT'); });
  const pid = await makeParade(admin, 3, 'Tea drill');
  const later = await makeParade(admin, 72, 'Later drill');
  await run(admin, () => { app.state.messConfig = { perDay: 4, years: ['1st', '2nd'], exempt: ['cadet-5'] }; app.saveStorage(); });
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-1' }).account('user-c', { cadetId: 'cadet-3' }).account('user-4', { cadetId: 'cadet-4' })
    .account('user-5', { cadetId: 'cadet-5' }).account('user-q', { cadetId: 'cadet-30' }).account('user-s', { cadetId: 'cadet-31' });
  ['user-l', 'user-c', 'user-4', 'user-5'].forEach(u => device(db, u));
  const until = async (cond, what) => { for (let i = 0; i < 80 && !cond(); i++) await new Promise(r => setTimeout(r, 100)); assert.ok(cond(), what); };
  const day = id => db.row.state.messDuty.find(d => d.paradeId === id);

  // Cadet 3 joins the advance volunteers list from the Mess duty dialog; rank holders and locals cannot
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => switchCadetFlowPage('parades'));
  assert.match(await c.textContent('#paradeTiles [data-tile="mess"]'), /Offer to help/);
  await c.click('#paradeTiles [data-tile="mess"]');
  await c.click('#messStandby input');
  await waitToast(c, 'asked first');
  assert.deepEqual(db.row.state.messStandby.map(x => x.cadetId), ['cadet-3']);
  await assert.rejects(db.api('user-l', 'messStandby', { on: true }), /only for cadets/);
  await assert.rejects(db.api('user-5', 'messStandby', { on: true }), /only for cadets/);
  await run(c, () => app.closeModal('messModal'));

  // The CQMS turns refreshments on at the parade: the advance volunteers hear at once
  const q = await openAs(browser, db, 'user-q');
  await run(q, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  await q.click('#paradeMess button:has-text("Refreshments: off")');
  await waitToast(q, 'asked first');
  await until(() => db.pushes.some(p => p.userId === 'user-c'), 'cadet 3 is asked');
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-c', 'Mess duty: Tea drill']]);
  assert.equal(db.pushes[0].payload.url, `./?parade=${encodeURIComponent(pid)}`);
  assert.equal(day(pid).asked.standbyN, 1);

  // Cadet 3 takes a place from the parade's page
  await refresh(c);
  await run(c, id => openParadeDetail(id), pid);
  await c.click('#paradeMess button:has-text("Volunteer")');
  await waitToast(c, 'Thank you');
  assert.deepEqual([day(pid).cadetIds, day(pid).volunteers], [['cadet-3'], ['cadet-3']]);

  // An hour on, still not full: every cadet who can do it is asked (not those on it, rank holders or locals)
  db.pushes.length = 0;
  day(pid).asked.standby -= 2 * 3600000;
  const r1 = await db.api(null, 'remind');
  assert.ok(r1.calls >= 1);
  const asked = db.pushes.filter(p => p.payload.title === 'Volunteers wanted: mess duty').map(p => p.userId);
  assert.deepEqual(asked, ['user-4'], 'of the accounts with a device, only cadet 4');
  await db.api('user-4', 'messVolunteer', { paradeId: pid });
  await assert.rejects(db.api('user-l', 'messVolunteer', { paradeId: pid }), /only for cadets/);
  assert.equal((await db.api(null, 'remind')).calls, 0, 'each call once');

  // Still not full: the lance corporals and corporals are told to pick
  db.pushes.length = 0;
  day(pid).asked.all -= 3 * 3600000;
  await db.api(null, 'remind');
  assert.deepEqual(db.pushes.filter(p => p.payload.title === 'Pick mess duty: Tea drill').map(p => p.userId), ['user-l']);
  assert.ok(db.row.state.history.some(h => /asked the lance corporals and corporals to pick/.test(h.details)));

  // The lance corporal opens Mess duty, takes the big button and fills the rest fairly
  const lcpl = await openAs(browser, db, 'user-l');
  await run(lcpl, () => switchCadetFlowPage('parades'));
  assert.match(await lcpl.textContent('#paradeTiles [data-tile="mess"]'), /1 to fill/);
  await lcpl.click('#paradeTiles [data-tile="mess"]');
  assert.equal(await lcpl.isVisible('#messStandby'), false, 'not for rank holders');
  await lcpl.click('#messCard .mess-lead-btn');
  assert.match(await lcpl.textContent('#messCard'), /advance volunteers asked · all cadets asked · LCPLs and CPLs asked to pick/);
  await lcpl.click(`#messCard [data-mess-parade="${pid}"] button:has-text("Fill the rest fairly")`);
  await flush(lcpl);
  const ids = day(pid).cadetIds, n = id => Number(id.slice(6));
  assert.equal(ids.length, 4);
  assert.deepEqual(ids.slice(0, 2), ['cadet-3', 'cadet-4']);
  assert.ok(ids.every(id => n(id) <= 20 && !['cadet-1', 'cadet-5'].includes(id)), 'no 3rd years, rank holders or locals');
  // Only the administrator changes who is a local
  await run(lcpl, () => toggleMessList('exempt', 'cadet-6'));
  await waitToast(lcpl, 'Only the administrator');
  await refresh(admin);
  await run(admin, () => toggleMessList('exempt', 'cadet-6'));
  await flush(admin);
  assert.deepEqual(db.row.state.messConfig.exempt, ['cadet-5', 'cadet-6']);

  // A sergeant sees a short list and a small Manage link
  const sgt = await openAs(browser, db, 'user-s');
  await run(sgt, () => switchCadetFlowPage('parades'));
  await sgt.click('#paradeTiles [data-tile="mess"]');
  assert.equal(await sgt.locator('#messCard .mess-lead-btn').count(), 0);
  assert.equal(await sgt.locator('#messCard button[title="Take off"]').count(), 0);
  await sgt.click('#messCard button:has-text("Manage")');
  assert.equal(await sgt.locator(`#messCard [data-mess-parade="${pid}"] button[title="Take off"]`).count(), 4);

  // Refreshments switch in the parade dialog (administrator); turning them on asks the advance volunteers
  await refresh(admin);
  await run(admin, id => { switchCadetFlowPage('parades'); openParadeDetail(id); openParadeModal(id); }, later);
  assert.equal(await admin.isVisible('#paradeRefreshWrap'), true);
  db.pushes.length = 0;
  await run(admin, () => { document.getElementById('paradeRefresh').checked = true; saveParade(); });
  await until(() => day(later)?.asked?.standby, 'asked on saving');
  assert.equal(db.row.state.parades.find(p => p.id === later).refreshments, true);
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-c', 'Mess duty: Later drill']]);
  // The cadet sees their duty in the Mess duty box
  await refresh(c);
  await run(c, () => { closeParadeDetail(); });
  assert.match(await c.textContent('#paradeTiles [data-tile="mess"]'), /You:/);

  // Turning refreshments off removes that parade's mess duty (Undo brings it back)
  await refresh(q);
  await run(q, id => toggleRefreshments(id), pid);
  await flush(q);
  assert.equal(db.row.state.messDuty.some(d => d.paradeId === pid), false);
  assert.equal(db.row.state.parades.find(p => p.id === pid).refreshments, false);
  noErrors(admin, lcpl, c, q, sgt);
}));

test('camps are recorded by JUOs and shown on profiles; a new academic year moves everyone up and keeps the 3rd years as past cadets', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-25', 'rank', 'JUO'));
  await flush(admin);
  db.account('user-j', { cadetId: 'cadet-25' }).account('user-c', { cadetId: 'cadet-3' });
  const juo = await openAs(browser, db, 'user-j');
  const cdt = await openAs(browser, db, 'user-c');

  await run(juo, () => switchCadetFlowPage('directory'));
  await juo.click('#campsCard button:has-text("Add camp")');
  await juo.selectOption('#campKind', 'CATC');
  await juo.fill('#campName', 'CATC-III');
  await juo.fill('#campPlace', 'Kohima');
  await juo.fill('#campStart', '2026-06-12');
  await juo.fill('#campEnd', '2026-06-21');
  await juo.fill('#campSearch', 'Samahith');
  await juo.check('#campPickList input');
  await juo.click('#campModal button:has-text("Save camp")');
  await flush(juo);
  const camp = db.row.state.camps[0];
  assert.deepEqual([camp.kind, camp.name, camp.place, camp.start, camp.end, camp.cadetIds], ['CATC', 'CATC-III', 'Kohima', '2026-06-12', '2026-06-21', ['cadet-3']]);
  await refresh(cdt);
  await run(cdt, () => { switchCadetFlowPage('directory'); openCadetProfile('cadet-3'); });
  assert.match(await cdt.textContent('#profileBody'), /Camps and courses[\s\S]*CATC[\s\S]*Kohima/);
  assert.equal(await cdt.isVisible('#campsCard button:has-text("Add camp")'), false, 'cadets only read');
  await run(cdt, () => app.closeModal('profileModal'));

  // New academic year (administrator only)
  assert.equal(await juo.isVisible('button:has-text("New academic year")'), false);
  await run(admin, () => { switchCadetFlowPage('directory'); startNewAcademicYear(); });
  await flush(admin);
  const s = db.row.state;
  const yearOf = id => s.cadets.find(c => c.id === id)?.year;
  assert.deepEqual([yearOf('cadet-1'), yearOf('cadet-11'), yearOf('cadet-21'), yearOf('cadet-35')], ['2nd', '3rd', undefined, undefined]);
  assert.equal(s.alumni.length, 10);
  assert.ok(s.alumni.every(a => a.year === '3rd' && a.leftAt));
  assert.ok(!s.cadets.some(c => c.id === 'cadet-25'));
  assert.ok(s.history.some(h => h.action === 'year-promoted'));
  // The JUO left with the 3rd years: no more JUO powers; the database keeps past cadets for the administrator
  await refresh(juo);
  assert.equal(await run(juo, () => app.can('parade')), false);
  const guard = db.guardRefuses('user-l', 'writer', db.row, { state: { ...s, alumni: [] } });
  assert.equal(guard, 'Only the administrator can change the roster.');
  // Bring one back
  await run(admin, () => bringBackCadet('cadet-21'));
  await flush(admin);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-21').year, '3rd');
  assert.equal(db.row.state.alumni.length, 9);
  noErrors(admin, juo, cdt);
}));

test('uniform payment summary for the CQMS, and the activity log page with search and kinds', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => {
    const base = { item: 'beret', qty: 1, status: 'ordered', orderId: 'order-1', orderedAt: Date.now() - 86400000, unitPrice: 300, requestedAt: Date.now() - 2 * 86400000 };
    app.state.uniform = normalizeUniform([
      { ...base, id: 'u1', cadetId: 'cadet-1', pay: { status: 'approved', proofId: 'p1', at: Date.now() } },
      { ...base, id: 'u2', cadetId: 'cadet-2', pay: { status: 'submitted', proofId: 'p2', at: Date.now() } },
      { ...base, id: 'u3', cadetId: 'cadet-3' },
      { ...base, id: 'u4', cadetId: 'cadet-4', unitPrice: 0 },
    ]);
    app.logHistory('parade-created', null, 'Created parade: Drill (test)');
    app.saveStorage();
    switchCadetFlowPage('uniform');
  });
  await admin.waitForTimeout(800); // money counts up
  const tiles = await admin.$$eval('#uniPaySummary .pay-tile', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(tiles, ['Billed₹900', 'Collected₹300', 'To check₹300', 'Not paid₹300']);
  assert.match(await admin.textContent('#uniPaySummary'), /Who still owes \(1\)/);

  // Activity log
  await run(admin, () => switchCadetFlowPage('activity'));
  assert.match(await admin.textContent('#actList'), /Today[\s\S]*Created parade: Drill \(test\)/);
  assert.equal(db.row.state.history.find(h => h.details === 'Created parade: Drill (test)')?.by ?? (await run(admin, () => app.state.history[0].by)), await run(admin, () => app.authorName()));
  await admin.click('#actKinds button:has-text("Uniform")');
  assert.doesNotMatch(await admin.textContent('#actList'), /Created parade/);
  await admin.click('#actKinds button:has-text("Everything")');
  await admin.fill('#actSearch', 'drill (test');
  assert.equal(await admin.$$eval('#actList .act-row', els => els.length), 1);
  await admin.fill('#actSearch', 'nothing like this');
  assert.match(await admin.textContent('#actList'), /Nothing matches/);
  noErrors(admin);
}));

test('a lively Home: greeting, a countdown that ticks in the last hour, online count, notices fold away, pull down to refresh', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-1' });
  const lcpl = await openAs(browser, db, 'user-l', { init: () => { window.ontouchstart = null; } });
  await lcpl.waitForFunction(() => /LCPL/.test(document.getElementById('homeHello').textContent), null, { timeout: 3000 });
  assert.match(await lcpl.textContent('#homeHello'), /^(Good (morning|afternoon|evening)|Up late), LCPL Harsh Rajesh Koti$/);

  // A parade 40 minutes away: the countdown shows seconds and moves on its own
  await run(lcpl, () => {
    const at = Date.now() + 40 * 60000;
    app.state.parades = [...(app.state.parades || []), { id: 'p-soon', title: 'Drill', date: new Date(at).toISOString().slice(0, 10), reportAt: at, time: '', expected: { mode: 'all' } }];
    app.saveStorage(); renderFeatures();
  });
  const soon = await lcpl.$('#homeNow .hn-soon [data-until]');
  assert.ok(soon, 'the next parade is marked as soon');
  const t1 = await soon.textContent();
  assert.match(t1, /^\d+ min \d\d s$/);
  await lcpl.waitForFunction(t => document.querySelector('#homeNow [data-until]')?.textContent !== t, t1, { timeout: 3000 });

  // Online now (presence): shown when the server reports devices
  await run(lcpl, () => { LIVE.count = 3; renderHomeNow(); });
  assert.match(await lcpl.textContent('#homeNow .hn-live'), /3 online now/);

  // A removed notice folds away, then is gone
  await lcpl.click('#noticeNewBtn');
  await lcpl.fill('#noticeText', 'Bring water bottles.');
  await lcpl.uncheck('#noticeNotify');
  await lcpl.click('#noticePostBtn');
  await lcpl.waitForSelector('#noticeList [data-notice]');
  assert.equal(await lcpl.getAttribute('#noticeList [data-ago]', 'data-ago') > 0, true);
  await lcpl.click('#noticeList button:has-text("Remove")');
  await lcpl.waitForSelector('#noticeList [data-notice].fx-out', { timeout: 1000 }).catch(() => {});
  await lcpl.waitForSelector('#noticeList [data-notice]', { state: 'detached', timeout: 2000 });

  // Pull down from the top of the page: it checks for changes and says so
  await run(lcpl, () => { window.__pulls = 0; const r = app.refreshFromRemote.bind(app); app.refreshFromRemote = () => { window.__pulls++; return r(); }; });
  await run(lcpl, () => window.scrollTo(0, 0));
  await run(lcpl, () => {
    const t = y => new Touch({ identifier: 1, target: document.body, clientX: 100, clientY: y });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(100)] }));
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [t(180)] }));
    document.dispatchEvent(new TouchEvent('touchmove', { touches: [t(300)] }));
    document.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
  });
  await waitToast(lcpl, 'Up to date.');
  assert.ok(await run(lcpl, () => window.__pulls) >= 1);
  noErrors(lcpl);
}));

// ---------------------------------------------------------------------------------------
// 2026-11-09: lighter sync, logo file, the site's own dialogs with Undo, parade changes and
// cancellations, leave, questions on notices, weekly summary, backups, not on the app yet,
// quick find, Your day, calendar files, attendance register, certificates.

test('an idle page only asks for the version of the shared data; the logo is its own file', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  const b = await openAs(browser, db, 'user-b');
  await flush(a);
  await run(b, () => app.refreshFromRemote());
  db.autoNotify = false; // b only finds out by checking
  const before = db.stateReads;
  for (let i = 0; i < 3; i++) assert.equal(await run(b, () => app.pullAndMerge()), false);
  assert.equal(db.stateReads, before, 'nothing downloaded while nothing changed');
  await run(a, () => app.updateCadetField('cadet-5', 'name', 'Pradeep M'));
  await flush(a);
  assert.equal(await run(b, () => app.pullAndMerge()), true);
  assert.equal(db.stateReads, before + 1, 'downloaded once after a change');
  assert.equal(await run(b, () => app.state.cadets.find(c => c.id === 'cadet-5').name), 'Pradeep M');
  // The emblem is a file next to the page, cached by the service worker
  assert.equal(await b.getAttribute('header img', 'src'), 'icons/emblem.png');
  assert.ok(fs.statSync(path.join(__dirname, '..', 'icons', 'emblem.png')).size < 20000);
  assert.ok(!/data:image\/png;base64,[A-Za-z0-9+/]{5000}/.test(fs.readFileSync(PAGE_URL.slice(7), 'utf8')), 'no large inline image');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /'\.\/icons\/emblem\.png'/);
  noErrors(a, b);
}));

test("the site's own question boxes: OK, Cancel, Escape, typed answers; small removals offer Undo", () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a', { init: () => { window.__cfNativeDialogs = false; } });
  await run(a, () => { window.__ans = askConfirm('Delete the drill?', { ok: 'Delete', danger: true }); });
  await a.waitForSelector('#cfAsk:not(.hidden)');
  assert.match(await a.textContent('#cfAskText'), /Delete the drill\?/);
  assert.equal(await a.textContent('#cfAskOk'), 'Delete');
  await a.click('#cfAskOk');
  assert.equal(await run(a, () => window.__ans), true);
  await run(a, () => { window.__ans = askConfirm('Sure?'); });
  await a.waitForSelector('#cfAsk:not(.hidden)');
  await a.keyboard.press('Escape');
  assert.equal(await run(a, () => window.__ans), false, 'Escape answers no');
  await a.waitForSelector('#cfAsk', { state: 'hidden' });
  await run(a, () => { window.__ans = askText('Your reason?', 'Fever'); });
  await a.waitForSelector('#cfAskInput:visible');
  assert.equal(await a.inputValue('#cfAskInput'), 'Fever');
  await a.fill('#cfAskInput', 'Exam');
  await a.press('#cfAskInput', 'Enter');
  assert.equal(await run(a, () => window.__ans), 'Exam');
  await run(a, () => { window.__ans = askConfirm('Leave?'); });
  await a.click('#cfAskCancel');
  assert.equal(await run(a, () => window.__ans), false);

  // Removing a notice asks nothing, and Undo puts it back where it was
  await a.click('#noticeNewBtn');
  await a.fill('#noticeText', 'Bring water bottles.');
  await a.uncheck('#noticeNotify');
  await a.click('#noticePostBtn');
  await a.waitForSelector('#noticeList [data-notice]');
  await a.click('#noticeList button:has-text("Remove")');
  await a.waitForSelector('#toastUndo:visible');
  assert.equal(await run(a, () => app.state.notices.length), 0);
  await a.click('#toastUndo');
  assert.equal(await run(a, () => app.state.notices.length), 1);
  await a.waitForSelector('#noticeList [data-notice]');
  await flush(a);
  assert.equal(db.row.state.notices.length, 1);
  assert.ok(db.row.state.history.some(h => h.action === 'notice-restored'));
  noErrors(a);
}));

test('a moved or cancelled parade is announced to its cadets, and the reminder follows the new time', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  db.account('user-1', { cadetId: 'cadet-1' }).account('user-12', { cadetId: 'cadet-12' });
  device(db, 'user-1'); device(db, 'user-12');
  const pid = await run(admin, () => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('drill');
    const at = new Date(Date.now() + 5 * 3600000), pad = n => String(n).padStart(2, '0');
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
    return PAR.openId;
  });
  await flush(admin);
  await run(admin, id => { const pd = findParade(id); pd.years = ['1st']; pd.scope = 'All'; app.saveStorage(); }, pid);
  await flush(admin);
  db.pushes.length = 0;

  // Move it: the administrator is asked, and only its cadets are told
  await run(admin, id => {
    openParadeModal(id);
    const at = new Date(findParade(id).reportAt + 30 * 60000), pad = n => String(n).padStart(2, '0');
    document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeVenue').value = 'Main ground';
    if (!PAR.editId && !paradeTurnoutValue()) setParadeTurnout('Full turnout in uniform', false); saveParade();
  }, pid);
  await waitToast(admin, 'Notification sent to 1 device');
  assert.deepEqual(db.pushes.map(p => p.userId), ['user-1']);
  assert.match(db.pushes[0].payload.title, /^Parade changed: Drill$/);
  assert.match(db.pushes[0].payload.body, /Main ground/);
  const pd = db.row.state.parades.find(p => p.id === pid);
  assert.deepEqual(await db.api('user-a', 'paradeChange', { paradeId: pid, was: { reportAt: pd.reportAt - 30 * 60000, venue: '' } }), { alreadySent: true, sent: 0, devices: 0, people: 0 }, 'the same change only once');
  await assert.rejects(db.api('user-12', 'paradeChange', { paradeId: pid, was: {} }), /JUO|SUO|administrator/);

  // Reminders: sent 2 hours before; moved again, the new time gets its own reminder
  db.pushes.length = 0;
  const moveTo = async mins => { db.row.state.parades.find(p => p.id === pid).reportAt = Date.now() + mins * 60000; };
  await moveTo(90);
  assert.equal((await db.api(null, 'remind')).parades, 1);
  assert.equal((await db.api(null, 'remind')).parades, 0, 'once for that time');
  await moveTo(100);
  assert.equal((await db.api(null, 'remind')).parades, 1, 'again for the new time');
  // An older reminder row (before reminders carried the time) still counts for the same time
  db.tables.cadetflow_push_sent.push({ parade_id: 'remind:legacy', sent_by: null, sent_at: new Date().toISOString() });
  db.row.state.parades.push({ id: 'legacy', kind: 'drill', title: 'Drill', reportAt: Date.now() + 100 * 60000, scope: 'All', years: ['1st'], reports: [], marks: {} });
  assert.equal((await db.api(null, 'remind')).parades, 0, 'legacy reminder already sent');

  // Cancel it: deleting an upcoming parade offers to tell its cadets first
  await refresh(admin);
  db.pushes.length = 0;
  await run(admin, id => deleteParade(id), pid);
  await admin.waitForFunction(id => !findParade(id), pid);
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-1', 'Cancelled: Drill']]);
  noErrors(admin);
}));

test('leave: a cadet asks for several days, a sergeant approves, those days are excused, notifications and mess duty skip them', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' }).account('user-4', { cadetId: 'cadet-4' });
  device(db, 'user-c'); device(db, 'user-4');

  // The cadet asks from the Parades page
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => switchCadetFlowPage('parades'));
  await c.click('#paradeTiles [data-tile="leave"]');
  await c.click('#leaveArea button:has-text("Ask for leave")');
  await c.fill('#lvFrom', ymdIn(1));
  await c.fill('#lvTo', ymdIn(3));
  await c.fill('#lvReason', 'Sister\'s wedding at home');
  await c.setInputFiles('#lvImage', { name: 'card.png', mimeType: 'image/png', buffer: PNG });
  await c.waitForFunction(() => !!LV.image);
  await c.click('#lvSubmit');
  await c.waitForFunction(() => document.getElementById('leaveModal').classList.contains('hidden'));
  const row = db.tables.cadetflow_requests[0];
  assert.deepEqual([row.kind, row.cadet_id, row.parade_id, String(row.from_date).slice(0, 10), String(row.to_date).slice(0, 10), row.status], ['leave', 'cadet-3', 'leave:' + ymdIn(1), ymdIn(1), ymdIn(3), 'pending']);
  assert.ok(row.image_path && row.image_path.startsWith('leave/'));
  assert.match(await c.textContent('#leaveArea'), /Your leave[\s\S]*Waiting for a decision/);
  await assert.rejects(db.api('user-c', 'leave', { from: ymdIn(-5), to: ymdIn(-3), reason: 'Old trip' }), /already over/);
  await assert.rejects(db.api('user-c', 'leave', { from: ymdIn(3), to: ymdIn(1), reason: 'Backwards' }), /before the first day/);

  // A sergeant sees it waiting on the Parades page and approves it
  const g = await openAs(browser, db, 'user-g');
  await run(g, () => switchCadetFlowPage('parades'));
  await g.click('#paradeTiles [data-tile="requests"]');
  await g.waitForFunction(() => /Leave waiting for a decision\s*1/.test(document.getElementById('requestsBody').textContent));
  assert.match(await g.textContent('#requestsBody'), /Samahith M Rao[\s\S]*3 days[\s\S]*Sister's wedding/);
  await g.click('#requestsBody button:has-text("Approve the whole leave")');
  await waitToast(g, 'Leave approved');
  const leave = db.row.state.leaves[0];
  assert.deepEqual([leave.id, leave.cadetId, leave.from, leave.to, leave.by], ['leave-' + row.id, 'cadet-3', ymdIn(1), ymdIn(3), 'SGT Manusree T']);
  assert.deepEqual(db.pushes.filter(p => p.userId === 'user-c').map(p => p.payload.title), ['Leave approved']);

  // A parade on day 2 for 1st years: cadet-3 is excused and not notified; cadet-4 is
  const pid = await makeParade(admin, 48, 'Drill on leave day');
  await run(admin, id => { const pd = findParade(id); pd.years = ['1st']; app.saveStorage(); }, pid);
  await flush(admin);
  await refresh(admin);
  assert.equal(await run(admin, id => paradeStatus(findParade(id), 'cadet-3'), pid), 'excused');
  assert.equal(await run(admin, id => paradeStatus(findParade(id), 'cadet-4'), pid), 'unmarked');
  db.pushes.length = 0;
  await db.api('user-a', 'notify', { paradeId: pid, again: true });
  assert.deepEqual(db.pushes.map(p => p.userId), ['user-4']);
  await run(admin, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.match(await admin.textContent('#paradeDetailView'), /On leave \(approved\)/);
  // Mess duty leaves them out on those days only
  assert.equal(await run(admin, d => messPick({ date: d }, 40, new Map(), new Set()).includes('cadet-3'), ymdIn(2)), false);
  assert.equal(await run(admin, d => messPick({ date: d }, 40, new Map(), new Set()).includes('cadet-3'), ymdIn(6)), true);
  // Shown on the profile
  await refresh(c);
  await run(c, () => openCadetProfile('cadet-3'));
  assert.match(await c.textContent('#profileBody'), /Leave[\s\S]*3 days[\s\S]*coming up/);

  // The sergeant cancels it before it starts, then undoes that
  await refresh(g);
  await run(g, () => { switchCadetFlowPage('parades'); openRequestsDialog(); });
  await g.click('#requestsBody button:has-text("Cancel leave")');
  assert.equal(await run(g, () => app.state.leaves.length), 0);
  await g.click('#toastUndo');
  assert.equal(await run(g, () => app.state.leaves.length), 1);
  await flush(g);
  assert.equal(db.row.state.leaves.length, 1);
  noErrors(admin, c, g);
}));

test('questions on notices: everyone answers once (and can change it), writers see who answered what', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-1' }).account('user-c', { cadetId: 'cadet-3' });
  const lcpl = await openAs(browser, db, 'user-l');
  await lcpl.click('#noticeNewBtn');
  await lcpl.fill('#noticeText', 'Who is coming for the trek on Sunday?');
  await lcpl.check('#noticeAsk');
  await lcpl.fill('#noticeOptions', 'Coming, Not coming, Coming');
  await lcpl.uncheck('#noticeNotify');
  await lcpl.click('#noticePostBtn');
  await flush(lcpl);
  const n = db.row.state.notices[0];
  assert.deepEqual(n.options, ['Coming', 'Not coming']);

  const c = await openAs(browser, db, 'user-c');
  await c.waitForSelector('#noticeList .nb-opt');
  await c.waitForFunction(() => /Questions[\s\S]*1 to answer/.test(document.getElementById('myDay').textContent));
  await c.click('#noticeList .nb-opt:has-text("Not coming")');
  await c.waitForFunction(() => /1 answered/.test(document.getElementById('noticeList').textContent));
  assert.deepEqual(db.tables.cadetflow_answers.map(r => [r.notice_id, r.user_id, r.choice]), [[n.id, 'user-c', 1]]);
  assert.equal(await c.getAttribute('#noticeList .nb-opt:has-text("Not coming")', 'aria-pressed'), 'true');
  assert.doesNotMatch(await c.textContent('#myDay'), /to answer/);
  await c.click('#noticeList .nb-opt:has-text("Coming") >> nth=0');
  await c.waitForFunction(() => document.querySelector('#noticeList .nb-opt').getAttribute('aria-pressed') === 'true');
  assert.equal(db.tables.cadetflow_answers.length, 1, 'one answer per person');
  assert.equal(await c.isVisible('#noticeList button:has-text("Who answered what")'), false);
  await assert.rejects(db.api('user-c', 'answer', { noticeId: n.id, choice: 4 }), /Pick one/);
  await assert.rejects(db.api('user-c', 'answersBy', { noticeId: n.id }), /lance corporals/);

  await refresh(lcpl);
  await lcpl.click('#noticeList button:has-text("Who answered what")');
  await lcpl.waitForSelector('#noticeList .seen-panel');
  assert.match(await lcpl.textContent('#noticeList .seen-panel'), /Coming \(1\)[\s\S]*Samahith M Rao[\s\S]*Not coming \(0\)[\s\S]*Not answered yet/);
  noErrors(admin, lcpl, c);
}));

test('weekly summary: the administrator is told about the week on Sunday evening, once', () => withBrowser(async browser => {
  const rules = await import('../supabase/functions/cadetflow-api/rules.mjs');
  const sunday = Date.UTC(2026, 10, 15, 13, 30); // Sunday 19:00 in India
  assert.equal(rules.istWeekday(sunday), 0);
  const cadets = [{ id: 'a', name: 'A', company: 'Jessami' }, { id: 'b', name: 'B', company: 'Kohima' }];
  const past = h => sunday - h * 3600000;
  const parades = [1, 2, 3, 30, 60].map((h, i) => ({ id: 'p' + i, reportAt: past(h * 24), scope: 'All', marks: { a: 'present', b: i < 3 ? 'absent' : 'present' }, reports: [] }));
  const w = rules.weekSummary({ cadets, parades, leaves: [{ id: 'l', cadetId: 'b', from: '2026-11-13', to: '2026-11-13' }] }, sunday);
  assert.equal(w.parades, 3);
  assert.deepEqual(w.byCompany, [{ company: 'Jessami', pct: 100 }, { company: 'Kohima', pct: 0 }], "b's leave day is not counted");
  assert.deepEqual(w.under.map(x => x.id), ['b']);

  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  device(db, 'user-a'); device(db, 'user-v');
  const realNow = Date.now;
  try {
    Date.now = () => sunday;
    db.row.state.parades = parades.map(p => ({ ...p, title: 'Drill', kind: 'drill', marks: { 'cadet-1': 'present', 'cadet-2': 'absent' } }));
    const r = await db.api(null, 'remind');
    assert.equal(r.weekly, 1);
    const sent = db.pushes.filter(p => p.payload.title === 'The week in CadetFlow');
    assert.deepEqual(sent.map(p => p.userId), ['user-a'], 'administrators only');
    assert.match(sent[0].payload.body, /3 parades, attendance 50%/);
    assert.equal((await db.api(null, 'remind')).weekly, 0, 'once a week');
    Date.now = () => sunday - 86400000; // Saturday
    db.tables.cadetflow_push_sent = db.tables.cadetflow_push_sent.filter(r => !String(r.parade_id).startsWith('weekly:'));
    assert.equal((await db.api(null, 'remind')).weekly, 0, 'not on other days');
  } finally { Date.now = realNow; }
  noErrors(admin);
}));

test('backups: no nightly copy; the administrator makes one by hand and restores it (keeping a copy of now first)', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  const old = db.row.state.cadets.find(c => c.id === 'cadet-5').name;
  await assert.rejects(db.api('user-v', 'backups'), /administrator/);

  await run(admin, () => { switchCadetFlowPage('parades'); toggleMemoryMenu(); });
  await admin.click('#memoryDropdown button:has-text("Backups")');
  await admin.waitForFunction(() => /No backups yet/.test(document.getElementById('backupsBody').textContent));
  assert.doesNotMatch(await admin.textContent('#backupsModal'), /every night|nightly|2 am/i);
  await admin.click('#backupsBody button:has-text("Make a backup now")');
  await waitToast(admin, 'Backup made');
  assert.deepEqual(db.tables.cadetflow_backups.map(b => b.kind), ['manual']);

  await run(admin, () => app.updateCadetField('cadet-5', 'name', 'Wrong Name'));
  await flush(admin);
  await admin.click('#backupsBody li:has-text("Made by hand") button:has-text("Restore")');
  await waitToast(admin, 'Backup restored');
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-5').name, old);
  assert.equal(await run(admin, () => app.state.cadets.find(c => c.id === 'cadet-5').name), old);
  const kept = db.tables.cadetflow_backups.find(b => b.kind === 'before-restore');
  assert.equal(kept.state.cadets.find(c => c.id === 'cadet-5').name, 'Wrong Name', 'what it was just before is kept');
  assert.ok(db.row.state.history.some(h => h.action === 'backup-restored'));
  noErrors(admin);
}));

test('accounts page: cadets with no account yet, and accounts with no device for notifications', () => withBrowser(async browser => {
  const db = makeDb();
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-4', { cadetId: 'cadet-4' });
  device(db, 'user-c');
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => switchCadetFlowPage('accounts'));
  await admin.waitForFunction(() => /Not on the app yet/.test(document.getElementById('accountsBody').textContent));
  const total = await run(admin, () => app.state.cadets.length);
  const text = await admin.textContent('#accountsBody');
  assert.match(text, new RegExp(`No account \\(${total - 2} of ${total} cadets\\)`));
  assert.match(text, /no notifications on any device \(\d+\)/);
  await admin.click('#accountsBody summary:has-text("no notifications")');
  const noDev = await admin.textContent('#accountsBody details:has-text("no notifications")');
  assert.match(noDev, /Mattupalli/);
  assert.doesNotMatch(noDev, /Samahith/);
  await admin.click('#accountsBody summary:has-text("No account")');
  await admin.click('#accountsBody details:has-text("No account") li:has-text("Pradeep") button:has-text("Invite")');
  assert.equal(await run(admin, () => ACC.one.cadetId), 'cadet-5');
  noErrors(admin);
}));

test('quick find (Ctrl+K and "/"), Your day on Home, and calendar files for parades', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  const pid = await makeParade(admin, 30, 'Range firing');
  await run(admin, () => {
    const day = 86400000, now = Date.now();
    app.state.parades = [...app.state.parades,
      { id: 'past-1', kind: 'drill', title: 'Drill', reportAt: now - 2 * day, scope: 'All', reports: [], marks: { 'cadet-3': 'present' } },
      { id: 'past-2', kind: 'drill', title: 'Drill', reportAt: now - 3 * day, scope: 'All', reports: [], marks: { 'cadet-3': 'absent' } }];
    app.state.messDuty = [{ id: 'mess-x', date: ymd(new Date()), cadetIds: ['cadet-3'], at: now, by: 'x' }];
    app.saveStorage();
  });
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' });
  const c = await openAs(browser, db, 'user-c');

  // Your day: next parade with buttons, attendance, mess duty today
  await c.waitForSelector('#myDay:not(.hidden)');
  const day = await c.textContent('#myDay');
  assert.match(day, /Next parade[\s\S]*Range firing/);
  assert.match(day, /Your attendance[\s\S]*50%[\s\S]*1 of 2 parades[\s\S]*below 75%/);
  assert.match(day, /Mess duty[\s\S]*Today/);
  await c.click('#myDay button:has-text("I\'ll be late")');
  assert.equal(await c.isVisible('#selfReportModal'), true);
  await run(c, () => app.closeModal('selfReportModal'));
  // The administrator gets the week
  await refresh(admin);
  await run(admin, () => switchCadetFlowPage('home'));
  assert.match(await admin.textContent('#myDay'), /This week[\s\S]*attendance[\s\S]*2 parades in the last 7 days/);

  // Quick find
  await c.keyboard.press('Control+k');
  await c.waitForSelector('#quickFindModal:not(.hidden)');
  await c.keyboard.type('samahith');
  assert.match(await c.textContent('#qfList .qf-row'), /Cadet[\s\S]*CDT Samahith M Rao/);
  await c.keyboard.press('Enter');
  await c.waitForSelector('#profileModal:not(.hidden)');
  assert.match(await c.textContent('#profileHead'), /Samahith M Rao/);
  await run(c, () => app.closeModal('profileModal'));
  await c.waitForSelector('#profileModal', { state: 'hidden' });
  await run(c, () => switchCadetFlowPage('home'));
  await c.keyboard.press('/');
  await c.waitForSelector('#quickFindModal:not(.hidden)');
  await c.keyboard.type('range');
  await c.keyboard.press('Enter');
  await c.waitForFunction(id => PAR.openId === id, pid);
  assert.ok(await c.isVisible('#paradePage'));

  // Calendar file for one parade, and for all of mine
  await c.click('#paradeDetailView button:has-text("More")');
  const [dl] = await Promise.all([c.waitForEvent('download'), c.click('#paradeDetailView button:has-text("Add to calendar")')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(dl.suggestedFilename(), /^Range-firing-\d{4}-\d\d-\d\d\.ics$/);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*UID:[^\r]+@cadetflow[\s\S]*SUMMARY:Range firing[\s\S]*TRIGGER:-PT1H[\s\S]*END:VCALENDAR\r\n$/);
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines folded');
  await run(c, () => closeParadeDetail());
  const [dl2] = await Promise.all([c.waitForEvent('download'), c.click('#paradeListView button:has-text("Add to calendar")')]);
  assert.equal((fs.readFileSync(await dl2.path(), 'utf8').match(/BEGIN:VEVENT/g) || []).length, 1, 'only upcoming ones');
  noErrors(admin, c);
}));

test('attendance register for sergeants and POCs (Excel, or CSV without a connection), and certificate readiness', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => {
    app.updateCadetField('cadet-10', 'rank', 'SGT');
    const day = 86400000, now = Date.now();
    const marks = { 'cadet-11': 'present', 'cadet-12': 'absent', 'cadet-13': 'late' };
    app.state.parades = [...(app.state.parades || []),
      { id: 'r1', kind: 'drill', title: 'Drill', reportAt: now - 2 * day, scope: 'All', reports: [], marks },
      { id: 'r2', kind: 'drill', title: 'Drill', reportAt: now - 4 * day, scope: 'All', reports: [{ id: 'rep1', cadetId: 'cadet-12', kind: 'absent', reason: 'Exam', at: now }], marks: { 'cadet-11': 'present' } }];
    app.state.camps = [{ id: 'camp-1', kind: 'CATC', name: 'CATC 1', start: '2026-01-10', end: '2026-01-20', cadetIds: ['cadet-11'], at: now, by: 'x' }];
    app.saveStorage();
  });
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' });

  // A cadet has no register
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => switchCadetFlowPage('register'));
  assert.equal(await c.isVisible('#registerPage'), false);
  assert.equal(await c.isVisible('#paradeListView button:has-text("Register")'), false);

  const g = await openAs(browser, db, 'user-g');
  await g.route(/cdnjs\.cloudflare\.com/, r => r.abort());
  await run(g, () => switchCadetFlowPage('parades'));
  await g.click('#paradeListView button:has-text("Register")');
  await g.waitForSelector('#registerPage .reg-table');
  const row = name => g.textContent(`#registerPage tr:has-text("${name}")`);
  assert.match(await row('V Padma Nayana'), /P\s*P\s*2\/2\s*100%/);
  assert.match(await row('Prahast Mohanty'), /E\s*A\s*0\/1\s*0%/);
  await g.selectOption('#registerBody select >> nth=1', '2nd');
  assert.equal(await g.isVisible('#registerPage tr:has-text("Harsh Rajesh Koti")'), false, 'filtered by year');
  const [dl] = await Promise.all([g.waitForEvent('download'), g.click('#registerPage button:has-text("Download Excel")')]);
  assert.match(dl.suggestedFilename(), /^attendance-register-.*\.csv$/);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /Rank,Name,Company,Year,Regimental no\./);
  assert.match(csv, /CDT,V Padma Nayana,[^\n]*,P,P,2,2,100/);

  // Certificates: 2nd years for 'B' (75% and 1 camp)
  await run(g, () => switchCadetFlowPage('directory'));
  await g.waitForFunction(() => /Certificate readiness/.test(document.getElementById('certCard').textContent));
  assert.match(await g.textContent('#certCard li:has-text("V Padma Nayana")'), /100% · 1\/1 camp · on track/);
  assert.equal(await c.isVisible('#certCard'), false, 'cadets do not see the list');
  await run(admin, () => { switchCadetFlowPage('directory'); openCadetProfile('cadet-11'); });
  await refresh(admin);
  await run(admin, () => renderCadetProfile());
  assert.match(await admin.textContent('#profileBody'), /Certificates[\s\S]*'B' certificate: on track/);
  await setPrompt(admin, 'a');
  await admin.click('#profileBody button:has-text("Record \'B\' result")');
  await flush(admin);
  assert.equal(db.row.state.cadets.find(x => x.id === 'cadet-11').certs.B.grade, 'A');
  assert.match(await admin.textContent('#profileBody'), /'B' certificate: grade A/);
  noErrors(admin, c, g);
}));

test('the Tailwind stylesheet is built from the current page, and its link carries its version', async () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-css-')), 'out.css');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build_css.mjs'), '--out', tmp]);
  const built = fs.readFileSync(tmp, 'utf8'), committed = fs.readFileSync(path.join(__dirname, '..', 'cadetflow.css'), 'utf8');
  assert.ok(built === committed, 'cadetflow.css is out of date: run npm run build:css');
  const v = require('node:crypto').createHash('sha256').update(committed).digest('hex').slice(0, 10);
  const html = fs.readFileSync(PAGE_URL.slice(7), 'utf8');
  assert.ok(html.includes(`<link rel="stylesheet" href="cadetflow.css?v=${v}">`), 'the link names the current version');
  assert.ok(!html.includes('cdn.tailwindcss.com'), 'no Tailwind CDN');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /'\.\/cadetflow\.css'/);
});

test('requests on a parade: every status listed with filters, this parade first and longer leave apart; a cadet deletes their declined request (seniors keep it)', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  const pid = await makeParade(admin, 48, 'Range day');
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-4', { cadetId: 'cadet-4' }).account('user-6', { cadetId: 'cadet-6' })
    .account('user-7', { cadetId: 'cadet-7' }).account('user-g', { cadetId: 'cadet-10' });
  await db.api('user-c', 'report', { paradeId: pid, kind: 'late', reason: 'Lab runs late' });
  const { request: no } = await db.api('user-4', 'report', { paradeId: pid, kind: 'absent', reason: 'Not feeling like it' });
  await db.api('user-6', 'leave', { from: ymdIn(1), to: ymdIn(4), reason: 'Going home for a wedding' });
  const { request: yes } = await db.api('user-7', 'leave', { from: ymdIn(2), to: ymdIn(9), reason: 'Inter-college sports' });
  await db.api('user-a', 'decide', { id: no.id, approve: false, note: 'Come anyway' });
  await db.api('user-a', 'decide', { id: yes.id, approve: true });

  const g = await openAs(browser, db, 'user-g');
  await run(g, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  await g.click('#paradeRequestsBox');
  await g.waitForSelector('#paradeRequests #rqFilters');
  const card = await g.textContent('#paradeRequests');
  assert.match(card, /For this parade 2[\s\S]*Lab runs late[\s\S]*Not feeling like it[\s\S]*Longer leave covering this day 2/, 'waiting first, then the declined one, then leave apart');
  assert.match(card, /Going home for a wedding[\s\S]*Inter-college sports/);
  const chips = async () => (await g.locator('#rqFilters [aria-label="Status"] button').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(await chips(), ['All 4', 'Waiting 2', 'Approved 1', 'Not approved 1']);
  await g.click('#rqFilters button:has-text("Waiting")');
  assert.equal(await g.locator('#paradeRequests .rq-row').count(), 2);
  await g.click('#rqFilters button:has-text("Not approved")');
  assert.match(await g.textContent('#paradeRequests'), /Not feeling like it[\s\S]*Come anyway/);
  assert.doesNotMatch(await g.textContent('#paradeRequests'), /Lab runs late|Longer leave/);
  await g.click('#rqFilters [aria-label="Status"] button:has-text("All")');
  await g.click('#rqFilters button:has-text("Leave")');
  assert.equal(await g.locator('#paradeRequests .rq-row').count(), 2);
  assert.equal(await g.locator('#paradeRequests h4:has-text("For this parade")').count(), 0);
  await g.click('#rqFilters button:has-text("Every kind")');
  await g.fill('#rqSearch', await run(g, () => cadetById('cadet-6').name.split(' ')[0]));
  assert.equal(await g.locator('#paradeRequests .rq-row').count(), 1);
  assert.equal(await g.evaluate(() => document.activeElement.id), 'rqSearch', 'typing keeps the cursor');
  await g.click('#paradeRequests button:has-text("Clear filters")');
  assert.equal(await g.locator('#paradeRequests .rq-row').count(), 4);

  // The cadet whose request was declined deletes it; seniors still see it
  const four = await openAs(browser, db, 'user-4');
  await run(four, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  await four.waitForFunction(() => /was not approved/.test(document.getElementById('paradeDetailView').textContent));
  await four.click('#paradeDetailView button[onclick^="dismissRequest"]');
  await waitToast(four, 'Request deleted');
  assert.doesNotMatch(await four.textContent('#paradeDetailView'), /was not approved/);
  assert.ok(db.tables.cadetflow_requests.find(r => r.id === no.id).dismissed_at, 'kept, only cleared from their view');
  assert.equal((await db.api('user-4', 'requests')).requests.length, 0);
  assert.equal((await db.api('user-g', 'requests')).requests.filter(r => r.id === no.id).length, 1);
  await assert.rejects(db.api('user-c', 'dismiss', { id: db.tables.cadetflow_requests.find(r => r.cadet_id === 'cadet-3').id }), /still waiting/);
  await assert.rejects(db.api('user-c', 'dismiss', { id: no.id }), /no longer exists/);
  // Declined leave too, from the Leave area
  const { request: lv } = await db.api('user-4', 'leave', { from: ymdIn(10), to: ymdIn(11), reason: 'Trip' });
  await db.api('user-a', 'decide', { id: lv.id, approve: false });
  await run(four, () => { closeParadeDetail(); loadRequests(true); openLeaveList(); });
  await four.waitForFunction(() => /Not approved/.test(document.getElementById('leaveArea').textContent));
  await four.click('#leaveArea button[onclick^="dismissRequest"]');
  await waitToast(four, 'Request deleted');
  assert.match(await four.textContent('#leaveArea'), /No leave asked for/, 'nothing left');
  noErrors(admin, g, four);
}));

// ==================== 2026-11-11 ====================
const setParadeAt = (page, id, reportAt) => run(page, ({ id, reportAt }) => { findParade(id).reportAt = reportAt; app.saveStorage(); }, { id, reportAt });

test('leave asked for a parade day: a sergeant excuses one parade (leave still waiting), then approves it; cadets on leave get no late/absent buttons', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  const pid = await makeParade(admin, 48, 'Drill in leave');
  const far = await makeParade(admin, 24 * 8, 'Drill later');
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' });
  device(db, 'user-c');
  const { request } = await db.api('user-c', 'leave', { from: ymdIn(1), to: ymdIn(3), reason: 'Family function' });
  await assert.rejects(db.api('user-g', 'excuse', { id: request.id, paradeId: far }), /not in the days/);
  await assert.rejects(db.api('user-c', 'excuse', { id: request.id, paradeId: pid }), /sergeants/);

  // The sergeant sees the leave on the parade and excuses the cadet for this parade only
  const g = await openAs(browser, db, 'user-g');
  await run(g, () => switchCadetFlowPage('parades'));
  await g.waitForFunction(() => /1 request/.test(document.getElementById('paradeUpcoming').textContent));
  await run(g, id => { openParadeDetail(id); PAR.showAttend = true; renderParadePage(); }, pid);
  await g.click('#paradeRequestsBox');
  await g.waitForSelector('#paradeLeaveCard');
  assert.match(await g.textContent('#paradeLeaveCard'), /Samahith M Rao[\s\S]*Family function/);
  assert.match(await g.textContent('#paradeAttendanceList'), /Leave requested for this day/);
  await g.click('#paradeLeaveCard button:has-text("Excuse for this parade")');
  await waitToast(g, 'Their leave request is still waiting');
  const rep = db.row.state.parades.find(p => p.id === pid).reports.find(r => r.cadetId === 'cadet-3');
  assert.equal(rep.fromLeave, true); assert.equal(rep.kind, 'absent');
  assert.equal(db.tables.cadetflow_requests[0].status, 'pending', 'the leave itself still waits');
  assert.match(await g.textContent('#paradeLeaveCard'), /Excused for this parade/);
  assert.equal(await g.locator('#paradeLeaveCard button:has-text("Excuse for this parade")').count(), 0, 'nothing more to excuse on this parade');
  assert.match(db.pushes.at(-1).payload.title, /^Excused: Drill in leave/);
  assert.match(db.pushes.at(-1).payload.body, /still waiting/);

  // The cadet sees it, without late/absent buttons
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => { switchCadetFlowPage('parades'); openLeaveList(); });
  await c.waitForFunction(() => /Excused so far from: Drill in leave/.test(document.getElementById('leaveArea').textContent));
  await run(c, id => { app.closeModal('leaveListModal'); openParadeDetail(id); }, pid);
  assert.match(await c.textContent('#paradeDetailView'), /Excused from this parade[\s\S]*still waiting/);
  assert.equal(await c.isVisible('#paradeDetailView button:has-text("I\'ll be late")'), false);
  // The whole leave is approved: "You are on approved leave", no buttons in Your day either
  await db.api('user-g', 'decide', { id: request.id, approve: true });
  await refresh(c);
  await run(c, () => switchCadetFlowPage('home'));
  await c.waitForSelector('#myDay:not(.hidden)');
  assert.match(await c.textContent('#myDay'), /Next parade[\s\S]*approved leave/);
  assert.equal(await c.isVisible('#myDay button:has-text("I\'ll be late")'), false);
  await run(c, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.match(await c.textContent('#paradeDetailView'), /You are on approved leave/);
  noErrors(admin, g, c);
}));

test('kit list on parades (prefilled from the last of its type, in the reminder) and minutes that every cadet can read', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  const pid = await run(admin, () => {
    switchCadetFlowPage('parades'); openParadeModal(); setParadeKind('drill');
    const at = new Date(Date.now() + 26 * 3600000), pad = n => String(n).padStart(2, '0');
    document.getElementById('paradeDate').value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    document.getElementById('paradeTime').value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    setParadeTurnout('custom'); document.getElementById('paradeTurnoutCustom').value = 'PT dress';
    document.getElementById('paradeKit').value = 'Water bottle';
    saveParade();
    return PAR.openId;
  });
  assert.match(await admin.textContent('#paradeInfo'), /PT dress[\s\S]*Water bottle/);
  const pre = await run(admin, () => { openParadeModal(); setParadeKind('drill'); const v = [paradeTurnoutValue(), document.getElementById('paradeKit').value]; app.closeModal('paradeModal'); return v; });
  assert.deepEqual(pre, ['PT dress', 'Water bottle'], 'a new drill starts with the last drill\'s kit');
  // The reminder carries the dress and kit
  await setParadeAt(admin, pid, Date.now() + 90 * 60000);
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' });
  device(db, 'user-c');
  await db.api(null, 'remind');
  const rem = db.pushes.find(p => p.userId === 'user-c');
  assert.match(rem.payload.body, /Turnout: PT dress · Bring: Water bottle/);
  const c = await openAs(browser, db, 'user-c');
  await c.waitForSelector('#myDay:not(.hidden)');
  assert.match(await c.textContent('#myDay'), /Turnout: PT dress · Bring: Water bottle/);

  // Minutes: after the parade a sergeant writes them; the cadet reads them
  await setParadeAt(admin, pid, Date.now() - 4 * 3600000);
  await flush(admin);
  const g = await openAs(browser, db, 'user-g');
  await run(g, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  await g.click('#minutesCard button:has-text("Write minutes")');
  await g.fill('#minutesText', 'Covered squad drill.\nNext time: rifle drill.');
  await g.click('#minutesCard button:has-text("Save minutes")');
  await flush(g);
  assert.equal(db.row.state.parades.find(p => p.id === pid).minutes.text, 'Covered squad drill.\nNext time: rifle drill.');
  await refresh(c);
  await run(c, id => { switchCadetFlowPage('parades'); openParadeDetail(id); }, pid);
  assert.match(await c.textContent('#minutesShown'), /Covered squad drill/);
  assert.equal(await c.isVisible('#minutesCard button:has-text("Edit")'), false, 'cadets only read them');
  await run(c, () => closeParadeDetail());
  assert.match(await c.textContent('#paradePast'), /Minutes/);
  noErrors(admin, c, g);
}));

test('sign-ups: a JUO opens one from the notice form, eligible cadets apply, the first come are selected, the rest wait, the selected are told', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => app.updateCadetField('cadet-20', 'rank', 'JUO'));
  await flush(admin);
  db.account('user-j', { cadetId: 'cadet-20' }).account('user-c', { cadetId: 'cadet-3' }).account('user-4', { cadetId: 'cadet-4' }).account('user-x', { cadetId: 'cadet-21' });
  ['user-c', 'user-4', 'user-x'].forEach(u => device(db, u));
  const j = await openAs(browser, db, 'user-j');
  await j.click('#signupsCard button:has-text("New sign-up")');
  assert.equal(await j.isVisible('#noticeSignupFields'), true, 'the notice form opens on Sign-up');
  assert.equal(await j.isVisible('#noticeText'), false);
  await j.fill('#nsTitle', 'RDC selection');
  await j.fill('#nsPlace', 'Parade ground');
  const day = await j.evaluate(() => ymd(new Date(Date.now() + 5 * 86400000)));
  await j.fill('#nsDate', day);
  await j.fill('#nsTime', '09:30');
  await j.fill('#nsDetails', 'Bring your certificates.');
  await j.fill('#nsSeats', '1');
  await j.click('#nsYears button:has-text("1st")');
  await j.click('#noticePostBtn');
  await waitToast(j, 'Notification sent to');
  const id = db.row.state.signups[0].id;
  assert.equal(db.row.state.signups[0].place, 'Parade ground');
  assert.equal(db.row.state.signups[0].date, day);
  assert.equal(db.row.state.signups[0].time, '09:30');
  assert.deepEqual(db.row.state.signups[0].years, ['1st']);
  assert.equal(db.row.state.notices?.length || 0, 0, 'a sign-up is not also a plain notice');
  assert.match(db.pushes[0].payload.body, /Parade ground/);
  assert.match(await j.textContent('#signupsCard'), /When[\s\S]*09:30[\s\S]*Where Parade ground[\s\S]*Bring your certificates/);
  assert.deepEqual(db.pushes.map(p => p.userId).sort(), ['user-4', 'user-c'], 'only the 1st years');
  await assert.rejects(db.api('user-x', 'signup', { id }), /not open to you/);
  assert.deepEqual(await db.api('user-j', 'signupAnnounce', { id }), { alreadySent: true, sent: 0, devices: 0, people: 0 });

  const c = await openAs(browser, db, 'user-c');
  await c.click('#signupsCard button:has-text("Apply")');
  await waitToast(c, 'Applied');
  await db.api('user-4', 'signup', { id });
  assert.deepEqual(db.row.state.signups[0].applicants.map(a => a.cadetId), ['cadet-3', 'cadet-4']);
  await refresh(j);
  await j.click('#signupsCard button:has-text("Applicants (2)")');
  await j.click('#signupsCard button:has-text("Select the first 1")');
  await flush(j);
  assert.deepEqual(db.row.state.signups[0].applicants.map(a => a.status), ['selected', 'applied']);
  db.pushes.length = 0;
  await j.click('#signupsCard button:has-text("Notify the selected")');
  await waitToast(j, 'Sent to 1 cadet');
  assert.deepEqual(db.pushes.map(p => [p.userId, p.payload.title]), [['user-c', 'Selected: RDC selection']]);
  await refresh(c);
  assert.match(await c.textContent('#signupsCard'), /You were selected/);
  assert.match(await c.textContent('#myDay'), /Selected[\s\S]*RDC selection/);
  await assert.rejects(db.api('user-c', 'signup', { id, join: false }), /already selected/);
  const four = await openAs(browser, db, 'user-4');
  assert.match(await four.textContent('#signupsCard'), /waiting list, number 1/);
  // Closed: nobody can apply or withdraw any more
  await run(j, id => closeSignup(id, true), id);
  await flush(j);
  await assert.rejects(db.api('user-4', 'signup', { id, join: false }), /closed/);
  noErrors(admin, j, c, four);
}));

test('sign-ups from the notice form: a lance corporal opens one and runs it; another lance corporal cannot; Notice stays the default', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => { app.updateCadetField('cadet-20', 'rank', 'LCPL'); app.updateCadetField('cadet-21', 'rank', 'LCPL'); });
  await flush(admin);
  db.account('user-l', { cadetId: 'cadet-20' }).account('user-m', { cadetId: 'cadet-21' }).account('user-c', { cadetId: 'cadet-3' });
  const l = await openAs(browser, db, 'user-l');
  await l.click('#noticeNewBtn');
  assert.equal(await l.getAttribute('#noticeComposer [data-ntype="notice"]', 'aria-pressed'), 'true');
  assert.equal(await l.isVisible('#noticeSignupFields'), false);
  await l.click('#noticeComposer [data-ntype="signup"]');
  assert.equal(await l.textContent('#noticePostBtn'), 'Open sign-up');
  await l.uncheck('#noticeNotify');
  await l.click('#noticePostBtn');
  assert.equal((db.row.state.signups || []).length, 0, 'needs a title');
  await l.fill('#nsTitle', 'Tree plantation drive');
  await l.click('#noticePostBtn');
  await waitToast(l, 'Sign-up open');
  await flush(l);
  const x = db.row.state.signups[0];
  assert.equal(x.byCadet, 'cadet-20');
  assert.equal(x.seats, 0);
  assert.equal(await l.isVisible('#noticeComposer'), false);
  assert.match(await l.textContent('#signupsCard'), /Tree plantation drive[\s\S]*Opened by/);
  assert.equal(await l.isVisible('#signupsCard button:has-text("Applicants (0)")'), true, 'the one who opened it runs it');
  await db.api('user-c', 'signup', { id: x.id });
  await refresh(l);
  await l.click('#signupsCard button:has-text("Applicants (1)")');
  await l.click('#signupsCard button:has-text("Select")');
  await flush(l);
  assert.equal(db.row.state.signups[0].applicants[0].status, 'selected');
  const m = await openAs(browser, db, 'user-m');
  assert.match(await m.textContent('#signupsCard'), /Tree plantation drive/);
  assert.equal(await m.isVisible('#signupsCard button:has-text("Applicants")'), false, 'another lance corporal only reads it');
  assert.equal(await m.isVisible('#signupsCard button:has-text("New sign-up")'), true);
  // Plain notices work as before after switching back
  await m.click('#signupsCard button:has-text("New sign-up")');
  await m.click('#noticeComposer [data-ntype="notice"]');
  assert.equal(await m.isVisible('#noticeText'), true);
  await m.fill('#noticeText', 'Bring water.');
  await m.uncheck('#noticeNotify');
  await m.click('#noticePostBtn');
  await flush(m);
  assert.equal(db.row.state.notices[0].text, 'Bring water.');
  assert.equal(db.row.state.signups.length, 1);
  // The administrator runs any sign-up
  await refresh(admin);
  assert.equal(await admin.isVisible('#signupsCard button:has-text("Applicants (1)")'), true);
  noErrors(admin, l, m);
}));

test('mess duty swaps: put up for anyone (any eligible cadet takes it) or ask one cadet; agreeing swaps at once, no senior needed; rank holders and locals cannot take it', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  const pid = await makeParade(admin, 48, 'Drill');
  const pid2 = await makeParade(admin, 96, 'Drill two');
  await run(admin, ({ pid, pid2, date, date2 }) => {
    app.state.messConfig = { perDay: 2, years: ['1st', '2nd'], exempt: ['cadet-7'] };
    findParade(pid).refreshments = true; findParade(pid2).refreshments = true;
    app.state.messDuty = [{ id: 'mess-p', paradeId: pid, date, cadetIds: ['cadet-3', 'cadet-4'], at: Date.now(), by: 'x' },
      { id: 'mess-q', paradeId: pid2, date: date2, cadetIds: ['cadet-6', 'cadet-8'], at: Date.now(), by: 'x' }];
    app.saveStorage();
  }, { pid, pid2, date: ymdIn(2), date2: ymdIn(4) });
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-6', { cadetId: 'cadet-6' }).account('user-l', { cadetId: 'cadet-1' })
    .account('user-7', { cadetId: 'cadet-7' }).account('user-9', { cadetId: 'cadet-9' }).account('user-4', { cadetId: 'cadet-4' });
  device(db, 'user-c'); device(db, 'user-6'); device(db, 'user-4');

  // Put up for anyone
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => { switchCadetFlowPage('parades'); openMessDialog(); });
  await c.click('#messCard button:has-text("Swap")');
  const pool = await c.textContent('#swapBody');
  assert.ok(!pool.includes('Harsh Rajesh Koti') && pool.includes('CDT'), 'no rank holders offered');
  await c.click('#swapOpen');
  await waitToast(c, 'Put up');
  const open = db.row.state.messSwaps[0];
  assert.equal(open.status, 'open');
  await assert.rejects(db.api('user-c', 'swapAsk', { dayId: 'mess-p' }), /already asked/);
  await assert.rejects(db.api('user-l', 'swapTake', { id: open.id }), /cannot take this duty/, 'a lance corporal');
  await assert.rejects(db.api('user-7', 'swapTake', { id: open.id }), /cannot take this duty/, 'a local');
  await assert.rejects(db.api('user-4', 'swapTake', { id: open.id }), /already on that mess duty/);
  const nine = await openAs(browser, db, 'user-9');
  await run(nine, () => switchCadetFlowPage('home'));
  assert.match(await nine.textContent('#myDay'), /1 up for swap/);
  await run(nine, () => { switchCadetFlowPage('parades'); openMessDialog(); });
  await nine.click('#messSwaps button:has-text("I\'ll take it")');
  await waitToast(nine, 'the duty is yours');
  assert.deepEqual(db.row.state.messDuty.find(d => d.id === 'mess-p').cadetIds, ['cadet-9', 'cadet-4']);
  assert.equal(db.row.state.messSwaps[0].status, 'done');
  assert.deepEqual([db.pushes.at(-1).userId, db.pushes.at(-1).payload.title], ['user-c', 'Mess duty taken']);
  await assert.rejects(db.api('user-6', 'swapTake', { id: open.id }), /already took it/);

  // Ask one cadet, with a duty in return: agreeing swaps both at once
  await assert.rejects(db.api('user-4', 'swapAsk', { dayId: 'mess-p', to: 'cadet-1' }), /only for cadets/);
  await assert.rejects(db.api('user-4', 'swapAsk', { dayId: 'mess-p', to: 'cadet-7' }), /only for cadets/);
  await assert.rejects(db.api('user-4', 'swapAsk', { dayId: 'mess-p', to: 'cadet-9' }), /already on that mess duty/);
  await db.api('user-4', 'swapAsk', { dayId: 'mess-p', to: 'cadet-6', takeDayId: 'mess-q' });
  assert.deepEqual([db.pushes.at(-1).userId, db.pushes.at(-1).payload.title], ['user-6', 'Mess duty swap']);
  const six = await openAs(browser, db, 'user-6');
  await run(six, () => { switchCadetFlowPage('parades'); openMessDialog(); });
  await six.click('#messSwaps button:has-text("Agree")');
  await waitToast(six, 'the duty is yours');
  assert.deepEqual(db.row.state.messDuty.find(d => d.id === 'mess-p').cadetIds, ['cadet-9', 'cadet-6']);
  assert.deepEqual(db.row.state.messDuty.find(d => d.id === 'mess-q').cadetIds, ['cadet-4', 'cadet-8']);
  assert.equal(db.row.state.messSwaps.find(x => x.to === 'cadet-6').status, 'done');
  assert.deepEqual([db.pushes.at(-1).userId, db.pushes.at(-1).payload.title], ['user-4', 'Mess duty swap done']);
  noErrors(admin, c, six, nine);
}));

test('below 75%: Your day and the profile say how many parades to attend, the cadet is told once; equipment register and overdue notice', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => {
    const day = 86400000, now = Date.now();
    app.updateCadetField('cadet-5', 'rank', 'CQMS');
    app.state.parades = [...app.state.parades,
      { id: 'p1', kind: 'drill', title: 'Drill', reportAt: now - 10 * day, scope: 'All', reports: [], marks: { 'cadet-3': 'present' } },
      { id: 'p2', kind: 'drill', title: 'Drill', reportAt: now - 5 * day, scope: 'All', reports: [], marks: { 'cadet-3': 'present' } },
      { id: 'p3', kind: 'drill', title: 'Drill', reportAt: now - day, scope: 'All', reports: [], marks: { 'cadet-3': 'absent' } }];
    app.saveStorage();
  });
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-q', { cadetId: 'cadet-5' });
  device(db, 'user-c');
  let r = await db.api(null, 'remind');
  assert.equal(r.drops, 1);
  const low = db.pushes.find(p => p.userId === 'user-c' && p.payload.tag === 'attendance');
  assert.equal(low.payload.title, 'Attendance 67%');
  assert.match(low.payload.body, /Attend the next 1 parade to get back to 75%/);
  assert.equal((await db.api(null, 'remind')).drops, 0, 'once');
  const c = await openAs(browser, db, 'user-c');
  await c.waitForSelector('#myDay:not(.hidden)');
  assert.match(await c.textContent('#myDay'), /67%[\s\S]*attend the next 1 parade to reach 75%/);
  await run(c, () => openCadetProfile('cadet-3'));
  assert.match(await c.textContent('#profile75'), /attend the next 1 parade/);
  await run(c, () => app.closeModal('profileModal'));

  // The CQMS issues a rifle due yesterday; the cadet is told once and sees it
  const q = await openAs(browser, db, 'user-q');
  await run(q, () => switchCadetFlowPage('uniform'));
  await q.click('#equipCard button:has-text("Issue equipment")');
  await q.fill('#eqSearch', 'Samahith');
  await q.click('#eqPick button');
  await q.fill('#eqItem', 'Rifle (drill purpose)');
  await q.fill('#eqDue', ymdIn(-1));
  await q.click('#equipBody button:has-text("Issue")');
  await flush(q);
  assert.equal(db.row.state.equipment[0].cadetId, 'cadet-3');
  r = await db.api(null, 'remind');
  assert.equal(r.overdue, 1);
  assert.equal(db.pushes.at(-1).payload.title, 'Return equipment');
  assert.equal((await db.api(null, 'remind')).overdue, 0, 'once');
  await refresh(c);
  assert.match(await c.textContent('#myDay'), /Equipment[\s\S]*1 to return/);
  await run(c, () => switchCadetFlowPage('uniform'));
  assert.match(await c.textContent('#equipCard'), /Equipment with you[\s\S]*Rifle/);
  await q.click('#equipCard button:has-text("Returned")');
  await flush(q);
  assert.ok(db.row.state.equipment[0].returnedAt);
  noErrors(admin, c, q);
}));

test('Learn: sergeants keep the question bank, cadets practise and their scores are kept; the study library holds links that seniors approve', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => app.updateCadetField('cadet-10', 'rank', 'SGT'));
  await flush(admin);
  db.account('user-c', { cadetId: 'cadet-3' }).account('user-g', { cadetId: 'cadet-10' }).account('user-l', { cadetId: 'cadet-1' });
  await assert.rejects(db.api('user-c', 'quizSave', { question: { cert: 'B', subject: 'Drill', question: 'Hello?', options: ['a', 'b'], answer: 0 } }), /sergeants/);
  const res = await db.api('user-g', 'quizImport', { rows: [
    { cert: 'B', subject: 'Map reading', question: 'How many degrees in a circle?', options: ['180', '360', '400'], answer: 'B' },
    { cert: 'both', subject: 'Drill', question: 'Word of command for halt?', options: ['Ruk', 'Thum'], answer: 'B', explain: 'Thum means halt.' },
    { cert: 'B', subject: 'Drill', question: 'Broken', options: ['only one'], answer: 'A' },
  ] });
  assert.deepEqual([res.added, res.skippedCount], [2, 1]);
  await db.api('user-g', 'quizSave', { question: { cert: 'C', subject: 'Weapons', question: 'Calibre of the INSAS?', options: ['5.56 mm', '7.62 mm'], answer: 0 } });
  assert.equal(db.tables.cadetflow_quiz.length, 3);

  const c = await openAs(browser, db, 'user-c');
  await run(c, () => { switchCadetFlowPage('learn'); setLearnView('quiz'); });
  await c.waitForSelector('#learnQuiz button:has-text("Start")');
  assert.match(await c.textContent('#learnQuiz'), /2 questions to pick from/, "two for 'B' (one is for both)");
  assert.equal(await c.isVisible('#quizManage'), false);
  await c.click('#learnQuiz button:has-text("Start")');
  for (let i = 0; i < 2; i++) {
    await run(c, () => pickQuizAnswer(LEARN.round.qs[LEARN.round.i].answer));
    await run(c, () => nextQuizQuestion());
  }
  await c.waitForSelector('#quizDone');
  assert.match(await c.textContent('#quizDone'), /2\/2/);
  for (let i = 0; i < 50 && !db.tables.cadetflow_quiz_scores.length; i++) await c.waitForTimeout(50);
  assert.deepEqual([db.tables.cadetflow_quiz_scores[0].score, db.tables.cadetflow_quiz_scores[0].total, db.tables.cadetflow_quiz_scores[0].cadet_id], [2, 2, 'cadet-3']);
  const s = await db.api('user-g', 'quizScores');
  assert.equal(s.everyone[0].cadetId, 'cadet-3');
  assert.equal((await db.api('user-c', 'quizScores')).everyone, undefined, 'cadets see only their own');

  // Library: a cadet suggests a link, a lance corporal adds it
  await assert.rejects(db.api('user-c', 'suggestLink', { title: 'Notes', url: 'http://example.com/x' }), /https/);
  await db.api('user-c', 'suggestLink', { title: 'Map reading notes', url: 'https://drive.google.com/file/d/abc/view', subject: 'Map reading', cert: 'B' });
  assert.equal(db.row.state.library[0].status, 'suggested');
  const l = await openAs(browser, db, 'user-l');
  await run(l, () => { switchCadetFlowPage('learn'); setLearnView('library'); });
  await l.click('#libSuggested button:has-text("Add")');
  await flush(l);
  assert.equal(db.row.state.library[0].status, 'approved');
  await refresh(c);
  await run(c, () => setLearnView('library'));
  assert.equal(await c.getAttribute('#learnLibrary a[href^="https://drive.google.com"]', 'rel'), 'noopener noreferrer');
  noErrors(admin, c, l);
}));

test('suggestion box: anonymous ones keep no name or account, the administrator replies to named ones', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  db.account('user-c', { cadetId: 'cadet-3' });
  device(db, 'user-c');
  const c = await openAs(browser, db, 'user-c');
  await run(c, () => openSuggestBox());
  await c.fill('#sgText', 'Please start parades on time.');
  await c.check('#sgAnon');
  await c.click('#sgSend');
  await waitToast(c, 'without your name');
  const anon = db.tables.cadetflow_suggestions[0];
  assert.deepEqual([anon.user_id, anon.name, anon.cadet_id], [null, null, null]);
  await db.api('user-c', 'suggest', { text: 'Add a water cooler at the ground.' });
  await assert.rejects(db.api('user-c', 'suggestions'), /administrator/);
  await run(admin, () => openSuggestions());
  await admin.waitForFunction(() => /Sent without a name/.test(document.getElementById('suggestionsBody').textContent));
  assert.match(await admin.textContent('#suggestionsBody'), /CDT Samahith M Rao/);
  const named = db.tables.cadetflow_suggestions.find(x => x.user_id === 'user-c');
  await assert.rejects(db.api('user-a', 'suggestionUpdate', { id: anon.id, reply: 'Thanks' }), /without a name/);
  await db.api('user-a', 'suggestionUpdate', { id: named.id, reply: 'Ordered one.', status: 'done' });
  assert.deepEqual([db.pushes.at(-1).userId, db.pushes.at(-1).payload.title], ['user-c', 'Reply to your suggestion']);
  const mine = await db.api('user-c', 'mySuggestions');
  assert.deepEqual(mine.suggestions.map(x => [x.text, x.reply]), [['Add a water cooler at the ground.', 'Ordered one.']], 'the anonymous one is not theirs any more');
  noErrors(admin, c);
}));

test('trends chart and slipping cadets, rank history with order number, and the printable record', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await setYears(admin);
  await run(admin, () => {
    const day = 86400000, now = Date.now(), marks = ok => Object.fromEntries(['cadet-3', 'cadet-4', 'cadet-13', 'cadet-26'].map(id => [id, id === 'cadet-4' ? 'absent' : ok]));
    app.state.parades = [...app.state.parades, ...[20, 13, 6, 2].map((d, i) => ({ id: 'tp' + i, kind: 'drill', title: 'Drill', reportAt: now - d * day, scope: 'All', reports: [], marks: marks(i === 3 ? 'late' : 'present') }))];
    app.updateCadetField('cadet-3', 'rank', 'LCPL');
    app.saveStorage();
  });
  await flush(admin);
  assert.deepEqual(db.row.state.cadets.find(c => c.id === 'cadet-3').rankHistory.map(x => [x.from, x.to]), [['CDT', 'LCPL']]);
  await run(admin, () => { switchCadetFlowPage('register'); setRegisterView('trends'); });
  await admin.waitForSelector('#trendCard svg');
  assert.ok(await admin.$('#trendCard path[stroke="#3987e5"]'), 'Jessami line in its colour');
  assert.match(await admin.textContent('#trendCard'), /Jessami[\s\S]*Kohima[\s\S]*Naushera/);
  await admin.click('#trendCard button:has-text("Show table")');
  assert.ok(await admin.$('#trendCard table'));
  assert.match(await admin.textContent('#slipCard'), /Kaif|missed the last 3/);
  assert.match(await admin.textContent('#slipCard'), /missed the last 3/);

  await run(admin, () => openCadetProfile('cadet-3'));
  assert.match(await admin.textContent('#rankHistory'), /Promoted CDT → LCPL/);
  admin.on('dialog', () => {}); // native dialogs answer the two questions
  await admin.evaluate(() => { let n = 0; window.prompt = () => (n++ === 0 ? 'NCC/12/2026' : '2026-11-01'); });
  await admin.click('#rankHistory button:has-text("Add order no.")');
  await admin.waitForFunction(() => /order NCC\/12\/2026/.test(document.getElementById('rankHistory').textContent));
  await run(admin, () => { window.print = () => {}; printRecord('cadet-3'); });
  await admin.waitForFunction(() => /NCC record: LCPL Samahith M Rao/.test(document.getElementById('recordPrint').textContent));
  assert.match(await admin.textContent('#recordPrint'), /Attendance[\s\S]*100%[\s\S]*Rank history[\s\S]*NCC\/12\/2026/);

  // A cadet can print their own record only
  db.account('user-4', { cadetId: 'cadet-4' });
  const four = await openAs(browser, db, 'user-4');
  assert.deepEqual(await run(four, () => [canPrintRecord(cadetById('cadet-4')), canPrintRecord(cadetById('cadet-3'))]), [true, false]);
  noErrors(admin, four);
}));
