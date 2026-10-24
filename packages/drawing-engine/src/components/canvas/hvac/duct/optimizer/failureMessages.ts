/**
 * When no design comes out clean: why, in a designer's terms. Across the trees
 * the optimiser tried, the rule that failed most often and the terminal it
 * concerns, with what would free it — instead of a bare issue count.
 */
import type { AutoDuctIssue, ServiceCtx, TerminalCtx } from '../ductAutoContext';
import { neckVelocityMs } from '../ductSizing';

import { allRuns, servedTerminals, type RunDesign } from './designTree';
import type { ServiceOption, TreeFailure } from './ductOptimizer';
import type { RoutingGraph } from './routingGraph';

type Cause = 'collar' | 'runout' | 'take-off' | 'end' | 'split' | 'clash' | 'wall' | 'penetration';

const CAUSE_OF_REASON: Record<string, Cause> = {
  collar: 'collar',
  runout: 'runout',
  'take-off': 'take-off',
  'take-off-windows': 'take-off',
  'section-change': 'take-off',
  'branch-start': 'take-off',
  origin: 'take-off',
  'end-terminal': 'end',
  'neck-transition': 'end',
  'end-split': 'split',
};

const CAUSE_OF_CODE: Record<string, Cause> = {
  DU_FLEX_BEND: 'runout',
  DU_FLEX_LENGTH: 'runout',
  DU_TAP_CLASH: 'take-off',
  DU_LEG_TOO_SHORT: 'end',
  DU_CLASH: 'clash',
  DU_AUTO_WALL: 'wall',
  DU_PENETRATION_FITTING: 'penetration',
  DU_PENETRATION_FLEX: 'penetration',
};

function labelOf(terminal: TerminalCtx): string {
  return terminal.element.label || terminal.spec.kind;
}

/** The terminals a failed run concerns: its own, or those of the take-off named. */
function concerned(run: RunDesign | undefined, tap: number | undefined): TerminalCtx[] {
  if (!run) return [];
  const child = tap !== undefined ? run.taps[tap]?.child : undefined;
  return servedTerminals(child ?? run).slice(0, 2);
}

function sentence(cause: Cause, names: string): string {
  switch (cause) {
    case 'collar':
      return 'The straight off the unit\'s collar is too short for its connector, transition and first turn: move the nearest terminal further from the unit, or turn the unit.';
    case 'runout':
      return `${names}: its flexible runout cannot reach the spigot within the bend-radius and length limits from anywhere a duct can pass. Move it, or allow its spigot to turn (duct settings).`;
    case 'take-off':
      return `${names}: no room for its take-off where the duct passes — the fittings nearby need that length. Space the terminals further apart, or move the unit.`;
    case 'end':
      return `${names}: the last stretch of duct to it is too short for its fittings (the step down to its neck, the elbow before it). Move it a little further from the duct.`;
    case 'split':
      return `${names}: the split that would feed it has no room for its outlets. Space the terminals further apart.`;
    case 'wall':
      return `${names}: the duct would have to pass through a wall it may not cross (an exterior wall, or a wall inside a one-room system). Move it, or the unit.`;
    case 'penetration':
      return `${names}: the duct reaches it through a wall, but a fitting or its flexible runout would sit in the wall there; a wall needs a plain straight through it. Move it further from the wall, or the unit.`;
    default:
      return `${names}: the duct cannot get past the equipment round it at this level. Move it, or the equipment in the way.`;
  }
}

/**
 * When the tree router found no tree at all: equipment standing in front of
 * the collar, closer than the connector, the collar's own elbow and its
 * clearance need to turn the duct (null when that is not why).
 */
export function explainBlockedCollar(ctx: ServiceCtx, model: { elbowSetbackMm(leg: { widthMm: number; heightMm: number }): number }): AutoDuctIssue | null {
  const s = ctx.settings;
  const half = ctx.port.widthMm / 2;
  const connector = s.flexibleConnectorAtUnit ? s.connectorFabricMm + 2 * s.connectorMetalMm : 0;
  const need = Math.ceil((connector + model.elbowSetbackMm({ widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm }) + s.elbowNeckMm + 25 + half + 50) / 50) * 50;
  const ahead = ctx.obstacles
    .filter((box) => box.id !== ctx.unitId && box.minX > 0 && box.minY < half + 50 && box.maxY > -(half + 50)
      && box.zMax > ctx.bottomZ && box.zMin < ctx.bottomZ + ctx.port.heightMm)
    .sort((a, b) => a.minX - b.minX)[0];
  if (!ahead || ahead.minX >= need) return null;
  const terminal = ctx.terminals.find((entry) => entry.element.id === ahead.id);
  const name = terminal ? labelOf(terminal) : 'Equipment';
  return {
    code: 'DU_AUTO_WHY', severity: 'warning', service: ctx.service,
    message: `${name} stands ${Math.round(ahead.minX)} mm in front of the collar: the duct cannot turn before it (the connector and the collar's elbow need about ${need} mm). Move it further from the unit, or to one side.`,
  };
}

