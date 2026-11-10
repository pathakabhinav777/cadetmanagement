// Plain rules used by the cadetflow-api function and by the automated tests (no imports, no I/O).

export const YEARS = ['1st', '2nd', '3rd'];
export const CUTOFF_MIN = 30;               // cadets can send a late/absence request until 30 minutes before reporting
export const PAST_AFTER_MS = 3 * 3600000;   // a parade moves to "Past parades" 3 hours after reporting time

// ---- Who can do what -------------------------------------------------------------------------
// Powers come from the cadet's rank on the roster; the administrator can do everything.
export const RANKS = ['CDT', 'LCPL', 'CPL', 'SGT', 'CQMS', 'CSM', 'JUO', 'SUO'];
const atLeast = (rank, min) => RANKS.indexOf(rank) >= RANKS.indexOf(min);
export const PERMISSIONS = {
  write: r => atLeast(r, 'LCPL'),          // save the shared data at all
  task: r => atLeast(r, 'LCPL'),           // create and mark tasks, special events, updates
  callout: r => atLeast(r, 'LCPL'),        // +1 work call-outs on Availability
  parade: r => r === 'JUO' || r === 'SUO', // create and edit parades, send parade notifications
  requests: r => atLeast(r, 'SGT'),        // see and approve late/absence requests, reports
  attendance: r => atLeast(r, 'SGT'),      // mark parade attendance
  uniform: r => r === 'CQMS',              // place orders, mark arrived, approve payments, prices
  admin: () => false,                      // roster, timetables, accounts, deleting, restoring
};
// A POC (point of contact) account can also mark attendance and create tasks, whatever their rank.
export const POC_POWERS = ['write', 'task', 'attendance'];
/** who: { admin: boolean, poc?: boolean, rank: 'CDT'… | null } of an approved account. */
export function can(who, perm) {
  if (!who) return false;
  if (who.admin) return true;
  if (who.poc && POC_POWERS.includes(perm)) return true;
  const rank = RANKS.includes(who.rank) ? who.rank : null;
  return !!rank && !!PERMISSIONS[perm]?.(rank);
}

// Requests (late/absence, leave, mess duty let-off): a sergeant sees and decides only those of cadets in their own
// company; the CQMS, CSM, JUOs, SUOs and the administrator see all. A sergeant with no company set sees all.
export const ALL_REQUEST_RANKS = ['CQMS', 'CSM', 'JUO', 'SUO'];
/** who: { admin, poc?, rank, cadet } of the senior; cadet: the roster entry the request is about. */
export function requestsFor(who, cadet) {
  if (!can(who, 'requests')) return false;
  if (who.admin || ALL_REQUEST_RANKS.includes(who.rank)) return true;
  const mine = String(who.cadet?.company || '');
  if (!mine || mine === 'No company') return true;
  return !!cadet && String(cadet.company || '') === mine;
}
export const SCOPE_DENIED = "Only a sergeant of that cadet's company, or the CSM, CQMS, JUOs and SUOs, can do this.";

// Notifications each person can switch off (account menu, Notification choices). Everything else always goes.
export const NOTIFY_KINDS = ['parades', 'reminders', 'notices', 'signups', 'messCalls', 'weekly'];

/** Years a parade is limited to; [] = every year (same as the site's normalizeYears). */
export function paradeYears(pd) {
  const list = YEARS.filter(y => Array.isArray(pd?.years) && pd.years.includes(y));
  return list.length === YEARS.length ? [] : list;
}

/** Is this cadet expected at the parade? Same rule as the site's cadetInEvent for a parade. */
export function inParade(cadet, pd) {
  if (!cadet || !pd) return false;
  if (Array.isArray(pd.cadetIds) && pd.cadetIds.length) return pd.cadetIds.map(String).includes(String(cadet.id));
  if (pd.scope && pd.scope !== 'All' && cadet.company !== pd.scope) return false;
  const years = paradeYears(pd);
  return !years.length || years.includes(cadet.year);
}

/** Who the parade is for, in words, for the notification. */
export function audienceText(pd) {
  if (Array.isArray(pd.cadetIds) && pd.cadetIds.length) return `${pd.cadetIds.length} picked cadet${pd.cadetIds.length === 1 ? '' : 's'}`;
  const scope = !pd.scope || pd.scope === 'All' ? 'All companies' : String(pd.scope);
  const years = paradeYears(pd);
  return scope + (years.length ? ` (${years.join(' & ')} year)` : '');
}

