/**
 * The terminals the Auto route panel proposes for a unit short of them, shown
 * on the drawing (plan and 3D) until they are added or the proposal is put
 * away (null: none shown).
 */
import { create } from 'zustand';

import type { TerminalProposal } from './ductUnitAdvice';

export const useTerminalProposalStore = create<{
  proposal: TerminalProposal | null;
  setProposal: (proposal: TerminalProposal | null) => void;
}>((set) => ({
  proposal: null,
  setProposal: (proposal) => set({ proposal }),
}));
