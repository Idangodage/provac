/**
 * Parametric and dimension-driven modeling layer.
 *
 * This module focuses on architectural editing workflows where wall geometry is
 * controlled by dimensions, formulas, and chain constraints.
 */

import { distance } from '../utils/geometry';

import type { Wall2D } from './internal-types';

// =============================================================================
// Types
// =============================================================================

export interface LinearDimensionConstraint {
    id: string;
    wallId: string;
    targetLength?: number;
    expression?: string;
    minLength?: number;
    maxLength?: number;
    equalityGroupId?: string;
    enabled?: boolean;
}

export interface DimensionChainConstraint {
    id: string;
    wallIds: string[];
    totalLength?: number;
    equalSegments?: boolean;
    minSegmentLength?: number;
    maxSegmentLength?: number;
    enabled?: boolean;
}

export interface ParameterDefinition {
    id: string;
    value?: number;
    expression?: string;
    description?: string;
}

export interface ParametricDiagnostic {
    severity: 'error' | 'warning';
    sourceId: string;
    message: string;
}

export interface ParametricSolveResult {
    walls: Wall2D[];
    parameterValues: Record<string, number>;
    diagnostics: ParametricDiagnostic[];
}

export interface ParametricSolveInput {
    walls: Wall2D[];
    dimensions: LinearDimensionConstraint[];
    chains?: DimensionChainConstraint[];
    parameters?: ParameterDefinition[];
    contextValues?: Record<string, number>;
}

// =============================================================================
// Public API
// =============================================================================

export function solveParametricModel(input: ParametricSolveInput): ParametricSolveResult {
    const diagnostics: ParametricDiagnostic[] = [];
    const wallMap = new Map<string, Wall2D>(
        input.walls.map((wall) => [wall.id, cloneWall(wall)])
    );

    const parameterValues = resolveParameters(
        input.parameters ?? [],
        input.contextValues ?? {},
        diagnostics
    );

    const wallLengthTargets = new Map<string, number>();
    input.dimensions.forEach((dimension) => {
        if (dimension.enabled === false) return;
        const wall = wallMap.get(dimension.wallId);
        if (!wall) {
            diagnostics.push({
                severity: 'warning',
                sourceId: dimension.id,
                message: `Wall ${dimension.wallId} not found for dimension constraint.`,
            });
            return;
        }

        let target = dimension.targetLength;
        if (dimension.expression) {
            const evaluated = evaluateExpression(dimension.expression, parameterValues, wallMap, diagnostics, dimension.id);
            if (Number.isFinite(evaluated)) {
                target = evaluated;
            }
        }
        if (!Number.isFinite(target)) return;

        const clamped = clampLength(target as number, dimension.minLength, dimension.maxLength);
        wallLengthTargets.set(dimension.wallId, clamped);
        setWallLength(wall, clamped);
    });

    applyEqualityGroups(input.dimensions, wallMap, wallLengthTargets, diagnostics);
    applyDimensionChains(input.chains ?? [], wallMap, diagnostics);

    return {
        walls: Array.from(wallMap.values()),
        parameterValues,
        diagnostics,
    };
}

export class ParametricModelEngine {
    private dimensions = new Map<string, LinearDimensionConstraint>();
    private chains = new Map<string, DimensionChainConstraint>();
    private parameters = new Map<string, ParameterDefinition>();

    upsertDimension(dimension: LinearDimensionConstraint): void {
        this.dimensions.set(dimension.id, { ...dimension });
    }

    removeDimension(id: string): void {
        this.dimensions.delete(id);
    }

    upsertChain(chain: DimensionChainConstraint): void {
        this.chains.set(chain.id, { ...chain, wallIds: [...chain.wallIds] });
    }

    removeChain(id: string): void {
        this.chains.delete(id);
    }

    upsertParameter(parameter: ParameterDefinition): void {
        this.parameters.set(parameter.id, { ...parameter });
    }

    removeParameter(id: string): void {
        this.parameters.delete(id);
    }

    setDimensionValue(id: string, targetLength: number): void {
        const dimension = this.dimensions.get(id);
        if (!dimension) return;
        this.dimensions.set(id, {
            ...dimension,
            targetLength,
            expression: undefined,
        });
    }

    solve(walls: Wall2D[], contextValues: Record<string, number> = {}): ParametricSolveResult {
        return solveParametricModel({
            walls,
            dimensions: Array.from(this.dimensions.values()),
            chains: Array.from(this.chains.values()),
            parameters: Array.from(this.parameters.values()),
            contextValues,
        });
    }
}

// =============================================================================
// Dimension Constraints
// =============================================================================

