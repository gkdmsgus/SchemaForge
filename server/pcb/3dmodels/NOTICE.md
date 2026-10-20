# Vendored KiCad 3D models

The `.step` files in this folder are unmodified copies from the official
KiCad 3D model library shipped with KiCad 10.0.6, copied by
`server/pcb/vendor_footprints.py`: only the models the vendored footprints
point at. The deploy image has no 3D model library of its own, so its
`Dockerfile` sets `KICAD10_3DMODEL_DIR` to this folder.

The KiCad libraries are licensed under CC-BY-SA 4.0 with an exception that
allows using them in electronic designs without the resulting designs falling
under the same license. See the license published by the KiCad library team
(https://www.kicad.org/libraries/license/).

Do not edit these files by hand; re-run `vendor_footprints.py` instead.
