/**
 * Professional feature architecture facade.
 *
 * This facade wires advanced CAD capabilities so consumers can initialize a
 * single kernel and progressively adopt modules.
 */

import {
    createFloorPlanFile,
    exportFloorPlanToDxf,
    exportFloorPlanToPdfModel,
    exportFloorPlanToSvg,
    importFloorPlanFromDxf,
    importFloorPlanFromJson,
    migrateFloorPlanFile,
    parseFloorPlanFile,
    serializeFloorPlanFile,
    type FloorPlanFileEnvelope,
} from './file-format';
import {
    CommandHistoryManager,
    SnapshotCommand,
    type CommandContext,
} from './history';
import type { FloorPlanData, Wall2D } from './internal-types';
import {
    ParametricModelEngine,
    solveParametricModel,
    type ParametricSolveResult,
    type LinearDimensionConstraint,
    type DimensionChainConstraint,
    type ParameterDefinition,
} from './parametric';
import {
    FloorPlanSpatialIndex,
    LazyFloorPlanMetrics,
    computeLodDecision,
    type LodDecision,
} from './performance';
import {
    PrecisionToolkit,
    parseCoordinateInput,
    type CoordinateInputContext,
    type CoordinateInputResult,
} from './precision';

export interface ProfessionalKernelContext extends CommandContext {
    data: FloorPlanData;
    setData: (data: FloorPlanData) => void;
}

export interface ProfessionalKernelOptions {
    autoCleanup?: boolean;
}

export class ProfessionalFloorPlanKernel {
    readonly parametric = new ParametricModelEngine();
    readonly precision = new PrecisionToolkit();
    readonly spatialIndex = new FloorPlanSpatialIndex();
    readonly metrics = new LazyFloorPlanMetrics();
    readonly history = new CommandHistoryManager<ProfessionalKernelContext>({ maxEntries: 300 });

    constructor(private readonly options: ProfessionalKernelOptions = {}) {}

    parseCoordinate(input: string, context: CoordinateInputContext): CoordinateInputResult | null {
        return parseCoordinateInput(input, context);
    }

    solveParametric(
        walls: Wall2D[],
        dimensions: LinearDimensionConstraint[],
        chains: DimensionChainConstraint[] = [],
        parameters: ParameterDefinition[] = [],
        contextValues: Record<string, number> = {}
    ): ParametricSolveResult {
        return solveParametricModel({
            walls,
            dimensions,
            chains,
            parameters,
            contextValues,
        });
    }

    rebuildSpatialIndex(walls: Wall2D[]): void {
        this.spatialIndex.rebuild(walls);
    }

    resolveLod(zoom: number): LodDecision {
        return computeLodDecision(zoom);
    }

    withSnapshotCommand(
        id: string,
        label: string,
        mutate: (ctx: ProfessionalKernelContext) => void
    ): SnapshotCommand<ProfessionalKernelContext, FloorPlanData> {
        return new SnapshotCommand<ProfessionalKernelContext, FloorPlanData>({
            id,
            label,
            adapter: {
                capture: () => {
                    throw new Error('Snapshot adapter must be bound through executeSnapshotCommand.');
                },
                restore: () => {
                    throw new Error('Snapshot adapter must be bound through executeSnapshotCommand.');
                },
            },
            mutate,
        });
    }

    async executeSnapshotCommand(
        id: string,
        label: string,
        context: ProfessionalKernelContext,
        mutate: (ctx: ProfessionalKernelContext) => void
    ): Promise<void> {
        const command = new SnapshotCommand<ProfessionalKernelContext, FloorPlanData>({
            id,
            label,
            adapter: {
                capture: () => deepClone(context.data),
                restore: (snapshot) => context.setData(deepClone(snapshot)),
            },
            mutate,
        });
        await this.history.execute(command, context);
    }

    // File format facade
    createFile(data: FloorPlanData): FloorPlanFileEnvelope {
        return createFloorPlanFile(data);
    }

    serializeFile(file: FloorPlanFileEnvelope): string {
        return serializeFloorPlanFile(file);
    }

    parseFile(json: string): FloorPlanFileEnvelope {
        return parseFloorPlanFile(json);
    }

    migrateFile(file: FloorPlanFileEnvelope): FloorPlanFileEnvelope {
        return migrateFloorPlanFile(file);
    }

    importJson(json: string): FloorPlanData {
        return importFloorPlanFromJson(json).data;
    }

    importDxf(content: string): FloorPlanData {
        return importFloorPlanFromDxf(content).data;
    }

    exportSvg(data: FloorPlanData): string {
        return exportFloorPlanToSvg(data);
    }

    exportDxf(data: FloorPlanData): string {
        return exportFloorPlanToDxf(data);
    }

    exportPdfModel(data: FloorPlanData) {
        return exportFloorPlanToPdfModel(data);
    }
}

function deepClone<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

export * from './parametric';
export * from './precision';
export * from './performance';
export * from './history';
export * from './file-format';
