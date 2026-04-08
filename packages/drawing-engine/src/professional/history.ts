/**
 * Professional undo/redo system using command + memento patterns.
 */

// =============================================================================
// Command Types
// =============================================================================

export interface CommandContext {
    [key: string]: unknown;
}

export interface EditorCommand<TContext extends CommandContext = CommandContext> {
    id: string;
    label: string;
    execute: (context: TContext) => void | Promise<void>;
    undo: (context: TContext) => void | Promise<void>;
    redo?: (context: TContext) => void | Promise<void>;
    canMergeWith?: (other: EditorCommand<TContext>) => boolean;
    merge?: (other: EditorCommand<TContext>) => EditorCommand<TContext>;
}

export interface HistoryEntry<TContext extends CommandContext = CommandContext> {
    command: EditorCommand<TContext>;
    timestamp: number;
}

export interface HistoryOptions {
    maxEntries?: number;
}

// =============================================================================
// Memento Types
// =============================================================================

export interface MementoAdapter<TState> {
    capture: () => TState;
    restore: (snapshot: TState) => void;
}

export class SnapshotCommand<TContext extends CommandContext, TState> implements EditorCommand<TContext> {
    public readonly id: string;
    public readonly label: string;

    private before: TState | null = null;
    private after: TState | null = null;
    private readonly adapter: MementoAdapter<TState>;
    private readonly mutate: (context: TContext) => void;

    constructor(params: {
        id: string;
        label: string;
        adapter: MementoAdapter<TState>;
        mutate: (context: TContext) => void;
    }) {
        this.id = params.id;
        this.label = params.label;
        this.adapter = params.adapter;
        this.mutate = params.mutate;
    }

    execute(context: TContext): void {
        this.before = deepClone(this.adapter.capture());
        this.mutate(context);
        this.after = deepClone(this.adapter.capture());
    }

    undo(_context: TContext): void {
        if (!this.before) return;
        this.adapter.restore(deepClone(this.before));
    }

    redo(_context: TContext): void {
        if (!this.after) return;
        this.adapter.restore(deepClone(this.after));
    }
}

// =============================================================================
// History Manager
// =============================================================================

export class CommandHistoryManager<TContext extends CommandContext = CommandContext> {
    private readonly maxEntries: number;
    private readonly undoStack: HistoryEntry<TContext>[] = [];
    private readonly redoStack: HistoryEntry<TContext>[] = [];

    constructor(options: HistoryOptions = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? 200);
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    get size(): number {
        return this.undoStack.length;
    }

    get entries(): ReadonlyArray<HistoryEntry<TContext>> {
        return this.undoStack;
    }

    async execute(command: EditorCommand<TContext>, context: TContext): Promise<void> {
        const last = this.undoStack[this.undoStack.length - 1];
        if (last && last.command.canMergeWith?.(command) && last.command.merge) {
            const merged = last.command.merge(command);
            await maybeAsync(merged.execute(context));
            this.undoStack[this.undoStack.length - 1] = {
                command: merged,
                timestamp: Date.now(),
            };
            this.redoStack.length = 0;
            return;
        }

        await maybeAsync(command.execute(context));
        this.undoStack.push({
            command,
            timestamp: Date.now(),
        });
        if (this.undoStack.length > this.maxEntries) {
            this.undoStack.splice(0, this.undoStack.length - this.maxEntries);
        }
        this.redoStack.length = 0;
    }

    async undo(context: TContext): Promise<void> {
        const entry = this.undoStack.pop();
        if (!entry) return;
        await maybeAsync(entry.command.undo(context));
        this.redoStack.push(entry);
    }

    async redo(context: TContext): Promise<void> {
        const entry = this.redoStack.pop();
        if (!entry) return;
        if (entry.command.redo) {
            await maybeAsync(entry.command.redo(context));
        } else {
            await maybeAsync(entry.command.execute(context));
        }
        this.undoStack.push(entry);
    }

    clear(): void {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
    }
}

// =============================================================================
// Helpers
// =============================================================================

function deepClone<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

async function maybeAsync(value: void | Promise<void>): Promise<void> {
    await value;
}
