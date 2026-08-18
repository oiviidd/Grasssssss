# Unused original assets

These ship with the original site but are not loaded by this study. Kept for reference.

| file | why it is not used |
|---|---|
| `terrain.buf` | the original river terrain — replaced by our hill |
| `grass_placement.buf` | 48 768 baked blade placements; they follow the old terrain and leave a bald river channel through the middle of the stage. Only its packed header is still used, for the blade scale range. |
| `flower_placement.buf` | 128 baked flower placements along the river bank; regenerated on our hill. Only its packed header is still used, for the flower scale range. |
| `float_plants.buf`, `water_plants.buf` | plants that float on / sit in the river |
| `grass.jpg` | baked grass albedo with the river stained into it. The palette in `TerrainMaps.js` was measured from this file. |
| `terrain_ao.jpg`, `terrain_info_1.png`, `terrain_info_2.png` | AO and rock masks painted for the original terrain; regenerated from slope for ours |
