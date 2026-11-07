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
  requests: r => atLeast(r, 'SGT'),        // see and approve late/absence requests, reports, attendance
  uniform: r => r === 'CQMS',              // place orders, mark arrived, approve payments, prices
  admin: () => false,                      // roster, timetables, accounts, deleting, restoring
};
/** who: { admin: boolean, rank: 'CDT'… | null } of an approved account. */
export function can(who, perm) {
  if (!who) return false;
  if (who.admin) return true;
  const rank = RANKS.includes(who.rank) ? who.rank : null;
  return !!rank && !!PERMISSIONS[perm]?.(rank);
}

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
 * profiles: [{ user_id, cadet_id, status }]
 */
export function paradeRecipients(profiles, cadets, pd) {
  const byId = new Map((cadets || []).filter(c => c && c.id != null).map(c => [String(c.id), c]));
  return (profiles || [])
    .filter(p => p && p.status === 'approved')
    .filter(p => !p.cadet_id || inParade(byId.get(String(p.cadet_id)), pd))
    .map(p => p.user_id);
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
