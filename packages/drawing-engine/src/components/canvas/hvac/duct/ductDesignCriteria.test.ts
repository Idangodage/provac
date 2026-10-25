import { describe, expect, it } from 'vitest';

import {
  RECOMMENDED_DESIGN_CRITERIA, criteriaStillApply, designCriteriaLimits, designCriteriaSettings, readDesignCriteria, readUnitCriteria, suggestDesignRoom,
  unitDuctSettings,
} from './ductDesignCriteria';
import { DEFAULT_DUCT_SETTINGS, resolveDuctSettings } from './ductSettings';
import { defaultSizingBasis, frictionAtVelocity, initialSizingBasis } from './ductSystemSizing';

describe('design criteria (ASHRAE HVAC Applications 2023, ch. 49)', () => {
  it('reads Table 8 and Table 9 at a listed RC: a ward (RC 35), its main above a suspended ceiling', () => {
    const limits = designCriteriaLimits({ room: 'ward', location: 'suspended' });
    expect(limits.rc).toBe(35);
    expect(limits.mainMs).toBe(8.9); // 1750 fpm
    expect(limits.branchMs).toBe(7.1); // 80 %
    expect(limits.runoutMs).toBe(4.4); // 50 %
    expect(limits.neckSupplyMs).toBe(2.5); // 500 fpm
    expect(limits.neckReturnMs).toBe(3); // 600 fpm
    expect(limits.interpolated).toBe(false);
    expect(limits.capped).toBe(false);
  });

  it('interpolates RC 40 between Table 8\'s rows: the recommended open-plan office', () => {
    const limits = designCriteriaLimits(RECOMMENDED_DESIGN_CRITERIA);
    expect(limits.rc).toBe(40);
    expect(limits.mainMs).toBe(10.8); // (1750 + 2500) / 2 fpm
    expect(limits.branchMs).toBe(8.6);
    expect(limits.runoutMs).toBe(5.4);
    expect(limits.neckSupplyMs).toBe(2.8); // 560 fpm (Table 9 lists RC 40)
    expect(limits.neckReturnMs).toBe(3.4); // 675 fpm
    expect(limits.interpolated).toBe(true);
  });

  it('is quieter in the room and caps a shaft main at the low-pressure range', () => {
    const quiet = designCriteriaLimits({ room: 'teleconference', location: 'occupied' });
    expect([quiet.rc, quiet.mainMs, quiet.branchMs, quiet.runoutMs, quiet.neckSupplyMs, quiet.neckReturnMs]).toEqual([25, 4.8, 3.9, 2.4, 1.8, 2.2]);
    const loud = designCriteriaLimits({ room: 'laboratory', location: 'shaft' });
    expect([loud.mainMs, loud.branchMs, loud.runoutMs]).toEqual([12, 10, 8]); // 3500 fpm = 17.8 m/s, capped
    expect(loud.capped).toBe(true);
  });

  it('writes the settings it gives, and reads them back from a saved document', () => {
    const patch = designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA);
    expect(patch).toEqual({
      designCriteria: { room: 'open-office', location: 'suspended' },
      autoFrictionSupplyPaPerM: 0.8, autoFrictionReturnPaPerM: 0.6,
      autoMaxVelocityTrunkMs: 10.8, autoMaxVelocityBranchMs: 8.6, autoMaxVelocityRunoutMs: 5.4,
      autoMaxNeckVelocitySupplyMs: 2.8, autoMaxNeckVelocityReturnMs: 3.4,
    });
    const settings = resolveDuctSettings(patch);
    expect(settings.designCriteria).toEqual(RECOMMENDED_DESIGN_CRITERIA);
    expect(settings.autoMaxVelocityTrunkMs).toBe(10.8);
    expect(criteriaStillApply(settings)).toBe(true);
    expect(criteriaStillApply({ ...settings, autoMaxVelocityBranchMs: 6 })).toBe(false);
    expect(resolveDuctSettings({}).designCriteria).toBeNull();
    expect(resolveDuctSettings({ designCriteria: { room: 'nowhere', location: 'suspended' } } as never).designCriteria).toBeNull();
    expect(readDesignCriteria({ room: 'classroom', location: 'occupied' })).toEqual({ room: 'classroom', location: 'occupied' });
    expect(readDesignCriteria('open-office')).toBeNull();
  });

  it('starts a new design at one friction rate the main keeps within its limit', () => {
    // Recommended criteria: a 28 kW unit's 4320 m³/h runs at 6.25 m/s at 0.80 Pa/m, inside 10.8 m/s: 0.80 stays.
    const recommended = resolveDuctSettings(designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA));
    expect(initialSizingBasis(recommended, 'supply', 4320).frictionPaPerM).toBe(0.8);
    // A main in the room at RC 25 (4.8 m/s): the rate drops to where the main runs at its limit, not above it.
    const quiet = resolveDuctSettings(designCriteriaSettings({ room: 'teleconference', location: 'occupied' }));
    const basis = initialSizingBasis(quiet, 'supply', 4320);
    expect(basis.frictionPaPerM).toBe(Math.floor(frictionAtVelocity(4320, 4.8) * 100) / 100);
    expect(basis.frictionPaPerM).toBeLessThan(0.8);
    expect(basis.mainVelocityMs).toBeLessThanOrEqual(4.8);
    expect(basis.drive).toBe('friction');
    // Without criteria the settings are the designer's own: the default basis, unchanged.
    expect(initialSizingBasis(DEFAULT_DUCT_SETTINGS, 'supply', 4320)).toEqual(defaultSizingBasis(DEFAULT_DUCT_SETTINGS, 'supply', 4320));
    expect(initialSizingBasis(quiet, 'supply', null)).toEqual(defaultSizingBasis(quiet, 'supply', null));
  });
});

