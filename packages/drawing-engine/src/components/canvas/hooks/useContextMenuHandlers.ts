/**
 * Context Menu Handlers Hook
 *
 * Owns context menu state and provides action handlers for wall, dimension,
 * section-line, and object context menus.
 */

import { useState, useCallback, useEffect } from 'react';

import type { Dimension2D, Point2D, SectionLine, SymbolInstance2D } from '../../../types';
import { generateId } from '../../../utils/geometry';

import type {
    WallContextMenuState,
    DimensionContextMenuState,
    SectionLineContextMenuState,
    ObjectContextMenuState,
} from '../../DrawingCanvas.types';

export interface UseContextMenuHandlersOptions {
    selectedIds: string[];
    dimensions: Dimension2D[];
    symbols: SymbolInstance2D[];
    sectionLines: SectionLine[];
    objectDefinitionsById: Map<string, { category?: string; widthMm?: number; depthMm?: number }>;
    // Store actions
    setSelectedIds: (ids: string[]) => void;
    setProcessingStatus: (message: string, isError: boolean) => void;
    getWall: (id: string) => { id: string; startPoint: Point2D; endPoint: Point2D; openings: Array<{ id: string; type: string; position: number; width: number; height: number }> } | undefined;
    updateWall: (id: string, updates: Record<string, unknown>) => void;
    deleteWall: (id: string) => void;
    deleteDimension: (id: string) => void;
    updateDimension: (id: string, updates: Record<string, unknown>) => void;
    deleteSectionLine: (id: string) => void;
    updateSectionLine: (id: string, updates: Record<string, unknown>) => void;
    flipSectionLineDirection: (id: string) => void;
    generateElevationForSection: (id: string) => void;
    deleteSymbol: (id: string) => void;
    updateSymbol: (id: string, updates: Record<string, unknown>) => void;
}

export interface UseContextMenuHandlersResult {
    // State
    wallContextMenu: WallContextMenuState | null;
    dimensionContextMenu: DimensionContextMenuState | null;
    sectionLineContextMenu: SectionLineContextMenuState | null;
    objectContextMenu: ObjectContextMenuState | null;
    // Setters (for event binding to open menus)
    setWallContextMenu: (state: WallContextMenuState | null) => void;
    setDimensionContextMenu: (state: DimensionContextMenuState | null) => void;
    setSectionLineContextMenu: (state: SectionLineContextMenuState | null) => void;
    setObjectContextMenu: (state: ObjectContextMenuState | null) => void;
    // Close helpers
    closeWallContextMenu: () => void;
    closeDimensionContextMenu: () => void;
    closeSectionLineContextMenu: () => void;
    closeObjectContextMenu: () => void;
    closeAllContextMenus: () => void;
    // Action handlers
    handleEditWallProperties: () => void;
    handleDeleteWallFromContext: () => void;
    handleConvertWallToDoorOpening: () => void;
    handleEditDimensionProperties: () => void;
    handleDeleteDimensionFromContext: () => void;
    handleToggleDimensionVisibility: () => void;
    handleFlipSectionLineDirection: () => void;
    handleToggleSectionLineLock: () => void;
    handleGenerateElevationFromSection: () => void;
    handleDeleteSectionLineFromContext: () => void;
    handleEditObjectProperties: () => void;
    handleDeleteObjectFromContext: () => void;
    handleFlipDoorSwing: () => void;
}

