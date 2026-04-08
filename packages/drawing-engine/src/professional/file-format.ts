/**
 * Floor plan file schema, migration, and exchange format adapters.
 */

import { generateId } from '../utils/geometry';

import type { FloorPlanData, Room2D, Wall2D } from './internal-types';

// =============================================================================
// File Schema
// =============================================================================

export const FLOOR_PLAN_SCHEMA_ID = 'provacx.floor-plan';
export const CURRENT_FLOOR_PLAN_VERSION = 2;

export interface FloorPlanFileMetadata {
    name?: string;
    createdAt: string;
    updatedAt: string;
    unit?: string;
    author?: string;
}

export interface FloorPlanFileEnvelopeV2 {
    schema: typeof FLOOR_PLAN_SCHEMA_ID;
    version: 2;
    metadata: FloorPlanFileMetadata;
    data: FloorPlanData;
}

export interface FloorPlanFileEnvelopeV1 {
    schema: typeof FLOOR_PLAN_SCHEMA_ID;
    version: 1;
    data: {
        walls: Wall2D[];
        rooms: Room2D[];
        scale?: number;
        width?: number;
        height?: number;
    };
}

export type FloorPlanFileEnvelope = FloorPlanFileEnvelopeV1 | FloorPlanFileEnvelopeV2;

export const FLOOR_PLAN_JSON_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: FLOOR_PLAN_SCHEMA_ID,
    type: 'object',
    required: ['schema', 'version', 'data'],
    properties: {
        schema: { const: FLOOR_PLAN_SCHEMA_ID },
        version: { type: 'integer', minimum: 1 },
        metadata: {
            type: 'object',
            additionalProperties: true,
            properties: {
                name: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
                unit: { type: 'string' },
                author: { type: 'string' },
            },
        },
        data: {
            type: 'object',
            required: ['walls', 'rooms'],
            properties: {
                walls: { type: 'array' },
                rooms: { type: 'array' },
                guides: { type: 'array' },
                scale: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
            },
        },
    },
    additionalProperties: false,
} as const;

// =============================================================================
// Serialization + Validation
// =============================================================================

export function createFloorPlanFile(
    data: FloorPlanData,
    metadata: Partial<FloorPlanFileMetadata> = {}
): FloorPlanFileEnvelopeV2 {
    const now = new Date().toISOString();
    return {
        schema: FLOOR_PLAN_SCHEMA_ID,
        version: CURRENT_FLOOR_PLAN_VERSION,
        metadata: {
            createdAt: metadata.createdAt ?? now,
            updatedAt: metadata.updatedAt ?? now,
            name: metadata.name,
            unit: metadata.unit ?? 'mm',
            author: metadata.author,
        },
        data,
    };
}

export function serializeFloorPlanFile(file: FloorPlanFileEnvelope): string {
    return JSON.stringify(file, null, 2);
}

export function parseFloorPlanFile(json: string): FloorPlanFileEnvelope {
    const parsed = JSON.parse(json) as FloorPlanFileEnvelope;
    const errors = validateFloorPlanFile(parsed);
    if (errors.length > 0) {
        throw new Error(`Invalid floor plan file: ${errors.join('; ')}`);
    }
    return parsed;
}

export function validateFloorPlanFile(file: unknown): string[] {
    const errors: string[] = [];
    if (!file || typeof file !== 'object') return ['File must be an object.'];
    const typed = file as Record<string, unknown>;
    if (typed.schema !== FLOOR_PLAN_SCHEMA_ID) errors.push('schema mismatch');
    if (!Number.isInteger(typed.version)) errors.push('version must be an integer');
    const data = typed.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') {
        errors.push('data object missing');
    } else {
        if (!Array.isArray(data.walls)) errors.push('data.walls must be an array');
        if (!Array.isArray(data.rooms)) errors.push('data.rooms must be an array');
    }
    return errors;
}

// =============================================================================
// Version Migration
// =============================================================================

export function migrateFloorPlanFile(
    file: FloorPlanFileEnvelope,
    targetVersion = CURRENT_FLOOR_PLAN_VERSION
): FloorPlanFileEnvelopeV2 {
    if (targetVersion !== CURRENT_FLOOR_PLAN_VERSION) {
        throw new Error(`Unsupported migration target version ${targetVersion}.`);
    }

    if (file.version === 2) {
        return file;
    }

    if (file.version === 1) {
        return migrateV1ToV2(file);
    }

    throw new Error(`Unsupported floor plan file version ${(file as { version?: number }).version}.`);
}

function migrateV1ToV2(file: FloorPlanFileEnvelopeV1): FloorPlanFileEnvelopeV2 {
    const now = new Date().toISOString();
    return {
        schema: FLOOR_PLAN_SCHEMA_ID,
        version: 2,
        metadata: {
            createdAt: now,
            updatedAt: now,
            unit: 'mm',
        },
        data: {
            walls: file.data.walls ?? [],
            rooms: file.data.rooms ?? [],
            scale: file.data.scale ?? 1,
            width: file.data.width ?? 0,
            height: file.data.height ?? 0,
        },
    };
}