describe("a unit's own criteria", () => {
  const project = resolveDuctSettings(designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA));
  const unit = (criteria?: unknown) => ({ properties: criteria === undefined ? {} : { designCriteria: criteria } });

  it("designs a unit by its own criteria, else by the project's settings themselves", () => {
    expect(unitDuctSettings(project, unit())).toBe(project);
    expect(unitDuctSettings(project, null)).toBe(project);
    expect(unitDuctSettings(project, unit({ room: 'nonsense', location: 'suspended' }))).toBe(project);
    const office = unitDuctSettings(project, unit({ room: 'private-office', location: 'suspended' }));
    const limits = designCriteriaLimits({ room: 'private-office', location: 'suspended' });
    expect(office.autoMaxVelocityTrunkMs).toBe(limits.mainMs);
    expect(office.autoMaxNeckVelocitySupplyMs).toBe(limits.neckSupplyMs);
    expect(office.designCriteria).toEqual({ room: 'private-office', location: 'suspended' });
    // Everything else is the project's; the project's own settings are untouched.
    expect(office.rectStepMm).toBe(project.rectStepMm);
    expect(project.autoMaxVelocityTrunkMs).toBe(10.8);
    // The same object for the same criteria (caches keyed by the settings stay warm).
    expect(unitDuctSettings(project, unit({ room: 'private-office', location: 'suspended' }))).toBe(office);
    expect(readUnitCriteria(unit({ room: 'ward', location: 'shaft' }))).toEqual({ room: 'ward', location: 'shaft' });
  });

  it("suggests a room's criteria from its name, else from its type", () => {
    const cases: Array<[string, string, string | null]> = [
      ['Meeting Room 2', 'Open Space', 'conference'],
      ['Board room', 'Custom', 'conference'],
      ['Open Space 2', 'Open Space', 'open-office'],
      ['Manager office', 'Custom', 'private-office'],
      ['Lecture hall', 'Custom', 'lecture'],
      ['Reception', 'Custom', 'corridor'],
      ['Corridor 10:42', 'Corridor', 'corridor'],
      ['Passage 10:43', 'Passage', 'corridor'],
      ['Bedroom 2', 'Bedroom', 'residence'],
      ['Room 4', 'Living Room', 'residence'],
      ['Bathroom/Closet 09:12', 'Bathroom/Closet', null],
      ['Balcony', 'Balcony', null],
      ['Room 7', 'Custom', null],
    ];
    for (const [name, roomType, expected] of cases) {
      expect(suggestDesignRoom({ name, roomType: roomType as never }), name).toBe(expected);
    }
    expect(suggestDesignRoom(null)).toBeNull();
  });
});
