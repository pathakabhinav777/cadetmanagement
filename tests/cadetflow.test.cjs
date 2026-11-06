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
// Tailwind/Google Fonts are not needed for behaviour tests; only `.hidden` matters.
const TAILWIND_STANDIN = "document.head.insertAdjacentHTML('beforeend','<style>.hidden{display:none!important}</style>')";

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Fake Supabase database shared by all pages in one test. */
function makeDb() {
  let tick = 0;
  const db = {
    row: { id: 1, state: null, updated_at: null },
    roles: { 'user-a': 'admin', 'user-b': 'admin', 'user-s': 'editor', 'user-t': 'senior' },
    pages: [],
    writes: 0,
    autoNotify: true,
    handle(userId, q) {
      if (q.table === 'cadetflow_profiles') return { data: userId ? { role: db.roles[userId] ?? null } : null, error: null };
      if (q.table !== 'cadetflow_state') return { data: null, error: { message: 'unknown table' } };
      if (q.op === 'select') return { data: db.row.state ? clone({ state: db.row.state, updated_at: db.row.updated_at }) : null, error: null };
      // UPDATE, filtered like PostgREST. Row-level security: only editors can update.
      if (!db.roles[userId]) return { data: null, error: null };
      const matches = q.filters.every(([op, col, val]) => (op === 'eq' ? String(db.row[col]) === String(val) : db.row[col] == null));
      if (!matches) return { data: null, error: null };
      // Server-side timestamp in Postgres format (like a `now()` trigger) — differs from what the client sent.
      const stamp = new Date(Date.now() + ++tick).toISOString().replace('Z', '000+00:00');
      db.row = { ...db.row, ...clone(q.values), updated_at: stamp };
      db.writes++;
      if (db.autoNotify) db.pages.forEach(p => p.evaluate(() => window.__realtime && window.__realtime()).catch(() => {}));
      return { data: { id: 1, updated_at: stamp }, error: null };
    }
  };
  return db;
}

async function openAs(browser, db, userId) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript(u => { window.__testUser = u; }, userId ? { id: userId, email: `${userId}@example.com` } : null);
  await page.exposeFunction('__db', q => db.handle(userId, q));
  await page.route('**/supabase-js@2', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await page.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ contentType: 'application/javascript', body: TAILWIND_STANDIN }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '' }));
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => typeof app !== 'undefined' && app && app.remoteReady === true);
  db.pages.push(page);
  return page;
}

