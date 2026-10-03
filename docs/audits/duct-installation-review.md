# Duct layout and installation review

Reviewed 3 October 2026 against the three supplied isometric screenshots and the duct implementation on `main`.

## Image findings and changes

| View | Finding | Correction |
| --- | --- | --- |
| Close view of the unit outlet and first branches | Preview transparency exposed complete joint frames and collars through the main duct, making continuous sheet metal look open. Hangers could coincide with a branch opening. | Duct and terminal previews now retain opaque surfaces and depth occlusion. Parent hanger locations exclude takeoff mouths and their clearance. |
| View of the curved runouts | Terminal spigot rims contained capped cylinders, and the main/plenum skins did not represent their planned takeoff openings. Curved flex received straight-duct friction only. | Open connection geometry follows the fabrication plan. Pressure estimates include the additional loss from the actual flex bends. |
| Overall view of the diffuser row | The rectangular boxes above the diffuser faces are plenums. Uniform main sizes and flanges alone do not establish a sizing error. Some valid branches can nevertheless take unnecessary detours to their initially selected spigot face. | Preserve the actual plenums, joints and airflow-based sizing. Compare feasible spigot faces using fabricated geometry rather than accepting the first valid face. |

The images alone cannot establish project airflow, supplier dimensions, structural anchor capacity, room ceiling levels, or a return-air design. They are not sufficient to certify an installation.

Connection cutouts cover level rectangular straight sections, distribution plenums and terminal necks. Round-main saddle intersections retain their simplified shell representation. An opening outside a valid panel remains uncut and subject to fabrication validation. Terminal hanging-wire anchor positions are not generated because the model does not define those attachments.

## Current installation basis

[ASHRAE Handbook 2024, chapter 19](https://handbook.ashrae.org/Handbooks/S24/IP/S24_Ch19/S24_Ch19_ip.aspx) gives horizontal flexible-duct support spacing of at most 4 ft and support width of at least 1.5 in. The implementation uses conservative metric values of **1200 mm spacing and 40 mm saddles**. The support plan, rendered straps, bill of materials and cost calculation share those values. Sag remains limited to 41.7 mm/m, and the existing minimum bend radius remains one inside diameter. A selected product's stricter instructions still govern.

The **1500 mm maximum flex runout** is a project design limit, distinct from support spacing. It is retained. Flex should be fully extended with minimal compression; the model does not predict the extra loss of an unknown field compression ratio.

Short takeoff/damper assemblies feeding flex may use the parent duct's support only when a feasible nearby hanger is present. Their metal mass and insulation allowance contribute to that hanger's load. Unsupported assemblies retain their warning, and impossible negative hanger lengths are no longer rendered.

Rendered flex straps use the runout's three-dimensional axis, including sloped and vertical spans. Their wire attachments remain outside the flex core. This geometry correction does not establish a separate vertical-installation specification.

[Thermaflex's Air Flow and Air Friction brochure](https://www.thermaflex.net/wp-content/uploads/2016/03/Thermaflex-Air-Flow-and-Air-Friction-Brochure.pdf) supplies measured 90-degree flex-bend coefficients for specified products and a 12-inch test diameter. The calculation interpolates that reference by radius/diameter and scales local absolute turn angles, so opposing turns do not cancel. It subtracts the bend friction already included in developed-length friction. Applying the reference to generic project flex and other angles is explicitly an **engineering estimate**, not a product rating.

Candidate routing and sizing use the same bend-loss calculation as final pressure verification whenever the runout geometry is known. Geometry-free synthetic inputs retain an explicit straight-flex fallback. Permitted spigot sides are compared using both installation cost and pressure when the optimizer prices a route.

The **Optimal** comparison now keeps rectangular and round routing restrictions and sizing searches separate. A rejection in one routing graph cannot remove an unrelated candidate from the other. Verified pure-shape options are retained before mixed sizing reuses the searched layouts. Searches share the existing time budget and report when it limits refinement; bend-loss pricing skips geometrically invalid candidates.

Branch-mounted balancing dampers remain. Trunk reductions remain governed by downstream airflow, pressure and the chosen sizing objective; a reduction after every takeoff is not imposed. This is consistent with the design approaches discussed in [ASHRAE Handbook 2025, chapter 21](https://handbook.ashrae.org/Handbooks/F25/IP/F25_Ch21/F25_Ch21_ip.aspx).

The existing sheet-metal gauge and rigid-hanger tables retain their disclosed SMACNA 1995 provenance. This review does not relabel those tables as a newer edition or claim blanket code compliance. Hanger rods terminate at the configured soffit; actual structural attachments require project data.

## Verification

Geometry regressions check connection openings, intact surrounding sheet metal, collar rims, support clearances and material ownership. Pressure regressions cover straight runs, measured-reference bends, opposing bends, elevation changes and double-counting. Routing regressions check terminal-side choices and complete terminal service.

Validation covered **410 passing active tests** across the combined duct/route/preview regression run and the focused rerun of the corrected reference-layout assertion. The combined selection skipped 39 opt-in benchmark cases. Drawing-engine and web TypeScript checks, ESLint on all changed TypeScript files, and `git diff --check` passed. The preserved optimizer cost comparison also passes with the original shared unit deadline.

Browser renders reconstruct a row of eight diffusers and a centrally connected rectangular main, using the production fabrication and rendering code. They compare baseline `46995d8` and the corrected implementation with identical cameras, lighting and dimensions. The unit uses its procedural placeholder without a catalog GLB. These are representative scenes, not the user's saved project. The corrected scene has zero fabrication errors, support warnings or browser exceptions.

| View | Original | Corrected |
| --- | --- | --- |
| Overall installation | [Before](duct-installation-before.png) | [After](duct-installation-after.png) |
| Branch connections and hangers | [Before](duct-connections-before.png) | [After](duct-connections-after.png) |
| Longer flex runout support | — | [Strap detail](duct-flex-support-after.png) |

The spigot-selection regression compares a two-diffuser layout with side changes enabled and disabled. Both routes have no fabrication errors; automatic side selection reduces each branch's developed length from 3.493 m to 1.133 m while retaining the bend-radius check. Side selection is bounded to three permitted alternatives and preserves fixed-side settings.

## Reviewing an existing drawing

Refresh the application to load the corrected renderer. To compare a newly optimized layout, enable **Rebuild existing ducts** in Auto route options, choose **Route again**, inspect the preview and pressure results, then choose **Apply**. The unit's Auto duct card offers the equivalent **Rebuild existing → Regenerate ducts → Apply** flow.