function applyEqualityGroups(
    dimensions: LinearDimensionConstraint[],
    wallMap: Map<string, Wall2D>,
    wallLengthTargets: Map<string, number>,
    diagnostics: ParametricDiagnostic[]
): void {
    const groups = new Map<string, string[]>();
    dimensions.forEach((dimension) => {
        if (!dimension.equalityGroupId || dimension.enabled === false) return;
        const group = groups.get(dimension.equalityGroupId) ?? [];
        group.push(dimension.wallId);
        groups.set(dimension.equalityGroupId, group);
    });

    groups.forEach((wallIds, groupId) => {
        const lengths: number[] = [];
        wallIds.forEach((wallId) => {
            const target = wallLengthTargets.get(wallId);
            if (Number.isFinite(target)) {
                lengths.push(target as number);
                return;
            }
            const wall = wallMap.get(wallId);
            if (!wall) return;
            lengths.push(getWallLength(wall));
        });

        if (lengths.length === 0) return;
        const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
        wallIds.forEach((wallId) => {
            const wall = wallMap.get(wallId);
            if (!wall) return;
            setWallLength(wall, average);
        });

        diagnostics.push({
            severity: 'warning',
            sourceId: groupId,
            message: `Applied equality group to ${wallIds.length} wall(s).`,
        });
    });
}

function applyDimensionChains(
    chains: DimensionChainConstraint[],
    wallMap: Map<string, Wall2D>,
    diagnostics: ParametricDiagnostic[]
): void {
    chains.forEach((chain) => {
        if (chain.enabled === false || chain.wallIds.length === 0) return;
        const walls = chain.wallIds
            .map((wallId) => wallMap.get(wallId))
            .filter((wall): wall is Wall2D => Boolean(wall));
        if (walls.length === 0) return;

        const lengths = walls.map((wall) => getWallLength(wall));
        const currentTotal = lengths.reduce((sum, value) => sum + value, 0);

        if (chain.equalSegments) {
            const base = Number.isFinite(chain.totalLength)
                ? (chain.totalLength as number) / walls.length
                : currentTotal / walls.length;
            const clamped = clampLength(base, chain.minSegmentLength, chain.maxSegmentLength);
            walls.forEach((wall) => setWallLength(wall, clamped));
            return;
        }

        if (Number.isFinite(chain.totalLength) && currentTotal > 1e-9) {
            const scale = (chain.totalLength as number) / currentTotal;
            walls.forEach((wall, index) => {
                const nextLength = clampLength(
                    lengths[index] * scale,
                    chain.minSegmentLength,
                    chain.maxSegmentLength
                );
                setWallLength(wall, nextLength);
            });
            return;
        }

        diagnostics.push({
            severity: 'warning',
            sourceId: chain.id,
            message: 'Dimension chain has no actionable total length or equal segment rule.',
        });
    });
}

// =============================================================================
// Parameter + Expression Solver
// =============================================================================

function resolveParameters(
    definitions: ParameterDefinition[],
    contextValues: Record<string, number>,
    diagnostics: ParametricDiagnostic[]
): Record<string, number> {
    const values: Record<string, number> = { ...contextValues };
    const byId = new Map<string, ParameterDefinition>(
        definitions.map((definition) => [definition.id, definition])
    );

    definitions.forEach((definition) => {
        if (Number.isFinite(definition.value)) {
            values[definition.id] = definition.value as number;
        }
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
        if (visited.has(id)) return;
        if (visiting.has(id)) {
            diagnostics.push({
                severity: 'error',
                sourceId: id,
                message: 'Cyclic parameter dependency detected.',
            });
            return;
        }

        const definition = byId.get(id);
        if (!definition) return;
        visiting.add(id);

        if (definition.expression) {
            const dependencies = extractExpressionDependencies(definition.expression);
            dependencies.forEach((dep) => {
                if (dep === id) return;
                if (byId.has(dep)) visit(dep);
            });
            const evaluated = evaluateExpression(
                definition.expression,
                values,
                new Map<string, Wall2D>(),
                diagnostics,
                id
            );
            if (Number.isFinite(evaluated)) {
                values[id] = evaluated;
            }
        }

        visiting.delete(id);
        visited.add(id);
    };

    definitions.forEach((definition) => visit(definition.id));
    return values;
}

function evaluateExpression(
    expression: string,
    parameterValues: Record<string, number>,
    wallMap: Map<string, Wall2D>,
    diagnostics: ParametricDiagnostic[],
    sourceId: string
): number {
    try {
        const tokens = tokenizeExpression(expression);
        const rpn = toRpn(tokens);
        return evaluateRpn(rpn, (identifier) => {
            if (identifier in parameterValues) return parameterValues[identifier] as number;
            if (identifier.startsWith('wall.') && identifier.endsWith('.length')) {
                const wallId = identifier.slice('wall.'.length, -'.length'.length);
                const wall = wallMap.get(wallId);
                return wall ? getWallLength(wall) : NaN;
            }
            return NaN;
        });
    } catch (error) {
        diagnostics.push({
            severity: 'error',
            sourceId,
            message: `Expression error: ${(error as Error).message}`,
        });
        return NaN;
    }
}

function extractExpressionDependencies(expression: string): string[] {
    const pattern = /[A-Za-z_][A-Za-z0-9_.]*/g;
    const deps = new Set<string>();
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(expression)) !== null) {
        deps.add(match[0]);
    }
    return Array.from(deps);
}

type ExpressionToken = number | string;