/**
 * Accounts to notify about a parade: approved accounts whose cadet is expected at it.
 * Accounts not linked to any cadet (staff) get every parade.
 * profiles: [{ user_id, cadet_id, status }]; leaves (optional): cadets on approved leave that day are left out.
 */
export function paradeRecipients(profiles, cadets, pd, leaves = null) {
  const byId = new Map((cadets || []).filter(c => c && c.id != null).map(c => [String(c.id), c]));
  return (profiles || [])
    .filter(p => p && p.status === 'approved')
    .filter(p => !p.cadet_id || inParade(byId.get(String(p.cadet_id)), pd))
    .filter(p => !leaves || !p.cadet_id || !onLeave(leaves, p.cadet_id, Number(pd.reportAt)))
    .map(p => p.user_id);
}

// ---- Leave for several days ---------------------------------------------------------------------
// Approved leave is kept in the shared data as state.leaves: [{ id, cadetId, from, to }] with dates
// 'YYYY-MM-DD' (India time), first and last day included. The reason stays with the request.
const DAY = /^\d{4}-\d\d-\d\d$/;
/** The approved leave covering this cadet at this moment, or null. */
export function onLeave(leaves, cadetId, ms) {
  const day = istDay(ms).date;
  return (Array.isArray(leaves) ? leaves : []).find(l => l && String(l.cadetId) === String(cadetId) && DAY.test(l.from) && DAY.test(l.to) && l.from <= day && day <= l.to) || null;
}
/** Request rows for leave use parade_id 'leave:<first day>' (they are not about one parade). */
export const isLeaveRequest = r => String(r?.parade_id || '').startsWith('leave:');

/**
 * How a parade counts for a cadet, the same as the site's profile: attended (present or late),
 * missed (absent without a report), excused (absence report or leave), or unmarked.
 */
export function attendanceOf(pd, cadetId, leaves) {
  const m = pd?.marks?.[cadetId];
  const rep = (Array.isArray(pd?.reports) ? pd.reports : []).find(r => r && r.cadetId === cadetId);
  if (m === 'present' || m === 'late') return 'attended';
  if (rep && rep.kind === 'absent') return 'excused';
  if (onLeave(leaves, cadetId, Number(pd.reportAt))) return 'excused';
  if (m === 'absent') return rep ? 'excused' : 'missed';
  return 'unmarked';
}

/** Can a cadet still send (or change) a request for this parade? */
export function requestsOpen(pd, now = Date.now()) {
  return !!pd && now < Number(pd.reportAt) - CUTOFF_MIN * 60000;
}

/**
 * Housekeeping for late/absence requests.
 *   deleteRows:  requests for parades that no longer exist (row and screenshot go)
 *   clearImages: decided requests whose parade is over (screenshot goes, the row stays)
 * requests: [{ id, parade_id, status, image_path }]
 */
export function requestCleanup(requests, parades, now = Date.now()) {
  const byId = new Map((parades || []).filter(p => p && p.id).map(p => [p.id, p]));
  const deleteRows = [], clearImages = [];
  for (const r of requests || []) {
    if (isLeaveRequest(r)) {
      // Leave: the screenshot goes once it is decided and the leave is over.
      if (r.image_path && r.status !== 'pending' && r.to_date && Date.parse(String(r.to_date).slice(0, 10) + 'T23:59:59+05:30') < now) clearImages.push(r);
      continue;
    }
    const pd = byId.get(r.parade_id);
    if (!pd) deleteRows.push(r);
    else if (r.image_path && r.status !== 'pending' && Number(pd.reportAt) + PAST_AFTER_MS < now) clearImages.push(r);
  }
  return { deleteRows, clearImages };
}

/** The report an approved request adds to the parade (replaces any earlier report for that cadet). */
export function approvedReport(request, decider) {
  return {
    id: `rep-req-${request.id}`, cadetId: request.cadet_id, kind: request.kind, reason: request.reason,
    informedTo: decider.cadetId || '', at: Date.parse(request.created_at), by: decider.name,
    fromCadet: true, requestId: request.id, approvedAt: Date.now(),
  };
}

