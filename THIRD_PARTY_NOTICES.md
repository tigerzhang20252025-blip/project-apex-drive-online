# Third-party assets

The repository's MIT license applies to original Project Apex Drive source code. Third-party assets and dependencies retain their own licenses. Ferrari, F40, Nissan, GT-R and NISMO marks belong to their respective owners. Model copyright licenses do not grant trademark rights or imply endorsement.

| Asset | Source and license | Distribution |
| --- | --- | --- |
| Ferrari F40 base vehicle and interior | [Black Snow](https://sketchfab.com/3d-models/ferrari-f40-52a66c41cfcd4f999fb1b1c49bf24d70) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Downloaded separately. Modification and attribution details in [F40 credits](public/assets/F40-CREDITS.txt). |
| Nissan GT-R R35 base vehicle and interior | [Black Snow](https://sketchfab.com/3d-models/nissan-skyline-gtr-r35-7b142ea3376e4811a326256c59bbc7a2) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Downloaded separately. Modification and attribution details in [R35 credits](public/assets/R35-CREDITS.txt). |
| Driver hand meshes and skeletons | [Immersive Web WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/assets/profiles/generic-hand) · [MIT](public/assets/driver/LICENSE.txt) | Bundled with [credits](public/assets/driver/CREDITS.txt). |
| Landscape, HDR, plant models and textures | [Poly Haven CC0](https://polyhaven.com/license) · [Alps Field](https://polyhaven.com/a/alps_field), [Clean Asphalt](https://polyhaven.com/a/clean_asphalt), [Grass Ground](https://polyhaven.com/a/grass_ground), [Leafy Grass](https://polyhaven.com/a/leafy_grass), [Brown Mud](https://polyhaven.com/a/brown_mud), [Lichen Rock](https://polyhaven.com/a/lichen_rock), [Gravel Floor](https://polyhaven.com/a/gravel_floor), [Pine Sapling Small](https://polyhaven.com/a/pine_sapling_small), [Fir Tree 01](https://polyhaven.com/a/fir_tree_01) | Bundled. [Alpine credits](public/assets/ALPINE-CREDITS.txt) describe adaptations. |
| Vehicle audio | Original Web Audio synthesis | Reference recordings are listed in [audio credits](public/assets/AUDIO-CREDITS.txt) and are absent from the distribution. |
| Track geometry and sponsor art | Original project work, using fictional sponsor art and [documented environment textures](public/assets/ALPINE-CREDITS.txt) | Bundled. The UI uses system fonts. |
| Runtime and development libraries | Licenses provided by the packages in [package-lock.json](package-lock.json) | npm installs the dependencies. |

The screenshots show this simulator and contain depictions of the credited models. The two base car GLBs are kept outside Git. Run `npm run assets:fetch` to download them from this edition's public Worker and verify their SHA-256 hashes against [vehicle-assets.json](scripts/vehicle-assets.json). An existing local copy matching the manifest in `public/assets/` also works. A raw upstream model requires adaptation before the simulator can use it.