function tokenizeExpression(expression: string): ExpressionToken[] {
    const tokens: ExpressionToken[] = [];
    let index = 0;

    while (index < expression.length) {
        const char = expression[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }

        if (/[0-9.]/.test(char)) {
            let end = index + 1;
            while (end < expression.length && /[0-9.]/.test(expression[end])) end += 1;
            tokens.push(Number.parseFloat(expression.slice(index, end)));
            index = end;
            continue;
        }

        if (/[A-Za-z_]/.test(char)) {
            let end = index + 1;
            while (end < expression.length && /[A-Za-z0-9_.]/.test(expression[end])) end += 1;
            tokens.push(expression.slice(index, end));
            index = end;
            continue;
        }

        if ('+-*/()'.includes(char)) {
            const prev = tokens[tokens.length - 1];
            const unaryMinus =
                char === '-' &&
                (tokens.length === 0 ||
                    prev === '(' ||
                    prev === '+' ||
                    prev === '-' ||
                    prev === '*' ||
                    prev === '/');
            if (unaryMinus) {
                tokens.push(0);
            }
            tokens.push(char);
            index += 1;
            continue;
        }

        throw new Error(`Unexpected token '${char}'.`);
    }

    return tokens;
}

function toRpn(tokens: ExpressionToken[]): ExpressionToken[] {
    const output: ExpressionToken[] = [];
    const ops: string[] = [];
    const precedence = new Map<string, number>([
        ['+', 1],
        ['-', 1],
        ['*', 2],
        ['/', 2],
    ]);

    tokens.forEach((token) => {
        if (typeof token === 'number' || isIdentifier(token)) {
            output.push(token);
            return;
        }

        if (token === '(') {
            ops.push(token);
            return;
        }

        if (token === ')') {
            while (ops.length > 0 && ops[ops.length - 1] !== '(') {
                output.push(ops.pop() as string);
            }
            if (ops.length === 0) throw new Error('Mismatched parentheses.');
            ops.pop();
            return;
        }

        while (
            ops.length > 0 &&
            ops[ops.length - 1] !== '(' &&
            (precedence.get(ops[ops.length - 1]) ?? 0) >= (precedence.get(token) ?? 0)
        ) {
            output.push(ops.pop() as string);
        }
        ops.push(token);
    });

    while (ops.length > 0) {
        const op = ops.pop() as string;
        if (op === '(') throw new Error('Mismatched parentheses.');
        output.push(op);
    }
    return output;
}

function evaluateRpn(
    rpn: ExpressionToken[],
    resolveIdentifier: (identifier: string) => number
): number {
    const stack: number[] = [];
    rpn.forEach((token) => {
        if (typeof token === 'number') {
            stack.push(token);
            return;
        }
        if (isIdentifier(token)) {
            const resolved = resolveIdentifier(token);
            if (!Number.isFinite(resolved)) {
                throw new Error(`Unknown identifier '${token}'.`);
            }
            stack.push(resolved);
            return;
        }

        const b = stack.pop();
        const a = stack.pop();
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            throw new Error('Malformed expression.');
        }
        switch (token) {
            case '+':
                stack.push((a as number) + (b as number));
                break;
            case '-':
                stack.push((a as number) - (b as number));
                break;
            case '*':
                stack.push((a as number) * (b as number));
                break;
            case '/':
                stack.push((a as number) / (b as number));
                break;
            default:
                throw new Error(`Unsupported operator '${token}'.`);
        }
    });
    if (stack.length !== 1) throw new Error('Malformed expression.');
    return stack[0] as number;
}

function isIdentifier(token: ExpressionToken): token is string {
    return typeof token === 'string' && !'+-*/()'.includes(token);
}

// =============================================================================
// Wall Geometry Utilities
// =============================================================================

function getWallLength(wall: Wall2D): number {
    return distance(wall.start, wall.end);
}

function setWallLength(wall: Wall2D, targetLength: number): void {
    const current = getWallLength(wall);
    if (!Number.isFinite(targetLength) || targetLength <= 1e-6) return;

    if (current <= 1e-9) {
        wall.end = { x: wall.start.x + targetLength, y: wall.start.y };
        return;
    }

    const ux = (wall.end.x - wall.start.x) / current;
    const uy = (wall.end.y - wall.start.y) / current;
    wall.end = {
        x: wall.start.x + ux * targetLength,
        y: wall.start.y + uy * targetLength,
    };
}

function clampLength(value: number, min?: number, max?: number): number {
    let result = value;
    if (Number.isFinite(min)) result = Math.max(result, min as number);
    if (Number.isFinite(max)) result = Math.min(result, max as number);
    return result;
}

function cloneWall(wall: Wall2D): Wall2D {
    return {
        ...wall,
        start: { ...wall.start },
        end: { ...wall.end },
        openings: wall.openings.map((opening) => ({ ...opening })),
        connectedWallIds: wall.connectedWallIds ? [...wall.connectedWallIds] : wall.connectedWallIds,
        wallLayers: wall.wallLayers ? wall.wallLayers.map((layer) => ({ ...layer })) : wall.wallLayers,
    };
}