// =============================================================================
// Export Adapters
// =============================================================================

export function exportFloorPlanToSvg(data: FloorPlanData): string {
    const width = Number.isFinite(data.width) && (data.width as number) > 0 ? (data.width as number) : 1000;
    const height = Number.isFinite(data.height) && (data.height as number) > 0 ? (data.height as number) : 1000;

    const wallLines = data.walls
        .map((wall) => {
            const strokeWidth = Math.max(1, wall.thickness);
            return `<line x1="${wall.start.x}" y1="${wall.start.y}" x2="${wall.end.x}" y2="${wall.end.y}" stroke="${wall.color ?? '#334155'}" stroke-width="${strokeWidth}" />`;
        })
        .join('\n');

    const roomPolygons = data.rooms
        .map((room) => {
            const points = room.vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' ');
            return `<polygon points="${points}" fill="rgba(14,165,233,0.08)" stroke="#0ea5e9" stroke-width="1" />`;
        })
        .join('\n');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
        roomPolygons,
        wallLines,
        '</svg>',
    ].join('\n');
}

export function exportFloorPlanToDxf(data: FloorPlanData): string {
    const entities: string[] = [];

    data.walls.forEach((wall) => {
        entities.push(
            '0', 'LINE',
            '8', wall.layer ?? 'WALLS',
            '10', wall.start.x.toString(),
            '20', wall.start.y.toString(),
            '30', '0',
            '11', wall.end.x.toString(),
            '21', wall.end.y.toString(),
            '31', '0'
        );
    });

    return [
        '0', 'SECTION',
        '2', 'HEADER',
        '0', 'ENDSEC',
        '0', 'SECTION',
        '2', 'ENTITIES',
        ...entities,
        '0', 'ENDSEC',
        '0', 'EOF',
    ].join('\n');
}

export interface PdfExportModel {
    title: string;
    width: number;
    height: number;
    walls: Array<{ x1: number; y1: number; x2: number; y2: number; thickness: number }>;
    rooms: Array<{ name: string; vertices: Array<{ x: number; y: number }> }>;
}

export function exportFloorPlanToPdfModel(data: FloorPlanData): PdfExportModel {
    return {
        title: 'Floor Plan',
        width: data.width ?? 1000,
        height: data.height ?? 1000,
        walls: data.walls.map((wall) => ({
            x1: wall.start.x,
            y1: wall.start.y,
            x2: wall.end.x,
            y2: wall.end.y,
            thickness: wall.thickness,
        })),
        rooms: data.rooms.map((room) => ({
            name: room.name,
            vertices: room.vertices.map((vertex) => ({ ...vertex })),
        })),
    };
}

// =============================================================================
// Import Adapters
// =============================================================================

export interface IndustryImportResult {
    data: FloorPlanData;
    warnings: string[];
}

export function importFloorPlanFromJson(json: string): IndustryImportResult {
    const parsed = parseFloorPlanFile(json);
    const migrated = migrateFloorPlanFile(parsed);
    return {
        data: migrated.data,
        warnings: [],
    };
}

export function importFloorPlanFromDxf(content: string): IndustryImportResult {
    const tokens = content.split(/\r?\n/).map((line) => line.trim());
    const walls: Wall2D[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < tokens.length - 1; i++) {
        const code = tokens[i];
        const value = tokens[i + 1];
        if (code !== '0' || value !== 'LINE') continue;

        let x1 = NaN;
        let y1 = NaN;
        let x2 = NaN;
        let y2 = NaN;
        let layer = 'WALLS';

        i += 2;
        for (; i < tokens.length - 1; i += 2) {
            const group = tokens[i];
            const groupValue = tokens[i + 1];
            if (group === '0') {
                i -= 2;
                break;
            }
            if (group === '8') layer = groupValue;
            if (group === '10') x1 = Number.parseFloat(groupValue);
            if (group === '20') y1 = Number.parseFloat(groupValue);
            if (group === '11') x2 = Number.parseFloat(groupValue);
            if (group === '21') y2 = Number.parseFloat(groupValue);
        }

        if ([x1, y1, x2, y2].every(Number.isFinite)) {
            walls.push(createImportedWall(x1, y1, x2, y2, layer));
        } else {
            warnings.push('Skipped malformed LINE entity in DXF.');
        }
    }

    return {
        data: {
            walls,
            rooms: [],
            scale: 1,
            width: 0,
            height: 0,
        },
        warnings,
    };
}

function createImportedWall(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    layer: string
): Wall2D {
    return {
        id: generateId(),
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: 1,
        height: 3,
        wallType: 'interior',
        layer,
        openings: [],
    };
}
