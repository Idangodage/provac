/**
 * Internal types for the professional module.
 *
 * These types are used internally within the professional/ module for
 * floor plan processing and file format handling.
 */

export interface WallOpening {
    id: string;
    wallId: string;
    width: number;
    height: number;
    sillHeight: number;
    position: number;
    type: string;
}

export interface WallLayer {
    id: string;
    [key: string]: unknown;
}

export interface Wall2D {
    id: string;
    start: { x: number; y: number };
    end: { x: number; y: number };
    thickness: number;
    openings: WallOpening[];
    connectedWallIds?: string[];
    wallLayers?: WallLayer[];
    color?: string;
    layer?: string;
    [key: string]: unknown;
}

export interface Room2D {
    id: string;
    vertices: Array<{ x: number; y: number }>;
    name: string;
    area: number;
    grossArea: number;
    netArea: number;
    parentRoomId?: string | null;
    spaceType?: string;
    [key: string]: unknown;
}

export interface FloorPlanData {
    walls: Wall2D[];
    rooms: Room2D[];
    width?: number;
    height?: number;
    [key: string]: unknown;
}
