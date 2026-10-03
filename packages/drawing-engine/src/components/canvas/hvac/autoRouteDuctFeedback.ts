import type { AutoRouteDuctResult } from './duct/ductAutoRoute';

/** A clash-free empty preview is not a successful duct design. */
export function autoRouteDuctFeedback(ducts: AutoRouteDuctResult | null) {
  if (!ducts) return null;
  const designed = ducts.units.filter((unit) => unit.status === 'designed').length;
  const kept = ducts.units.length - designed;
  const needsAttention = kept > 0 || designed === 0;
  const summary = designed === 0
    ? ducts.units.length || ducts.issues.length ? 'No ducts generated' : 'No ducts to route'
    : `Ducts ${designed}/${ducts.units.length}${kept ? ` · ${kept} ${kept === 1 ? 'unit needs' : 'units need'} review` : ''}`;
  // Unit notes are shown next to that unit; only assignment/scope messages
  // belong in the additional list, so the actual reasons are not duplicated.
  const unitNotes = new Set(ducts.units.flatMap((unit) => unit.notes.map((note) => `${unit.unitLabel}: ${note}`)));
  const additionalIssues = [...new Set(ducts.issues.filter((issue) => !unitNotes.has(issue)))];
  return { summary, needsAttention, additionalIssues };
}