export function useContextMenuHandlers(options: UseContextMenuHandlersOptions): UseContextMenuHandlersResult {
    const {
        selectedIds,
        dimensions,
        symbols,
        sectionLines,
        setSelectedIds,
        setProcessingStatus,
        getWall,
        updateWall,
        deleteWall: deleteWallAction,
        deleteDimension: deleteDimensionAction,
        updateDimension: updateDimensionAction,
        deleteSectionLine: deleteSectionLineAction,
        updateSectionLine: updateSectionLineAction,
        flipSectionLineDirection: flipSectionLineDirectionAction,
        generateElevationForSection: generateElevationAction,
        deleteSymbol: deleteSymbolAction,
        updateSymbol: updateSymbolAction,
    } = options;

    // State
    const [wallContextMenu, setWallContextMenu] = useState<WallContextMenuState | null>(null);
    const [dimensionContextMenu, setDimensionContextMenu] = useState<DimensionContextMenuState | null>(null);
    const [sectionLineContextMenu, setSectionLineContextMenu] = useState<SectionLineContextMenuState | null>(null);
    const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | null>(null);

    // Close helpers
    const closeWallContextMenu = useCallback(() => setWallContextMenu(null), []);
    const closeDimensionContextMenu = useCallback(() => setDimensionContextMenu(null), []);
    const closeSectionLineContextMenu = useCallback(() => setSectionLineContextMenu(null), []);
    const closeObjectContextMenu = useCallback(() => setObjectContextMenu(null), []);

    const closeAllContextMenus = useCallback(() => {
        setWallContextMenu(null);
        setDimensionContextMenu(null);
        setSectionLineContextMenu(null);
        setObjectContextMenu(null);
    }, []);

    // Wall handlers
    const handleEditWallProperties = useCallback(() => {
        if (!wallContextMenu) return;
        setSelectedIds([wallContextMenu.wallId]);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('smart-drawing:open-properties-panel'));
        }
        closeWallContextMenu();
    }, [wallContextMenu, setSelectedIds, closeWallContextMenu]);

    const handleDeleteWallFromContext = useCallback(() => {
        if (!wallContextMenu) return;
        deleteWallAction(wallContextMenu.wallId);
        setSelectedIds(selectedIds.filter((id) => id !== wallContextMenu.wallId));
        closeWallContextMenu();
    }, [wallContextMenu, deleteWallAction, selectedIds, setSelectedIds, closeWallContextMenu]);

    const handleConvertWallToDoorOpening = useCallback(() => {
        if (!wallContextMenu) return;

        const wall = getWall(wallContextMenu.wallId);
        if (!wall) {
            closeWallContextMenu();
            return;
        }

        const length = Math.hypot(
            wall.endPoint.x - wall.startPoint.x,
            wall.endPoint.y - wall.startPoint.y
        );

        updateWall(wall.id, {
            openings: [
                ...wall.openings,
                {
                    id: generateId(),
                    type: 'door',
                    position: length / 2,
                    width: 900,
                    height: 2100,
                },
            ],
        });

        closeWallContextMenu();
    }, [wallContextMenu, getWall, updateWall, closeWallContextMenu]);

    // Dimension handlers
    const handleEditDimensionProperties = useCallback(() => {
        if (!dimensionContextMenu) return;
        setSelectedIds([dimensionContextMenu.dimensionId]);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('smart-drawing:open-properties-panel'));
        }
        closeDimensionContextMenu();
    }, [dimensionContextMenu, setSelectedIds, closeDimensionContextMenu]);

    const handleDeleteDimensionFromContext = useCallback(() => {
        if (!dimensionContextMenu) return;
        deleteDimensionAction(dimensionContextMenu.dimensionId);
        setSelectedIds(selectedIds.filter((id) => id !== dimensionContextMenu.dimensionId));
        closeDimensionContextMenu();
    }, [dimensionContextMenu, deleteDimensionAction, selectedIds, setSelectedIds, closeDimensionContextMenu]);

    const handleToggleDimensionVisibility = useCallback(() => {
        if (!dimensionContextMenu) return;
        const dimension = dimensions.find((entry) => entry.id === dimensionContextMenu.dimensionId);
        if (!dimension) {
            closeDimensionContextMenu();
            return;
        }
        updateDimensionAction(dimension.id, { visible: !dimension.visible });
        closeDimensionContextMenu();
    }, [dimensionContextMenu, dimensions, updateDimensionAction, closeDimensionContextMenu]);

    // Section line handlers
    const handleFlipSectionLineDirection = useCallback(() => {
        if (!sectionLineContextMenu) return;
        flipSectionLineDirectionAction(sectionLineContextMenu.sectionLineId);
        closeSectionLineContextMenu();
    }, [sectionLineContextMenu, flipSectionLineDirectionAction, closeSectionLineContextMenu]);

    const handleToggleSectionLineLock = useCallback(() => {
        if (!sectionLineContextMenu) return;
        const line = sectionLines.find((entry) => entry.id === sectionLineContextMenu.sectionLineId);
        if (!line) {
            closeSectionLineContextMenu();
            return;
        }
        updateSectionLineAction(line.id, { locked: !line.locked });
        closeSectionLineContextMenu();
    }, [sectionLineContextMenu, sectionLines, updateSectionLineAction, closeSectionLineContextMenu]);

    const handleGenerateElevationFromSection = useCallback(() => {
        if (!sectionLineContextMenu) return;
        generateElevationAction(sectionLineContextMenu.sectionLineId);
        closeSectionLineContextMenu();
    }, [sectionLineContextMenu, generateElevationAction, closeSectionLineContextMenu]);

    const handleDeleteSectionLineFromContext = useCallback(() => {
        if (!sectionLineContextMenu) return;
        deleteSectionLineAction(sectionLineContextMenu.sectionLineId);
        setSelectedIds(selectedIds.filter((id) => id !== sectionLineContextMenu.sectionLineId));
        closeSectionLineContextMenu();
    }, [sectionLineContextMenu, deleteSectionLineAction, selectedIds, setSelectedIds, closeSectionLineContextMenu]);

    // Object handlers
    const handleEditObjectProperties = useCallback(() => {
        if (!objectContextMenu) return;
        setSelectedIds([objectContextMenu.objectId]);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('smart-drawing:open-properties-panel'));
        }
        closeObjectContextMenu();
    }, [objectContextMenu, setSelectedIds, closeObjectContextMenu]);

    const handleDeleteObjectFromContext = useCallback(() => {
        if (!objectContextMenu) return;
        deleteSymbolAction(objectContextMenu.objectId);
        setSelectedIds(selectedIds.filter((id) => id !== objectContextMenu.objectId));
        closeObjectContextMenu();
    }, [objectContextMenu, deleteSymbolAction, selectedIds, setSelectedIds, closeObjectContextMenu]);

    const handleFlipDoorSwing = useCallback(() => {
        if (!objectContextMenu) return;
        const instance = symbols.find((entry) => entry.id === objectContextMenu.objectId);
        if (!instance) {
            closeObjectContextMenu();
            return;
        }
        const current = instance.properties?.swingDirection;
        const next = current === 'right' ? 'left' : 'right';
        updateSymbolAction(instance.id, {
            properties: {
                ...instance.properties,
                doorHingeMode: 'manual',
                swingDirection: next,
            },
        });
        setProcessingStatus(`Door swing set to ${next}.`, false);
        closeObjectContextMenu();
    }, [objectContextMenu, symbols, updateSymbolAction, setProcessingStatus, closeObjectContextMenu]);

    // Global close effect
    useEffect(() => {
        if (!wallContextMenu && !dimensionContextMenu && !sectionLineContextMenu && !objectContextMenu) return;

        const handleGlobalPointerDown = () => {
            closeAllContextMenus();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeAllContextMenus();
            }
        };

        window.addEventListener('pointerdown', handleGlobalPointerDown);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('scroll', handleGlobalPointerDown, true);

        return () => {
            window.removeEventListener('pointerdown', handleGlobalPointerDown);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('scroll', handleGlobalPointerDown, true);
        };
    }, [
        wallContextMenu,
        dimensionContextMenu,
        sectionLineContextMenu,
        objectContextMenu,
        closeAllContextMenus,
    ]);

    return {
        wallContextMenu,
        dimensionContextMenu,
        sectionLineContextMenu,
        objectContextMenu,
        setWallContextMenu,
        setDimensionContextMenu,
        setSectionLineContextMenu,
        setObjectContextMenu,
        closeWallContextMenu,
        closeDimensionContextMenu,
        closeSectionLineContextMenu,
        closeObjectContextMenu,
        closeAllContextMenus,
        handleEditWallProperties,
        handleDeleteWallFromContext,
        handleConvertWallToDoorOpening,
        handleEditDimensionProperties,
        handleDeleteDimensionFromContext,
        handleToggleDimensionVisibility,
        handleFlipSectionLineDirection,
        handleToggleSectionLineLock,
        handleGenerateElevationFromSection,
        handleDeleteSectionLineFromContext,
        handleEditObjectProperties,
        handleDeleteObjectFromContext,
        handleFlipDoorSwing,
    };
}