const run = (page, fn, arg) => page.evaluate(fn, arg);
const flush = page => run(page, () => app.flushRemoteSave());
const refresh = page => run(page, () => app.refreshFromRemote());
const setPrompt = (page, answer) => run(page, a => { window.prompt = () => a; }, answer);
const createTask = (page, title, extra = {}) => run(page, ({ title, extra }) => {
  app.openNewEventModal();
  document.getElementById('newEventTitleInput').value = title;
  if (extra.deadline) {
    document.getElementById('newEventHasDeadline').checked = true;
    document.getElementById('newEventDeadlineInput').value = extra.deadline;
  }
  app.handleCreateEvent({ preventDefault() {} });
  return app.state.activeEventId;
}, { title, extra });
/** Create a special event through the real editor UI state. teams: [{ name, cadets: [ids] }] → team-test-1, team-test-2, … */
const createSpecial = (page, title, teams) => run(page, ({ title, teams }) => {
  app.openSpecialEventModal(title);
  const d = app.specialDraft;
  d.teams = teams.map((t, i) => ({ id: `team-test-${i + 1}`, name: t.name }));
  teams.forEach((t, i) => t.cadets.forEach(c => { d.assignments[c] = `team-test-${i + 1}`; }));
  app.saveSpecialEvent();
  return app.state.activeEventId;
}, { title, teams });
/** Add a task to a special event through the task dialog; returns the new task's id. */
const addTask = (page, eventId, title, teamIds, extra = {}) => run(page, ({ eventId, title, teamIds, extra }) => {
  app.openSpecialTaskModal(eventId);
  document.getElementById('specialTaskTitle').value = title;
  document.getElementById('specialTaskDetails').value = extra.details || '';
  document.querySelectorAll('#specialTaskTeams input').forEach(b => { b.checked = teamIds.includes(b.value); });
  app.saveSpecialTask();
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
  await run(a, id => {
    app.openSpecialEventModal(null, id);
    const d = app.specialDraft;
    d.assignments['cadet-7'] = 'team-test-2';
    d.assignments['cadet-9'] = 'team-test-2';
    delete d.assignments['cadet-8'];
    app.saveSpecialEvent();
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
  await run(a, id => { app.openSpecialEventModal(null, id); app.removeSpecialTeam('team-test-1'); app.saveSpecialEvent(); }, id);
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
  await run(a, id => { app.switchEvent(id); app.toggleArchiveCurrentEvent(); showTaskMasterSection('archive'); document.getElementById('archiveYearFilter').value = '3rd'; renderTaskArchive(); }, task);
  const arch = await a.textContent('#taskArchiveList');
  assert.match(arch, /Abhinav Pathak/); assert.ok(!arch.includes('Harsh Rajesh Koti'));

  // CSV + batch paste
  const csv = await run(a, id => { let out; const o = URL.createObjectURL; URL.createObjectURL = b => { out = b; return 'blob:x'; }; HTMLAnchorElement.prototype.click = () => {}; app.switchEvent(id); app.exportEventCSV(); URL.createObjectURL = o; return out.text(); }, sp);
  assert.match(csv.split('\n')[0], /"Wing","Year","Company","Team"/);
  assert.match(csv, /"Abhinav Pathak","SD","3rd","Naushera"/);
  await run(a, () => { app.openRosterModal(); document.getElementById('batchPasteArea').value = 'CDT, Test One, SD, Kohima, 2\nLCPL, Test Two, SW, Jessami, 3rd\nCDT, Test Three, SD, Naushera'; app.applyBatchPaste(); });
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

test('visitors can view but not change anything', () => withBrowser(async browser => {
  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  await flush(a);
  const v = await openAs(browser, db, null);
  const writes = db.writes;
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
  const id = await run(a, () => { app.handleCreateEvent({ preventDefault() {} }); return app.state.activeEventId; });
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

  const v = await openAs(browser, db, null); // signed-out visitor
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

  // Visitors see counts and leaderboard but no editing controls.
  const v = await openAs(browser, db, null);
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
  assert.equal(await a.locator('#modalRosterTableBody button[aria-pressed="false"]').count(), 37);

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
  await row.locator('button[aria-pressed]').click();          // cycle → yes
  assert.equal(await row.locator('button[aria-pressed]').textContent(), 'Yes');
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

test('uniform orders: next order totals, beret sizes, who needs it, place and receive; anyone can view', () => withBrowser(async browser => {
  const db = makeDb();
  db.roles['user-c'] = null; // signed in, not an editor
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

  // Receive items in order 1, one at a time and then the rest
  const order1 = [...ids][0];
  await run(a, id => selectUniformOrder(id), order1);
  const one = db.row.state.uniform.find(r => r.item === 'hackle' && r.cadetId === 'cadet-1').id;
  await run(a, id => setUniformReceived(id, true), one);
  assert.match(await a.textContent('#uniOrderHead'), /1 of 6 received/);
  assert.equal(await a.isVisible('#uniOrderActions button:has-text("Undo placing")'), false, 'cannot undo once something arrived');
  await run(a, () => markUniformOrderReceived());
  await flush(a);
  assert.equal(db.row.state.uniform.filter(r => r.orderId === order1 && r.status === 'received').length, 6);
  assert.match(await a.textContent('#uniOrderSelect'), /Order 1 · .* · received/);

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

  // Anyone can see the orders and who needs what; only verified seniors can change them
  const v = await openAs(browser, db, null);
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

  // Visitors see updates but can't post
  const v = await openAs(browser, db, null);
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

  // Visitors can't open the editor
  const v = await openAs(browser, db, null);
  await run(v, () => switchCadetFlowPage('availability'));
  assert.equal(await v.locator('button:has-text("Edit timetables")').isVisible(), false);
  await run(v, () => openTimetableEditor('cadet-30'));
  assert.equal(await v.isVisible('#timetableModal'), false);
  noErrors(a, v);
}));

test('three kinds of people: administrator, senior, viewer', () => withBrowser(async browser => {
  const db = makeDb();
  db.roles['user-v'] = 'viewer';
  const admin = await openAs(browser, db, 'user-a');
  await flush(admin);
  const senior = await openAs(browser, db, 'user-s');
  const senior2 = await openAs(browser, db, 'user-t');
  const viewer = await openAs(browser, db, 'user-v');
  const level = p => run(p, () => [app.accessLevel(), app.canEdit(), app.isAdmin(), document.body.classList.contains('can-edit'), document.body.classList.contains('is-admin')]);
  assert.deepEqual(await level(admin), ['admin', true, true, true, true]);
  assert.deepEqual(await level(senior), ['senior', true, false, true, false]);
  assert.deepEqual(await level(senior2), ['senior', true, false, true, false], "role 'senior' works as well as 'editor'");
  assert.deepEqual(await level(viewer), ['viewer', false, false, false, false]);
  assert.match(await senior.textContent('#accountRole'), /Senior/);
  assert.match(await admin.textContent('#accountRole'), /Administrator/);

  // Seniors: tasks, call-outs, uniform requests
  const task = await createTask(senior, 'Senior task');
  await run(senior, () => { window.prompt = () => 'Gate'; app.recordCallOut(['cadet-2']); toggleUniformCadet('cadet-3', true); toggleUniformItem('belt'); createUniformRequests(); });
  await flush(senior);
  assert.ok(db.row.state.events.some(e => e.id === task));
  assert.equal(db.row.state.duties.length, 1);
  assert.equal(db.row.state.uniform.length, 1);
  // ...but not the roster, timetables, data restore or deleting tasks
  const before = JSON.stringify(db.row.state.cadets);
  await run(senior, id => {
    app.openRosterModal(); app.updateCadetField('cadet-1', 'name', 'Changed'); app.removeCadet('cadet-2');
    openTimetableEditor('cadet-3'); toggleTimetableSlot('MON1');
    app.handleDeleteCurrentEventDirectly(id);
  }, task);
  await flush(senior);
  assert.equal(JSON.stringify(db.row.state.cadets), before, 'roster unchanged by a senior');
  assert.ok(db.row.state.events.some(e => e.id === task), 'task not deleted by a senior');
  assert.equal(await senior.isVisible('#rosterModal'), false);
  assert.equal(await senior.isVisible('#timetableModal'), false);
  await run(senior, id => { switchCadetFlowPage('roster'); app.switchEvent(id); showTaskMasterSection('workspace'); }, task);
  assert.equal(await senior.locator('button[onclick*="handleDeleteCurrentEventDirectly"]').first().isVisible(), false);
  assert.equal(await senior.locator('button[onclick*="openEditCurrentEventModal"]').first().isVisible(), true);
  await run(senior, () => switchCadetFlowPage('availability'));
  assert.equal(await senior.locator('button:has-text("Edit timetables")').isVisible(), false);

  // Administrators can do all of it
  await refresh(admin);
  await run(admin, () => { app.updateCadetField('cadet-1', 'name', 'Harsh R Koti'); switchCadetFlowPage('availability'); });
  await flush(admin);
  assert.equal(db.row.state.cadets.find(c => c.id === 'cadet-1').name, 'Harsh R Koti');
  assert.equal(await admin.locator('button:has-text("Edit timetables")').isVisible(), true);

  // Viewers change nothing
  const writes = db.writes;
  await run(viewer, () => { window.prompt = () => 'x'; app.recordCallOut(['cadet-2']); app.openNewEventModal(); });
  await run(viewer, () => app.flushRemoteSave());
  assert.equal(db.writes, writes);
  noErrors(admin, senior, senior2, viewer);
}));

test('parades: create, late/absence reports with cutoff, company-wise attendance', () => withBrowser(async browser => {
  const db = makeDb();
  const admin = await openAs(browser, db, 'user-a');
  await run(admin, () => { app.updateCadetField('cadet-10', 'rank', 'SGT'); app.updateCadetField('cadet-20', 'rank', 'JUO'); });
  await flush(admin);
  const senior = await openAs(browser, db, 'user-s');
  // Senior creates a parade for the whole battalion, 2 hours from now
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
    saveParade();
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
  const v = await openAs(browser, db, null);
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
  const v = await openAs(browser, db, null);
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
  // The Android app config points at the live site
  const cap = JSON.parse(fs.readFileSync(path.join(root, 'android-app', 'capacitor.config.json'), 'utf8'));
  assert.match(cap.server.url, /^https:\/\/pathakabhinav777\.github\.io\/cadetmanagement\/$/);

  const db = makeDb();
  const a = await openAs(browser, db, 'user-a');
  assert.equal(await a.getAttribute('link[rel="manifest"]', 'href'), 'manifest.webmanifest');
  // In a normal browser the block shows the APK link; no install button until the browser offers one
  assert.equal(await a.isVisible('#getApp'), true);
  assert.equal(await a.isVisible('#apkLink'), true);
  assert.equal(await a.isVisible('#installAppBtn'), false);
  assert.match(await a.getAttribute('#apkLink', 'href'), /releases\/latest\/download\/CadetFlow\.apk$/);
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

  // Inside the Android app (user agent marker) the block is hidden
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile CadetFlowApp', viewport: { width: 390, height: 800 } });
  const p = await ctx.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
  await p.addInitScript(() => { window.__testUser = null; });
  await p.exposeFunction('__db', q => db.handle(null, q));
  await p.route('**/supabase-js@2', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await p.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ contentType: 'application/javascript', body: TAILWIND_STANDIN }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '' }));
  await p.goto(PAGE_URL);
  await p.waitForFunction(() => typeof app !== 'undefined' && app && app.remoteReady === true);
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

  // Two seniors changing different prices at the same time keep both
  const b = await openAs(browser, db, 'user-s');
  db.autoNotify = false;
  await run(b, () => switchCadetFlowPage('uniform'));
  await setPrice(a, 'socks', '25'); await save(a);
  await setPrice(b, 'belt', '90'); await save(b);
  await flush(a); await flush(b);
  assert.equal(db.row.state.uniformPrices.find(p => p.id === 'socks').price, 25);
  assert.equal(db.row.state.uniformPrices.find(p => p.id === 'belt').price, 90);

  // Visitors see the prices and the bill but cannot change them
  const v = await openAs(browser, db, null);
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
    saveParade();
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
  await run(a, id => { openParadeModal(id); setParadeKind('drill'); saveParade(); }, shoot);
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
    saveParade(); return app.state.parades[0].id;
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