// ---- Uniform -------------------------------------------------------------------------------------
// Request status: requested (in the next order) -> ordered (CQMS placed the order) -> arrived (CQMS
// has the items) -> received (the cadet collected it). Payment: pay = { status: 'submitted' |
// 'approved' | 'rejected', ... }; older entries may carry paid: true.
export const UNIFORM_STATUS = ['requested', 'ordered', 'arrived', 'received'];
export const UNIFORM_ITEMS = [
  { key: 'hackle', label: 'Hackle' }, { key: 'beret', label: 'Beret', sized: true }, { key: 'nameplate', label: 'Nameplate' },
  { key: 'ncc-badge', label: 'NCC badge' }, { key: 'camp-badge', label: 'Camp badge' }, { key: 'lanyard', label: 'Lanyard' },
  { key: 'shoelace', label: 'Shoelace' }, { key: 'socks', label: 'Socks' }, { key: 'belt', label: 'Belt' },
  { key: 'custom', label: 'Something else' },
];
export function uniformLabelOf(r) {
  const base = r.item === 'custom' ? (String(r.custom || '').trim() || 'Other item') : (UNIFORM_ITEMS.find(i => i.key === r.item)?.label || r.item);
  return base + (r.size ? ` (size ${r.size})` : '');
}
export function uniformKeyOf(r) {
  return r.item === 'custom' ? 'custom:' + String(r.custom || '').trim().toLowerCase() : r.item;
}
/** Price of one, as the bill counts it: placed requests keep their price, others use the price list. */
export function uniformUnitOf(r, prices) {
  if (r.status !== 'requested' && r.unitPrice != null) return Number(r.unitPrice);
  const p = (prices || []).find(x => x && x.id === uniformKeyOf(r));
  return p && p.price != null && Number.isFinite(Number(p.price)) ? Number(p.price) : null;
}
export function uniformPaid(r) { return r.pay?.status === 'approved' || r.paid === true; }
/**
 * Why a cadet cannot mark this item received yet ('' when they can).
 * The order must have arrived with CQMS, and anything with a price must be paid and approved.
 */
export function uniformReceiveBlock(r, prices) {
  if (r.status === 'received') return 'Already received.';
  if (r.status === 'requested') return 'CQMS has not placed the order yet.';
  if (r.status === 'ordered') return 'CQMS has not received the order yet.';
  const unit = uniformUnitOf(r, prices);
  if (unit === 0 || uniformPaid(r)) return '';
  if (r.pay?.status === 'submitted') return 'CQMS has not approved your payment yet.';
  if (unit == null) return 'CQMS has not set a price for this item yet, so it cannot be paid.';
  return 'Pay for it first and upload the payment screenshot.';
}
/**
 * Payment screenshots that can go: every item they paid for is approved and collected (or was
 * removed), or the payment was turned down more than 30 days ago.
 * Returns the proofIds whose file can be deleted.
 */
export function payProofsToDelete(requests, now = Date.now()) {
  const byProof = new Map();
  for (const r of requests || []) {
    if (!r?.pay?.proofId || !r.pay.file) continue;
    const list = byProof.get(r.pay.proofId) || [];
    list.push(r);
    byProof.set(r.pay.proofId, list);
  }
  const out = [];
  for (const [proofId, list] of byProof) {
    const done = list.every(r => r.pay.status === 'approved' && r.status === 'received');
    const stale = list.every(r => r.pay.status === 'rejected' && now - Number(r.pay.decidedAt || r.pay.at || 0) > 30 * 86400000);
    if (done || stale) out.push(proofId);
  }
  return out;
}