/**
 * Up to two plain reasons, the most frequent first, when every option still
 * has errors (warnings, so Auto route shows them with the unit it left).
 */
export function explainNoCleanDesign(ctx: ServiceCtx, failures: readonly TreeFailure[], options: readonly ServiceOption[]): AutoDuctIssue[] {
  const tally = new Map<string, { cause: Cause; terminals: TerminalCtx[]; count: number }>();
  const add = (cause: Cause | undefined, terminals: TerminalCtx[]) => {
    if (!cause) return;
    const key = `${cause}|${terminals.map((terminal) => terminal.element.id).join(',')}`;
    const entry = tally.get(key) ?? { cause, terminals, count: 0 };
    entry.count += 1;
    tally.set(key, entry);
  };
  for (const { design, failure } of failures) {
    const run = allRuns(design.root).find((entry) => entry.key === failure.runKey);
    add(CAUSE_OF_REASON[failure.reason], failure.reason === 'collar' ? [] : concerned(run, 'tap' in failure ? failure.tap : undefined));
  }
  // The planner's errors on the designs that were built, traced to their runs.
  for (const option of options) {
    if (!option.errors || !option.design || !option.runKeys) continue;
    const runs = new Map(allRuns(option.design.root).map((run) => [run.key, run]));
    for (const issue of option.issues) {
      if (issue.severity !== 'error' || !issue.runId) continue;
      add(CAUSE_OF_CODE[issue.code], concerned(runs.get(option.runKeys.get(issue.runId) ?? ''), undefined));
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((entry) => ({
      code: 'DU_AUTO_WHY', severity: 'warning' as const, service: ctx.service,
      message: sentence(entry.cause, entry.terminals.map(labelOf).join(' and ') || 'A terminal'),
    }));
}

/** A neck this many times over its velocity limit is why a layout fails, not a note beside it. */
const TOO_MUCH_AIR = 1.5;

const names = (terminals: readonly TerminalCtx[]) => {
  const labels = terminals.map(labelOf);
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
};

/**
 * Why the optimiser built no layout at all, the most actionable cause first:
 * terminals behind the collar (the unit faces away from them), too much air
 * through each terminal's neck, terminals no flexible runout reaches, then
 * what failed most often across the trees tried. The issues explain; the
 * reason is the short form for the "No buildable layout" line (null: none of
 * the plain causes, only the trees' failures).
 */
export function explainNoLayout(ctx: ServiceCtx, graphs: readonly RoutingGraph[], failures: readonly TreeFailure[]): { issues: AutoDuctIssue[]; reason: string | null } {
  const issues: AutoDuctIssue[] = [];
  const reasons: string[] = [];
  // Terminals the router could reach from nowhere in any of its graphs.
  const unreachable = graphs.length ? ctx.terminals.filter((_, index) => graphs.every((graph) => !graph.leaves[index]?.length)) : [];
  const behind = unreachable.filter((terminal) => {
    const index = ctx.terminals.indexOf(terminal);
    return graphs.every((graph) => {
      const report = graph.leafReport?.[index];
      return report !== undefined && report.tried > 0 && report.behind === report.tried;
    });
  });
  if (behind.length) {
    const one = behind.length === 1;
    issues.push({
      code: 'DU_AUTO_BEHIND_COLLAR', severity: 'warning', service: ctx.service,
      message: `${names(behind)} ${one ? 'is' : 'are'} behind the ${ctx.service} collar: a duct leaves the collar forwards and cannot reach ${one ? 'it' : 'them'}. Turn the unit so the collar faces ${one ? 'it' : 'them'}.`,
    });
    reasons.push(`${names(behind)} ${one ? 'is' : 'are'} behind the ${ctx.service} collar`);
  }
  const cap = ctx.service === 'return' ? ctx.settings.autoMaxNeckVelocityReturnMs : ctx.settings.autoMaxNeckVelocitySupplyMs;
  const overloaded = ctx.terminals.filter((terminal) => neckVelocityMs({ neckDiameterMm: terminal.neck }, terminal.airflowM3h) > cap * TOO_MUCH_AIR);
  if (overloaded.length) {
    reasons.push(`too much air through ${overloaded.length === ctx.terminals.length && overloaded.length > 1 ? 'each terminal' : names(overloaded)} for ${overloaded.length === 1 ? 'its neck' : 'their necks'}`);
  }
  const stranded = unreachable.filter((terminal) => !behind.includes(terminal));
  if (stranded.length) {
    issues.push({ code: 'DU_AUTO_WHY', severity: 'warning', service: ctx.service, message: sentence('runout', names(stranded)) });
    reasons.push(`no flexible runout reaches ${names(stranded)}`);
  }
  // Nothing as plain as those: what failed most often across the trees (its sentences stand beside the line).
  if (!reasons.length && failures.length) issues.push(...explainNoCleanDesign(ctx, failures, []));
  return { issues, reason: reasons.length ? reasons.join('; ') : null };
}