// ---- Reminders -------------------------------------------------------------------------------------
export const REMIND_BEFORE_MS = 2 * 3600000;  // parade reminders go out 2 hours before reporting time
export const REMIND_LATEST_MS = 15 * 60000;    // ...but not when it is less than 15 minutes away
export const MESS_REMIND_HOUR = 18;           // mess duty: from 6 pm (India time) the evening before
const IST_OFFSET_MS = 5.5 * 3600000;
/** 'YYYY-MM-DD' and the hour, in India time. */
export function istDay(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
/** Parades that need their reminder now (each is sent once; the caller records that). */
export function paradesToRemind(parades, now = Date.now()) {
  return (parades || []).filter(p => p && p.id && Number.isFinite(Number(p.reportAt)))
    .filter(p => { const left = Number(p.reportAt) - now; return left <= REMIND_BEFORE_MS && left > REMIND_LATEST_MS; });
}
/** Mess duty days whose cadets should be told now: tomorrow's from 6 pm, or today's if it was missed. */
export function messToRemind(days, now = Date.now()) {
  const { date: today, hour } = istDay(now);
  const tomorrow = istDay(now + 86400000).date;
  return (days || []).filter(d => d && d.id && Array.isArray(d.cadetIds) && d.cadetIds.length)
    .filter(d => d.date === today ? hour < 20 : d.date === tomorrow && hour >= MESS_REMIND_HOUR);
}
/**
 * Mess duty: does this parade have refreshments? The CQMS turns them on per parade (pd.refreshments).
 * Parades from before the switch existed count as having them when mess duty was already planned.
 */
export function hasRefreshments(pd, days) {
  if (!pd) return false;
  if (pd.refreshments === true) return true;
  if (pd.refreshments === false) return false;
  return (Array.isArray(days) ? days : []).some(d => d && d.paradeId === pd.id);
}
/**
 * Can this cadet do mess duty at this parade? Only cadets (rank CDT, no rank holders), from the years
 * in the mess settings (1st and 2nd by default), not the locals, expected at the parade, not on leave.
 */
export function messCanDo(cadet, pd, date, config, leaves) {
  if (!cadet) return false;
  if (cadet.rank && cadet.rank !== 'CDT') return false;
  const years = (Array.isArray(config?.years) ? config.years : []).filter(y => YEARS.includes(y));
  if (!(years.length ? years : ['1st', '2nd']).includes(cadet.year)) return false;
  if ((Array.isArray(config?.exempt) ? config.exempt : []).map(String).includes(String(cadet.id))) return false;
  if (pd && !inParade(cadet, pd)) return false;
  const day = String(date || '');
  return !(Array.isArray(leaves) ? leaves : []).some(l => l && String(l.cadetId) === String(cadet.id) && DAY.test(l.from) && DAY.test(l.to) && l.from <= day && day <= l.to);
}

/** Cadets at each parade's mess duty (messConfig.perDay, 4 when not set). */
export function messPerDay(config) { return Math.min(30, Math.max(1, Math.round(Number(config?.perDay)) || 4)); }
/** Cadets who said they will do mess duty: they are asked first when a parade gets refreshments. */
export function messStandbyIds(state) {
  return (Array.isArray(state?.messStandby) ? state.messStandby : []).filter(x => x && x.cadetId != null).map(x => String(x.cadetId));
}
/** 6 pm (India time) the evening before the day of a parade, in ms. */
export function messEveningBefore(reportAt) {
  const day = istDay(Number(reportAt)).date;
  return Date.parse(`${day}T${String(MESS_REMIND_HOUR).padStart(2, '0')}:00:00+05:30`) - 86400000;
}
/**
 * Mess duty at a parade with refreshments fills in three calls, each made once (day.asked records them):
 *   'standby'  at once: the cadets who volunteered in advance (state.messStandby) are asked first;
 *   'all'      if places are still empty: every cadet who can do it at that parade (12 hours later, or
 *              sooner for a parade within 2 days; at once when nobody was on the advance list);
 *   'leads'    if still not full: the lance corporals and corporals are told to pick (from 6 pm the
 *              evening before, at least 2 hours after 'all', at the latest 1 hour before reporting).
 * Returns the call due now, or null.
 */
export function messCallDue(pd, day, perDay, now = Date.now()) {
  if (!pd || !(Number(pd.reportAt) > now)) return null;
  if ((Array.isArray(day?.cadetIds) ? day.cadetIds.length : 0) >= perDay) return null;
  const asked = day && day.asked && typeof day.asked === 'object' ? day.asked : {};
  const H = 3600000, at = Number(pd.reportAt);
  if (!asked.standby) return 'standby';
  if (!asked.all) {
    const due = asked.standbyN === 0 ? asked.standby : Math.max(asked.standby + 15 * 60000, Math.min(Math.max(asked.standby + H, Math.min(asked.standby + 12 * H, at - 48 * H)), at - 2 * H));
    return now >= due ? 'all' : null;
  }
  if (!asked.leads) {
    const due = Math.max(asked.all + 15 * 60000, Math.min(Math.max(asked.all + 2 * H, messEveningBefore(at)), at - H));
    return now >= due ? 'leads' : null;
  }
  return null;
}
/** Every parade with refreshments whose next mess duty call is due now: [{ pd, stage }]. */
export function messCallsDue(state, now = Date.now()) {
  const days = Array.isArray(state?.messDuty) ? state.messDuty : [], per = messPerDay(state?.messConfig);
  return (Array.isArray(state?.parades) ? state.parades : []).filter(p => p && p.id && hasRefreshments(p, days))
    .map(pd => ({ pd, stage: messCallDue(pd, days.find(d => d && d.paradeId === pd.id), per, now) })).filter(x => x.stage);
}
/** Is this cadet excused from the parade (an absent report)? */
export function excusedFrom(pd, cadetId) {
  return (Array.isArray(pd?.reports) ? pd.reports : []).some(r => r && String(r.cadetId) === String(cadetId) && r.kind === 'absent');
}
/** Who looks after mess duty: lance corporals and corporals, and POCs below sergeant. */
export function messLeadRank(cadet) {
  const rank = String(cadet?.rank || 'CDT').toUpperCase();
  return rank === 'LCPL' || rank === 'CPL' || (cadet?.poc === true && rank === 'CDT');
}

/** Item ids for "seen by": 'notice:<id>' or 'parade:<id>'. */
export const SEEN_ITEM = /^(notice|parade):[A-Za-z0-9_.:-]{1,128}$/;

// ---- Weekly summary for the administrator (Sunday evening) --------------------------------------
export const WEEKLY_HOUR = 18; // from 6 pm India time on Sundays
/** Day of the week in India time: 0 = Sunday. */
export function istWeekday(ms) { return new Date(ms + IST_OFFSET_MS).getUTCDay(); }
const COMPANIES = ['Jessami', 'Kohima', 'Naushera'];
const pctOf = (a, n) => (n ? Math.round(a / n * 100) : null);
/**
 * The week's numbers: parades held in the last 7 days, attendance overall and by company, cadets
 * under 75% over all parades so far (with at least 3 counted), and uniform money not yet paid.
 */
export function weekSummary(state, now = Date.now()) {
  const cadets = (Array.isArray(state?.cadets) ? state.cadets : []).filter(c => c && c.id != null);
  const parades = (Array.isArray(state?.parades) ? state.parades : []).filter(p => p && Number.isFinite(Number(p.reportAt)) && Number(p.reportAt) <= now);
  const leaves = state?.leaves || [];
  const week = parades.filter(p => Number(p.reportAt) > now - 7 * 86400000);
  const tally = {}; let att = 0, cnt = 0;
  for (const pd of week) for (const c of cadets) {
    if (!inParade(c, pd)) continue;
    const st = attendanceOf(pd, String(c.id), leaves);
    if (st !== 'attended' && st !== 'missed') continue;
    const t = tally[c.company] || (tally[c.company] = { a: 0, n: 0 });
    t.n++; cnt++; if (st === 'attended') { t.a++; att++; }
  }
  const byCompany = COMPANIES.filter(k => tally[k]).map(k => ({ company: k, pct: pctOf(tally[k].a, tally[k].n) }));
  const under = [];
  for (const c of cadets) {
    let a = 0, n = 0;
    for (const pd of parades) {
      if (!inParade(c, pd)) continue;
      const st = attendanceOf(pd, String(c.id), leaves);
      if (st === 'attended') { a++; n++; } else if (st === 'missed') n++;
    }
    if (n >= 3 && a / n < 0.75) under.push({ id: String(c.id), name: `${c.rank || 'CDT'} ${c.name}`, pct: pctOf(a, n) });
  }
  under.sort((x, y) => x.pct - y.pct);
  let owed = 0;
  for (const r of Array.isArray(state?.uniform) ? state.uniform : []) {
    if (!r || r.status === 'received' || uniformPaid(r)) continue;
    const unit = uniformUnitOf(r, state.uniformPrices || []);
    if (unit) owed += unit * (Number(r.qty) || 1);
  }
  return { parades: week.length, pct: pctOf(att, cnt), byCompany, under, owed };
}

// ---- Attendance: how many more parades to reach 75%, and who just dropped below it -------------
/** Parades in a row a cadet must attend to get back to 75% (0 when already there). */
export function needFor75(attended, counted) { return Math.max(0, 3 * counted - 4 * attended); }
/**
 * Cadets who fell below 75% because of a parade marked in the last 3 days: they were at 75% or more
 * before it (with at least 3 parades counted now). One entry per cadet, for their latest counted parade.
 */
export function attendanceDrops(state, now = Date.now()) {
  const cadets = (Array.isArray(state?.cadets) ? state.cadets : []).filter(c => c && c.id != null);
  const parades = (Array.isArray(state?.parades) ? state.parades : []).filter(p => p && p.id && Number.isFinite(Number(p.reportAt)) && Number(p.reportAt) <= now)
    .sort((a, b) => Number(a.reportAt) - Number(b.reportAt));
  const leaves = state?.leaves || [];
  const out = [];
  for (const c of cadets) {
    const seq = [];
    for (const pd of parades) {
      if (!inParade(c, pd)) continue;
      const st = attendanceOf(pd, String(c.id), leaves);
      if (st === 'attended' || st === 'missed') seq.push({ pd, ok: st === 'attended' });
    }
    if (seq.length < 3) continue;
    const last = seq[seq.length - 1];
    if (last.ok || Number(last.pd.reportAt) < now - 3 * 86400000) continue;
    const a = seq.filter(x => x.ok).length, n = seq.length;
    if (a / n >= 0.75 || (a / (n - 1)) < 0.75) continue;
    out.push({ cadetId: String(c.id), paradeId: last.pd.id, pct: Math.round(a / n * 100), need: needFor75(a, n) });
  }
  return out;
}

// ---- Equipment issued by the CQMS: state.equipment = [{ id, cadetId, item, qty, dueDate?, returnedAt? }]
/** Items not returned whose due date (India time) is over. */
export function equipmentOverdue(list, now = Date.now()) {
  const today = istDay(now).date;
  return (Array.isArray(list) ? list : []).filter(e => e && e.id && e.cadetId && !e.returnedAt && DAY.test(String(e.dueDate || '')) && e.dueDate < today);
}

// ---- Sign-ups (camps, selections, drives): state.signups = [{ id, title, closesAt, seats?, scope, years?, cadetIds?, closed?, applicants }]
export function signupOpen(s, now = Date.now()) { return !!s && !s.closed && now < Number(s.closesAt); }

// ---- Practice questions for the certificate exams
export const QUIZ_CERTS = ['B', 'C', 'both'];
/** A question as typed or imported, checked; returns { q } or { error }. */
export function cleanQuestion(x) {
  const text = v => String(v ?? '').trim().replace(/\s+/g, ' ');
  const cert = String(x?.cert || '').trim().toUpperCase() === 'BOTH' ? 'both' : String(x?.cert || '').trim().toUpperCase();
  if (!QUIZ_CERTS.includes(cert)) return { error: "Certificate must be B, C or both." };
  const subject = text(x?.subject).slice(0, 60), question = text(x?.question).slice(0, 600);
  if (!subject) return { error: 'Write the subject.' };
  if (question.length < 5) return { error: 'Write the question.' };
  const options = (Array.isArray(x?.options) ? x.options : []).map(o => text(o).slice(0, 200));
  while (options.length && !options[options.length - 1]) options.pop();
  if (options.length < 2 || options.some(o => !o)) return { error: 'Give at least two answers to pick from, with no gaps.' };
  if (options.length > 6) return { error: 'Six answers at most.' };
  let answer = x?.answer;
  if (typeof answer === 'string' && /^[A-Fa-f]$/.test(answer.trim())) answer = answer.trim().toUpperCase().charCodeAt(0) - 65;
  answer = Number(answer);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return { error: 'Mark which answer is right.' };
  return { q: { cert, subject, question, options, answer, explain: text(x?.explain).slice(0, 600) } };
}

/** A link for the study library: https only, no spaces. */
export function cleanLink(url) {
  const s = String(url || '').trim();
  if (s.length > 500 || !/^https:\/\/[^\s/$.?#][^\s]*$/i.test(s)) return '';
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}
